import Bull from 'bull'
import express from 'express'
import kill from 'kill-port'

import { _logger, db, fp } from '@nftcom/shared'

import { dbConfig } from './config'
import { nftCronSubqueue,QUEUE_TYPES, queues, startAndListen, stopAndDisconnect } from './jobs/jobs'
import { authMiddleWare } from './middleware/auth'
//import { startAndListen } from './jobs/jobs'
import { startProvider, stopProvider } from './on-chain'
import { client } from './opensea'
import { initiateStreaming } from './pipeline'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)
const chainId: string = process.env.CHAIN_ID || '5'
logger.log(`Chain Id for environment: ${chainId}`)
const app = express()

// health check
app.get('/health', async (_req, res) => {
  const healthcheck = {
    uptime: process.uptime(),
    message: 'OK',
    timestamp: Date.now(),
  }
  try {
    res.send(healthcheck)
  } catch (error) {
    healthcheck.message = error
    res.status(503).send()
  }
})

// sync external orders - authenticated
app.get('/syncOS', authMiddleWare, async (_req, res) => {
  try {
    queues.get(QUEUE_TYPES.SYNC_CONTRACTS)
      .add({
        SYNC_CONTRACTS: QUEUE_TYPES.SYNC_CONTRACTS,
        chainId: process.env.CHAIN_ID,
      }, {
        removeOnComplete: true,
        removeOnFail: true,
        jobId: 'fetch_os_orders',
      })
    res.status(200).send({ message: 'Stated Sync!' })
  } catch (error) {
    console.log('err', error)
    res.status(400).send(error)
  }
})

// sync external orders - authenticated
app.get('/syncLR', authMiddleWare, async (_req, res) => {
  try {
    queues.get(QUEUE_TYPES.SYNC_CONTRACTS)
      .add({
        SYNC_CONTRACTS: QUEUE_TYPES.SYNC_CONTRACTS,
        chainId: process.env.CHAIN_ID,
      }, {
        removeOnComplete: true,
        removeOnFail: true,
        jobId: 'fetch_lr_orders',
      })
    res.status(200).send({ message: 'Stated Sync!' })
  } catch (error) {
    console.log('err', error)
    res.status(400).send(error)
  }
})

// force stop external orders sync - authenticated
app.get('/stopSync', authMiddleWare, async (_req, res) => {
  try {
    const existingSubQueueJobs: Bull.Job[] = await nftCronSubqueue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
    // clear existing sub queue jobs
    if (existingSubQueueJobs.flat().length) {
      nftCronSubqueue.obliterate({ force: true })
    }

    const existingQueueJobs: Bull.Job[] = await queues.get(QUEUE_TYPES.SYNC_CONTRACTS).getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
    // clear existing queue jobs
    if (existingQueueJobs.flat().length) {
      queues.get(QUEUE_TYPES.SYNC_CONTRACTS).obliterate({ force: true })
    }

    res.status(200).send({ message: 'Sync Stopped!' })
  } catch (error) {
    console.log('err', error)
    res.status(400).send(error)
  }
})

// error handler
const handleError = (err: Error): void => {
  logger.error(`App Error: ${err}`)
  throw err
}

// initialize
export const verifyConfiguration = (): void => {
  logger.debug('Loading configurations...')
}

let server
const PORT = process.env.PORT || 8080
const startServer = async (): Promise<void> => {
  server = await app.listen(PORT)
  logger.info(`Server ready at http://localhost:${PORT}`)
}

const stopServer = async (): Promise<void> => {
  if (server) {
    await server.close()
  }
}

const bootstrap = (): Promise<void> => {
  verifyConfiguration()
  return db.connect(dbConfig)
    .then(startAndListen)
    .then(startServer)
    .then(client.connect)
    .then(initiateStreaming)
    .then(() => startProvider(chainId))
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
    .then(stopAndDisconnect)
    .then(client.disconnect)
    .then(stopProvider)
    .then(fp.pause(500))
    .finally(() => {
      logExit()
      process.exit()
    })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

bootstrap().catch(handleError)
