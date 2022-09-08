import express from 'express'
import kill from 'kill-port'
import { db, _logger, fp } from 'nftcom-backend/shared'
import { dbConfig } from './config'
//import { startAndListen } from './jobs/jobs'
import { onChainProvider } from './on-chain'
import { client } from './opensea'
import { initiateStreaming } from './pipeline'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)

const app = express()

// health check
app.get('/health', async (_req, res, _next) => {
    const healthcheck = {
        uptime: process.uptime(),
        message: 'OK',
        timestamp: Date.now()
    };
    try {
        res.send(healthcheck);
    } catch (error) {
        healthcheck.message = error;
        res.status(503).send();
    }
});
// error handler
const handleError = (err: Error): void => {
    logger.error('App Error', err)
    throw err
}

// initialize
export const verifyConfiguration = (): void => {
    logger.debug('Loading configurations...')
}

let server 
const PORT = process.env.PORT || 8080
const startServer = async (): Promise<void> => {
    server = await app.listen(PORT);
    logger.info(`Server ready at http://localhost:${PORT}`)
}

const stopServer = async (): Promise<void> => {
    if (server) {
        await server.close()
    }
}
startServer()
const bootstrap = (): Promise<void> => {
    verifyConfiguration()
    return db.connect(dbConfig)
     // .then(startServer)
      .then(onChainProvider)
      .then(client.connect)
      .then(initiateStreaming)
      //.then(startAndListen)
      .then(fp.pause(500))
}

const killPort = (): Promise<unknown> => {
    return kill(PORT)
      // Without this small delay sometimes it's not killed in time
      .then(fp.pause(500))
      .catch((err: any) => logger.error(err))
  }
  
  const logExit = (): void => {
    logger.info('Exited!')
  }
  
const gracefulShutdown = (): Promise<void> => {
    return stopServer()
      .then(killPort)
      .then(db.disconnect)
      // .then(job.stopAndDisconnect)
      .then(fp.pause(500))
      .finally(() => {
        logExit()
        process.exit()
      })
  }
  
process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

bootstrap().catch(handleError)