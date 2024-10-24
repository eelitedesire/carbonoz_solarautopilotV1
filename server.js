const express = require('express')
const bodyParser = require('body-parser')
const mqtt = require('mqtt')
const fs = require('fs')
const path = require('path')
const Influx = require('influx')
const ejs = require('ejs')
const moment = require('moment-timezone')
const WebSocket = require('ws')
const retry = require('async-retry')
const axios = require('axios')
const cookieParser = require('cookie-parser');
const { backOff } = require('exponential-backoff');
const CACHE_DURATION = 3600000; // 1 hour in milliseconds
const carbonIntensityCache = new Map();

const app = express()
const port = process.env.PORT || 6789
const socketPort = 7100
const { http } = require('follow-redirects')
const cors = require('cors')
const { connectDatabase, prisma } = require('./config/mongodb')
const { startOfDay } = require('date-fns')
const { AuthenticateUser } = require('./utils/mongoService')

// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// Add cookie parser middleware
app.use(cookieParser())

// Read configuration from Home Assistant add-on options
const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))

// Extract inverter and battery numbers from options
const inverterNumber = options.inverter_number || 1
const batteryNumber = options.battery_number || 1
// MQTT topic prefix
const mqttTopicPrefix = options.mqtt_topic_prefix || '${mqttTopicPrefix}'

// InfluxDB configuration
const influxConfig = {
  host: options.mqtt_host,
  port: 8086,
  database: 'home_assistant',
  username: 'admin',
  password: 'adminpassword',
  protocol: 'http',
  timeout: 10000,
}
const influx = new Influx.InfluxDB(influxConfig)

// MQTT configuration
const mqttConfig = {
  host: options.mqtt_host,
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
}

// Connect to MQTT broker
let mqttClient
let incomingMessages = []
const MAX_MESSAGES = 400

// Function to generate category options
function generateCategoryOptions(inverterNumber, batteryNumber) {
  const categories = ['all', 'loadPower', 'gridPower', 'pvPower', 'total']

  for (let i = 1; i <= inverterNumber; i++) {
    categories.push(`inverter${i}`)
  }

  for (let i = 1; i <= batteryNumber; i++) {
    categories.push(`battery${i}`)
  }

  return categories
}

const timezonePath = path.join(__dirname, 'timezone.json')

function getCurrentTimezone() {
  try {
    const data = fs.readFileSync(timezonePath, 'utf8')
    return JSON.parse(data).timezone
  } catch (error) {
    return 'Indian/Mauritius' // Default timezone
  }
}

function setCurrentTimezone(timezone) {
  fs.writeFileSync(timezonePath, JSON.stringify({ timezone }))
}

let currentTimezone = getCurrentTimezone()

function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
  })

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker')
    mqttClient.subscribe(`${mqttTopicPrefix}/#`)
  })

  mqttClient.on('message', (topic, message) => {
    const formattedMessage = `${topic}: ${message.toString()}`
    incomingMessages.push(formattedMessage)
    if (incomingMessages.length > MAX_MESSAGES) {
      incomingMessages.shift()
    }
    saveMessageToInfluxDB(topic, message)
  })

  mqttClient.on('error', (err) => {
    console.error('Error connecting to MQTT broker:', err.message)
    mqttClient = null
  })
}

// Save MQTT message to InfluxDB
async function saveMessageToInfluxDB(topic, message) {
  try {
      const parsedMessage = parseFloat(message.toString());

      if (isNaN(parsedMessage)) {
          return;
      }

      const timestamp = new Date().getTime();
      const dataPoint = {
          measurement: 'state',
          fields: { value: parsedMessage },
          tags: { topic: topic },
          timestamp: timestamp * 1000000,
      };

      await retry(async () => {
          await influx.writePoints([dataPoint]);
      }, {
          retries: 5,
          minTimeout: 1000
      });
  } catch (err) {
      console.error('Error saving message to InfluxDB:', err.response ? err.response.body : err.message);
  }
}

// Fetch analytics data from InfluxDB
async function queryInfluxDB(topic) {
  const query = `
      SELECT last("value") AS "value"
      FROM "state"
      WHERE "topic" = '${topic}'
      AND time >= now() - 30d
      GROUP BY time(1d) tz('${currentTimezone}')
  `
  try {
    return await influx.query(query)
  } catch (error) {
    console.error(
      `Error querying InfluxDB for topic ${topic}:`,
      error.toString()
    )
    throw error
  }
}

// Function to query InfluxDB for the last 12 months of data
async function queryInfluxDBForYear(topic) {
  const query = `
    SELECT last("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}'
    AND time >= now() - 365d
    GROUP BY time(1d) tz('${currentTimezone}')
  `;
  try {
    return await influx.query(query);
  } catch (error) {
    console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
    throw error;
  }
}

async function queryInfluxDBForDecade(topic) {
  const query = `
    SELECT last("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}'
    AND time >= now() - 3650d
    GROUP BY time(1d) tz('${currentTimezone}')
  `;
  try {
    return await influx.query(query);
  } catch (error) {
    console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
    throw error;
  }
}



// Route handlers
app.get('/messages', (req, res) => {
  res.render('messages', {
    ingress_path: process.env.INGRESS_PATH || '',
    categoryOptions: generateCategoryOptions(inverterNumber, batteryNumber),
  })
})

app.get('/api/messages', (req, res) => {
  const category = req.query.category
  const filteredMessages = filterMessagesByCategory(category)
  res.json(filteredMessages)
})

app.get('/chart', (req, res) => {
  res.render('chart', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, // Include mqtt_host here
  })
})

app.get('/analytics', async (req, res) => {
  try {
    const selectedZone = req.cookies[COOKIE_NAME] || null
    let carbonIntensityData = []

    if (selectedZone) {
      try {
        carbonIntensityData = await fetchCarbonIntensityHistory(selectedZone);
      } catch (carbonError) {
        console.error('Error fetching carbon intensity data:', carbonError);
        // Continue without carbon intensity data
      }
    }
    
    const [
      loadPowerData, 
      pvPowerData, 
      batteryStateOfChargeData, 
      batteryPowerData, 
      gridPowerData, 
      gridVoltageData,
      loadPowerYear,
      pvPowerYear,
      batteryStateOfChargeYear,
      batteryPowerYear,
      gridPowerYear,
      gridVoltageYear,
      loadPowerDecade,
      pvPowerDecade,
      batteryStateOfChargeDecade,
      batteryPowerDecade,
      gridPowerDecade,
      gridVoltageDecade
    ] = await Promise.all([
      queryInfluxDB(`${mqttTopicPrefix}/total/load_energy/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/pv_energy/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_in/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_out/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_in/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_out/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/load_energy/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/pv_energy/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/battery_energy_in/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/battery_energy_out/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/grid_energy_in/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/grid_energy_out/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/load_energy/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/pv_energy/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/battery_energy_in/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/battery_energy_out/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/grid_energy_in/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/grid_energy_out/state`)
    ]);

    const data = {
      loadPowerData,
      pvPowerData,
      batteryStateOfChargeData,
      batteryPowerData,
      gridPowerData,
      gridVoltageData,
      carbonIntensityData,
      selectedZone,
      loadPowerYear,
      pvPowerYear,
      batteryStateOfChargeYear,
      batteryPowerYear,
      gridPowerYear,
      gridVoltageYear,
      loadPowerDecade,
      pvPowerDecade,
      batteryStateOfChargeDecade,
      batteryPowerDecade,
      gridPowerDecade,
      gridVoltageDecade
    };

    res.render('analytics', {
      data,
      ingress_path: process.env.INGRESS_PATH || '',
    })
  } catch (error) {
    console.error('Error fetching analytics data:', error);
    res.status(500).json({ 
      error: 'Error fetching analytics data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
})


function checkInverterMessages(messages, expectedInverters) {
  const inverterPattern = new RegExp(`${mqttTopicPrefix}/inverter_(\\d+)/`);
  const foundInverters = new Set();
  
  messages.forEach(message => {
    const match = message.match(inverterPattern);
    if (match) {
      foundInverters.add(parseInt(match[1]));
    }
  });

  if (foundInverters.size !== expectedInverters) {
    return `Warning: Expected ${expectedInverters} inverter(s), but found messages from ${foundInverters.size} inverter(s).`;
  }
  return null;
}

function checkBatteryInformation(messages) {
  const batteryPattern = new RegExp(`${mqttTopicPrefix}/battery_\\d+/`);
  const hasBatteryInfo = messages.some(message => batteryPattern.test(message));
  
  if (!hasBatteryInfo) {
    return "Warning: No battery information found in recent messages.";
  }
  return null;
}

app.get('/', (req, res) => {
  const expectedInverters = parseInt(options.inverter_number) || 1;
  const inverterWarning = checkInverterMessages(incomingMessages, expectedInverters);
  const batteryWarning = checkBatteryInformation(incomingMessages);

  res.render('energy-dashboard', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host,
    inverterWarning,
    batteryWarning
  });
});



app.get('/api/timezone', (req, res) => {
  res.json({ timezone: currentTimezone })
})

app.post('/api/timezone', (req, res) => {
  const { timezone } = req.body
  if (moment.tz.zone(timezone)) {
    currentTimezone = timezone
    setCurrentTimezone(timezone)
    res.json({ success: true, timezone: currentTimezone })
  } else {
    res.status(400).json({ error: 'Invalid timezone' })
  }
});


// Function to filter messages by category
function filterMessagesByCategory(category) {
  if (category === 'all') {
    return incomingMessages
  }

  return incomingMessages.filter((message) => {
    const topic = message.split(':')[0]
    const topicParts = topic.split('/')

    if (category.startsWith('inverter')) {
      const inverterNum = category.match(/\d+$/)[0]
      return topicParts[1] === `inverter_${inverterNum}`
    }

    if (category.startsWith('battery')) {
      const batteryNum = category.match(/\d+$/)[0]
      return topicParts[1] === `battery_${batteryNum}`
    }

    const categoryKeywords = {
      loadPower: ['load_power'],
      gridPower: ['grid_power'],
      pvPower: ['pv_power'],
      total: ['total'],
    }

    return categoryKeywords[category]
      ? topicParts.some((part) => categoryKeywords[category].includes(part))
      : false
  })
}

//socket data
const getRealTimeData = async () => {
  const loadPowerData = await queryInfluxDB(
    `${mqttTopicPrefix}/total/load_energy/state`
  )
  const pvPowerData = await queryInfluxDB(
    `${mqttTopicPrefix}/total/pv_energy/state`
  )
  const batteryStateOfChargeData = await queryInfluxDB(
    `${mqttTopicPrefix}/total/battery_energy_in/state`
  )
  const batteryPowerData = await queryInfluxDB(
    `${mqttTopicPrefix}/total/battery_energy_out/state`
  )
  const gridPowerData = await queryInfluxDB(
    `${mqttTopicPrefix}/total/grid_energy_in/state`
  )
  const gridVoltageData = await queryInfluxDB(
    `${mqttTopicPrefix}/total/grid_energy_out/state`
  )

  const data = {
    load: calculateDailyDifferenceForSockets(loadPowerData),
    pv: calculateDailyDifferenceForSockets(pvPowerData),
    gridIn: calculateDailyDifferenceForSockets(gridPowerData),
    gridOut: calculateDailyDifferenceForSockets(gridVoltageData),
    batteryCharged: calculateDailyDifferenceForSockets(
      batteryStateOfChargeData
    ),
    batteryDischarged: calculateDailyDifferenceForSockets(batteryPowerData),
  }

  return data
}
//send  on connection

const server = app.listen(port, '0.0.0.0', async () => {
  console.log(`Server is running on http://0.0.0.0:${port}`)
  connectToMqtt()
  connectDatabase()
    .then(() => console.log('Database connected'))
    .catch((err) => console.log({ err }))
})

const wss = new WebSocket.Server({ server })

wss.on('connection', (ws) => {
  ;(async () => {
    const isUser = await AuthenticateUser(options)
    if (isUser) {
      console.log('Client connected')
      if (mqttClient) {
        mqttClient.on('message', (topic, message) => {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  topic,
                  message: message.toString(),
                  userId: isUser,
                })
              )
            }
          })
        })
      }
    }
  })()

  // mqttClient.on('message', async () => {
  //   const { load, pv, gridIn, gridOut, batteryCharged, batteryDischarged } =
  //     await getRealTimeData()
  //   const topics = await prisma.topic.findMany()
  //   const port = options.mqtt_host
  //   const date = new Date()
  //   const isForServer = true
  //   topics.forEach((t) => {
  //     wss.clients.forEach((client) => {
  //       if (client.readyState === WebSocket.OPEN) {
  //         topics.forEach((t) => {
  //           client.send(
  //             JSON.stringify({
  //               date,
  //               userId: t.userId,
  //               pv,
  //               load,
  //               gridIn,
  //               gridOut,
  //               batteryCharged,
  //               batteryDischarged,
  //               port,
  //               isForServer,
  //             })
  //           )
  //         })
  //       }
  //     })
  //   })
  // })
  ws.on('error', (error) => {
    console.error('WebSocket error:', error)
  })
  ws.on('close', () => console.log('Client disconnected'))
})

// carbon intensity
let currentApiKey = '';  // API key stored in memory

app.get('/settings', async (req, res) => {
  const zones = await getZones()
  const selectedZone = req.cookies[COOKIE_NAME] || ''
  res.render('settings', {
    zones,
    selectedZone,
    api_key: currentApiKey,
    ingress_path: process.env.INGRESS_PATH || '',
  })
})

app.post('/api/api-key', (req, res) => {
  const { api_key } = req.body;  // Get the submitted API key from the form

  if (api_key && typeof api_key === 'string') {
    currentApiKey = api_key;  // Update the API key in memory
    res.json({ success: true, api_key: currentApiKey });
  } else {
    res.status(400).json({ error: 'Invalid API Key' });
  }
});



// Route for displaying results
app.get('/results', async (req, res) => {
  let selectedZone = req.query.zone || req.cookies[COOKIE_NAME] || null;
  const zones = await getZones();

  // If a new zone is selected, update the cookie
  if (req.query.zone && req.query.zone !== req.cookies[COOKIE_NAME]) {
    res.cookie(COOKIE_NAME, req.query.zone, COOKIE_OPTIONS);
    selectedZone = req.query.zone;
  }

  try {
    let historyData = [], gridEnergyIn = [], pvEnergy = [], gridVoltage = [];
    let error = null;

    if (selectedZone) {
      try {
        [historyData, gridEnergyIn, pvEnergy, gridVoltage] = await Promise.all([
          fetchCarbonIntensityHistory(selectedZone),
          queryInfluxData(`${mqttTopicPrefix}/total/grid_energy_in/state`, '365d'),
          queryInfluxData(`${mqttTopicPrefix}/total/pv_energy/state`, '365d'),
          queryInfluxData(`${mqttTopicPrefix}/total/grid_voltage/state`, '365d')
        ]);
      } catch (e) {
        console.error('Error fetching data:', e);
        error = 'Error fetching data. Please try again later.';
      }
    }

    const emissionsData = calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage);

    const periods = {
      week: emissionsData.slice(-7),
      month: emissionsData.slice(-30),
      quarter: emissionsData.slice(-90),
      year: emissionsData
    };

    const todayData = emissionsData[emissionsData.length - 1] || {
      unavoidableEmissions: 0,
      avoidedEmissions: 0,
      selfSufficiencyScore: 0
    };

    res.render('results', {
      selectedZone,
      zones,
      periods,
      todayData,
      error,
      unavoidableEmissions: todayData.unavoidableEmissions,
      avoidedEmissions: todayData.avoidedEmissions,
      selfSufficiencyScore: todayData.selfSufficiencyScore,
      ingress_path: process.env.INGRESS_PATH || '',
    });
  } catch (error) {
    console.error('Error processing data:', error);
    res.render('results', {
      selectedZone,
      zones,
      ingress_path: process.env.INGRESS_PATH || '',
      error: 'Error processing data'
    });
  }
});

// Helper functions
const COOKIE_NAME = 'selectedZone';
const COOKIE_OPTIONS = {
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production'
};

async function getZones() {
  try {
    const response = await axios.get('https://api.electricitymap.org/v3/zones', { timeout: 10000 });
    const data = response.data;

    return Object.entries(data)
      .map(([key, value]) => ({
        code: key,
        zoneName: value.zoneName || key
      }))
      .sort((a, b) => a.zoneName.localeCompare(b.zoneName));
  } catch (error) {
    console.error('Error fetching zones data:', error);
    return [];
  }
}
app.get('/clear-zone', (req, res) => {
  res.clearCookie(COOKIE_NAME)
  res.redirect(`${process.env.INGRESS_PATH || ''}/results`)
})



async function queryInfluxData(topic, duration = '365d') {
  const query = `
    SELECT mean("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}'
    AND time >= now() - ${duration}
    GROUP BY time(1d) tz('${currentTimezone}')
  `;
  try {
    return await influx.query(query);
  } catch (error) {
    console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
    throw error;
  }
}

async function fetchCarbonIntensityHistory(selectedZone) {
  if (!selectedZone) return [];

  const cacheKey = `${selectedZone}-${moment().format('YYYY-MM-DD')}`;
  if (carbonIntensityCache.has(cacheKey)) {
    const cachedData = carbonIntensityCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_DURATION) {
      return cachedData.data;
    }
  }

  const historyData = [];
  const today = moment();
  const oneYearAgo = moment().subtract(1, 'year');
  const batchSize = 7;

  try {
    for (let m = moment(oneYearAgo); m.isBefore(today); m.add(batchSize, 'days')) {
      const batchPromises = [];
      for (let i = 0; i < batchSize && m.clone().add(i, 'days').isBefore(today); i++) {
        const date = m.clone().add(i, 'days').format('YYYY-MM-DD');
        batchPromises.push(
          backOff(() => fetchWithRetry(selectedZone, date), {
            numOfAttempts: 5,
            startingDelay: 1000,
            timeMultiple: 2,
            maxDelay: 30000,
          })
        );
      }

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach((result, index) => {
        if (result && result.history && result.history.length > 0) {
          historyData.push({
            date: m.clone().add(index, 'days').format('YYYY-MM-DD'),
            carbonIntensity: result.history[0].carbonIntensity
          });
        }
      });
    }

    carbonIntensityCache.set(cacheKey, {
      data: historyData,
      timestamp: Date.now()
    });

    return historyData;
  } catch (error) {
    console.error('Error in fetchCarbonIntensityHistory:', error);
    return []; // Return empty array on error
  }
}
async function fetchWithRetry(selectedZone, date) {
  try {
    const response = await axios.get(`https://api.electricitymap.org/v3/carbon-intensity/history?zone=${selectedZone}&datetime=${date}`, {
      headers: { 
        'Authorization': `Bearer ${currentApiKey}` // Correct template literal usage
      },
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 429) {
      // If rate limited, throw an error to trigger backoff
      throw new Error('Rate limited');
    }
    console.error(`Error fetching data for ${date}:`, error.message);
    return null;
  }
}


function calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage) {
  return historyData.map((dayData, index) => {
    const carbonIntensity = dayData.carbonIntensity;
    const currentGridVoltage = gridVoltage[index]?.value || 0;
    const isGridActive = Math.abs(currentGridVoltage) > 20;

    // Get current day's grid and PV energy
    let gridEnergy = gridEnergyIn[index]?.value || 0;
    let solarEnergy = pvEnergy[index]?.value || 0;

    // Compare with the previous day's data
    if (index > 0) { // Avoid comparison for the first entry
      const prevGridEnergy = gridEnergyIn[index - 1]?.value || 0;
      const prevPvEnergy = pvEnergy[index - 1]?.value || 0;

      // Calculate the difference in grid and solar energy from the previous day
      gridEnergy = Math.max(0, gridEnergy - prevGridEnergy);
      solarEnergy = Math.max(0, solarEnergy - prevPvEnergy);
    }

    // Calculate emissions and self-sufficiency
    let unavoidableEmissions = 0;
    let avoidedEmissions = 0;

    if (isGridActive) {
      unavoidableEmissions = (gridEnergy * carbonIntensity) / 1000;
      avoidedEmissions = (solarEnergy * carbonIntensity) / 1000;
    }

    const totalEnergy = gridEnergy + solarEnergy;
    const selfSufficiencyScore = totalEnergy > 0 ? (solarEnergy / totalEnergy) * 100 : 0;

    return {
      date: dayData.date,
      carbonIntensity: carbonIntensity,
      gridVoltage: currentGridVoltage,
      gridEnergy: gridEnergy,
      solarEnergy: solarEnergy,
      unavoidableEmissions: unavoidableEmissions,
      avoidedEmissions: avoidedEmissions,
      selfSufficiencyScore: selfSufficiencyScore
    };
  });
}



app.get('/api/grid-voltage', async (req, res) => {
  try {
    const result = await influx.query(`
      SELECT last("value") AS "value"
      FROM "state"
      WHERE "topic" = '${mqttTopicPrefix}/total/grid_voltage/state'
      LIMIT 1
    `);
    res.json({ voltage: result[0]?.value || 0 });
  } catch (error) {
    console.error('Error fetching grid voltage:', error);
    res.status(500).json({ error: 'Failed to fetch grid voltage' });
  }
});

app.get('/api/grid-voltage', async (req, res) => {
  try {
    const result = await influx.query(`
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${mqttTopicPrefix}/total/grid_voltage/state'
      `)
    res.json({ voltage: result[0]?.value || 0 })
  } catch (error) {
    console.error('Error fetching grid voltage:', error)
    res.status(500).json({ error: 'Failed to fetch grid voltage' })
  }
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

// 404 handler
app.use((req, res, next) => {
  res.status(404).send("Sorry, that route doesn't exist.")
})

module.exports = { app, server }
