import Bull from 'bull'
import express from 'express'
import kill from 'kill-port'

import { _logger, db, fp, helper } from '@nftcom/shared'

import { dbConfig } from './config'
import { nftOrderSubqueue,QUEUE_TYPES, queues, startAndListen, stopAndDisconnect } from './jobs/jobs'
import { authMiddleWare } from './middleware/auth'
import { initiateStreaming } from './pipeline'
import { cache, CacheKeys } from './service/cache'
//import { startAndListen } from './jobs/jobs'
import { startProvider, stopProvider } from './service/on-chain'
import { client } from './service/opensea'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)
const chainId: string = process.env.CHAIN_ID || '5'
logger.log(`Chain Id for environment: ${chainId}`)
const app = express()

app.use(express.json())

app.use(express.urlencoded({ extended: false }))

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
    logger.error(`err: ${error}`)
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
    logger.error(`err: ${error}`)
    res.status(400).send(error)
  }
})

// force stop external orders sync - authenticated
app.get('/stopSync', authMiddleWare, async (_req, res) => {
  try {
    const existingSubQueueJobs: Bull.Job[] = await nftOrderSubqueue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
    // clear existing sub queue jobs
    if (existingSubQueueJobs.flat().length) {
      nftOrderSubqueue.obliterate({ force: true })
    }

    const existingQueueJobs: Bull.Job[] = await queues.get(QUEUE_TYPES.SYNC_CONTRACTS).getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
    // clear existing queue jobs
    if (existingQueueJobs.flat().length) {
      queues.get(QUEUE_TYPES.SYNC_CONTRACTS).obliterate({ force: true })
    }

    res.status(200).send({ message: 'Sync Stopped!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    res.status(400).send(error)
  }
})

// sync collections
app.post('/collectionSync', authMiddleWare, async (_req, res) => {
  try {
    const { collections } = _req.body
    if (!collections || !collections.length || !(collections instanceof Array)) {
      res.status(400).send({ message: 'No collection to sync!' })
    }

    const validCollections: string[] = []
    const invalidCollections: string[] = []
    const recentlyRefreshed: string[] = []
    for (let i=0; i < collections.length; i++) {
      const collection: string = collections[i]
      const collecionSynced: number = await cache.sismember(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, collection)
      if (collecionSynced) {
        recentlyRefreshed.push(collection)
      }
      try {
        const checkSumedContract: string = helper.checkSum(collection)
        validCollections.push(checkSumedContract)
      } catch (err) {
        logger.error(`err: ${err}`)
        invalidCollections.push(collection)
      }
    }
    // sync collection + timestamp
    const jobId = `sync_collections:${Date.now()}`
    queues.get(QUEUE_TYPES.SYNC_COLLECTIONS)
      .add({
        SYNC_CONTRACTS: QUEUE_TYPES.SYNC_COLLECTIONS,
        collections: validCollections,
        chainId: process.env.CHAIN_ID,
      }, {
        removeOnComplete: true,
        removeOnFail: true,
        jobId,
      })
    
    // response msg
    let responseMsg = ''

    if (validCollections.length) {
      responseMsg += `Sync started for the following collections: ${validCollections.join(', ')}.`
    }

    if (invalidCollections.length) {
      responseMsg += `The following collections are invalid: ${invalidCollections.join(', ')}.`
    }

    if (recentlyRefreshed.length) {
      responseMsg += `The following collections are recently refreshed: ${recentlyRefreshed.join(', ')}.`
    }

    res.status(200).send({
      message: responseMsg,
    })
  } catch (error) {
    logger.error(`err: ${error}`)
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
