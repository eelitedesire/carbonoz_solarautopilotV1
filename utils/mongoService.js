const { prisma } = require('../config/mongodb')

const AuthenticateUser = async (options) => {
  const clientId = options.clientId
  const clientSecret = options.clientSecret

  const userCredentials = await prisma.userCredentials.findFirst({
    where: {
      AND: [{ clientId }, { clientSecret }],
    },
  })

  if (!userCredentials) {
    return null
  }

  return userCredentials.userId
}

module.exports = { AuthenticateUser }
