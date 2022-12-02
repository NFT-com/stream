import Bull from 'bull'
import express from 'express'
import kill from 'kill-port'
import multer from 'multer'

import { _logger, db, fp, helper } from '@nftcom/shared'

import { dbConfig } from './config'
import { nftOrderSubqueue, QUEUE_TYPES, queues, startAndListen, stopAndDisconnect } from './jobs/jobs'
import { authMiddleWare } from './middleware/auth'
import { collectionSyncSchema, SyncCollectionInput, validate } from './middleware/validate'
import { initiateStreaming } from './pipeline'
import { cache, CacheKeys } from './service/cache'
//import { startAndListen } from './jobs/jobs'
import { startProvider, stopProvider } from './service/on-chain'
import { client } from './service/opensea'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)
const chainId: string = process.env.CHAIN_ID || '5'
logger.log(`Chain Id for environment: ${chainId}`)

const upload = multer({ storage: multer.memoryStorage(),
  limit: {
    fields: 3,
  },
  fileFilter: (_req, file, cb) => {
    file.mimetype === 'text/csv' ? cb(null, true) : cb(new Error('Only csvs are allowed'), false)
  },
})
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
    res.status(200).send({ message: 'Started Sync!' })
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

// sync collections - 
app.post('/collectionSync', authMiddleWare, validate(collectionSyncSchema), async (_req, res) => {
  try {
    const { collections } = _req.body

    const validCollections: SyncCollectionInput[] = []
    const invalidCollections: SyncCollectionInput[] = []
    const recentlyRefreshed: SyncCollectionInput[] = []
    for (let i = 0; i < collections.length; i++) {
      const collection: SyncCollectionInput = collections[i]
      const collecionSynced: number = await cache.sismember(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, helper.checkSum(collection.address) + (collections[i]?.startToken || ''))
      if (collecionSynced) {
        recentlyRefreshed.push(collection)
      } else {
        try {
          const checkSumedContract: string = helper.checkSum(collection.address)
          validCollections.push({
            address: checkSumedContract,
            startToken: collections[i]?.startToken,
          })
        } catch (err) {
          logger.error(`err: ${err}`)
          invalidCollections.push(collection)
        }
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
    const responseMsg = []

    if (validCollections.length) {
      responseMsg.push(`Sync started for the following collections: ${validCollections.map(i => i.address).join(', ')}.`)
    }

    if (invalidCollections.length) {
      responseMsg.push(`The following collections are invalid: ${invalidCollections.map(i => i.address).join(', ')}.`)
    }

    if (recentlyRefreshed.length) {
      responseMsg.push(`The following collections are recently refreshed: ${recentlyRefreshed.map(i => i.address).join(', ')}.`)
    }

    res.status(200).send({
      message: responseMsg.join(' '),
    })
  } catch (error) {
    logger.error(`err: ${error}`)
    res.status(400).send(error)
  }
})

// sync collections through file 
app.post('/uploadCollections', authMiddleWare, upload.single('file'), async (_req, res) => {
  if (_req.file != undefined) {
    const fileBufferToString: string = _req.file.buffer.toString('utf8')
    const stringBufferArray: string[] = fileBufferToString.split('\n')
    const validCollections: SyncCollectionInput[] = []
    const invalidCollections: SyncCollectionInput[] = []
    const recentlyRefreshed: SyncCollectionInput[] = []

    if (stringBufferArray.length) {
      for (const row of stringBufferArray) {
        if (typeof row === 'string' && row.length && row.includes(',')) {
          const rowSplit: string[] = row.split(',')
          const contract: string = rowSplit?.[0]
          const type: string = rowSplit?.[1]?.replace('\r', '')
          try {
            const checksumContract: string = helper.checkSum(contract)
            const collecionSynced: number = await cache.sismember(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, helper.checkSum(checksumContract))
            if (collecionSynced) {
              recentlyRefreshed.push({ address: checksumContract })
            } else {
              validCollections.push({ address: checksumContract, type })
            }
          } catch (err) {
            invalidCollections.push({ address: contract })
            logger.error(`checksum error: ${err}`)
          }
        }
      }
    }

    // sync collection + timestamp
    const jobId = `sync_collections_from_csv:${Date.now()}`
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
    const responseMsg = []

    if (validCollections.length) {
      responseMsg.push(`Sync started for the following collections: ${validCollections.map(i => i.address).join(', ')}.`)
    }
    
    if (invalidCollections.length) {
      responseMsg.push(`The following collections are invalid: ${invalidCollections.map(i => i.address).join(', ')}.`)
    }
    
    if (recentlyRefreshed.length) {
      responseMsg.push(`The following collections are recently refreshed: ${recentlyRefreshed.map(i => i.address).join(', ')}.`)
    }
    
    // if (recentlyRefreshed.length) {
    //   responseMsg.push(`The following collections are recently refreshed: ${recentlyRefreshed.map(i => i.address).join(', ')}.`)
    // }
    
    res.status(200).send({
      message: responseMsg.join(' '),
    })
  }
  // const fileContents: any[] = await readFile((_req as any).file.buffer);
  // res.json(fileContents);
})

// remove rarity job and cache
app.get('/stopRaritySync', authMiddleWare, async (_req, res) => {
  try {
    const rarityQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_RARITY)
    const jobId = 'sync_collection_rarity'
    const job: Bull.Job = await rarityQueue.getJob(jobId)
    if (job) {
      await job.remove()
    }

    if (rarityQueue) {
      await rarityQueue.obliterate({ force: true })
    }
    const cachedCollections = await cache.zrevrangebyscore(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, '+inf', '(0')
    await cache.del(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`)

    let message = 'Successfully stopped rarity sync'
    if (cachedCollections.length) {
      message += `for ${cachedCollections.join(' ')}`
    }
    return res.status(200).send({ message })
  } catch (error) {
    logger.error(`Error in remove rarity sync: ${error}`)
    return res.status(400).send({ message: JSON.stringify(error) })
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
