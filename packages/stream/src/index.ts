// Tracing needs to be set up early to ensure everything gets picked up
import { setupTracing } from './tracer'
if (['development','staging','production'].includes(process.env.NODE_ENV)) {
  setupTracing(`${process.env.NODE_ENV}-stream`)
}

import Bull from 'bull'
import { BigNumber } from 'ethers'
import express from 'express'
import kill from 'kill-port'
import multer from 'multer'

import { _logger, db, fp, helper } from '@nftcom/shared'

import { dbConfig } from './config'
import { nftOrderSubqueue, QUEUE_TYPES, queues, startAndListen, stopAndDisconnect } from './jobs/jobs'
import { authMiddleWare } from './middleware/auth'
import {
  collectionNameSyncSchema,
  collectionSyncSchema,
  nftRaritySyncSchema,
  SyncCollectionInput,
  syncTxsFromNFTPortSchema,
  validate,
} from './middleware/validate'
import { initiateStreaming } from './pipeline'
import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from './service/cache'
//import { startAndListen } from './jobs/jobs'
import { startProvider, stopProvider } from './service/on-chain'
import { client } from './service/opensea'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)
const chainId: string = process.env.CHAIN_ID || '5'
logger.log(`Chain Id for environment: ${chainId}`)

const upload = multer({ storage: multer.memoryStorage(),
  limits: {
    fields: 3,
  },
  fileFilter: (_req, file, cb) => {
    file.mimetype === 'text/csv' ? cb(null, true) : cb(new Error('Only csvs are allowed'))
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

// sync transactions from NFTPort

app.post('/syncTxsFromNFTPort', authMiddleWare, validate(syncTxsFromNFTPortSchema), async (_req, res) => {
  try {
    const MAXIMAM_PROCESS_AT_TIME = Number(process.env.MAX_BATCHES_NFTPORT)
    const { address, tokenId } = _req.body
    const key = tokenId ? helper.checkSum(address) + '::' + BigNumber.from(tokenId).toHexString() : helper.checkSum(address)
    const recentlyRefreshed: string = await cache.zscore(`${CacheKeys.NFTPORT_RECENTLY_SYNCED}_${chainId}`, key)
    if (!recentlyRefreshed) {
      // 1. remove expired collections and NFTS from the NFTPORT_RECENTLY_SYNCED cache
      await removeExpiredTimestampedZsetMembers(`${CacheKeys.NFTPORT_RECENTLY_SYNCED}_${chainId}`)
      // 2. check if collection or NFT is in NFTPORT_TO_SYNC cache
      const inTodo = await cache.zscore(`${CacheKeys.NFTPORT_TO_SYNC}_${chainId}`, key)
      if (!inTodo) {
        // 3. add to cache list
        await cache.zadd(`${CacheKeys.NFTPORT_TO_SYNC}_${chainId}`, 'INCR', 1, key)
      }
      // 4. check if syncing is in progress
      const inProgress = await cache.zscore(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, key)
      if (inProgress) {
        res.status(200).send({
          message: 'Syncing transactions is in progress.',
        })
      } else {
        // 5. check NFTPORT_SYNC_IN_PROGRESS cache if it's running more than MAXIMAM_PROCESS_AT_TIME collection or NFTs
        const processingCalls = await cache.zrevrangebyscore(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, '+inf', '(0')
        logger.info(`Number of processing calls for syncing txs from NFTPort : ${processingCalls.length}`)
        if (processingCalls.length < MAXIMAM_PROCESS_AT_TIME) {
          // 6. add collection or NFT to NFTPORT_SYNC_IN_PROGRESS
          await cache.zadd(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, 'INCR', 1, key)
          // 7. sync txs for collection + timestamp
          const jobId = `sync_txs_nftport:${Date.now()}`
          queues.get(QUEUE_TYPES.SYNC_TXS_NFTPORT)
            .add({
              SYNC_TXS_NFTPORT: QUEUE_TYPES.SYNC_TXS_NFTPORT,
              address,
              tokenId,
              endpoint: tokenId ? 'txByNFT' : 'txByContract',
              chainId: process.env.CHAIN_ID,
            }, {
              removeOnComplete: true,
              removeOnFail: true,
              jobId,
            })
          res.status(200).send({
            message: 'Started syncing transactions.',
          })
        } else {
          res.status(200).send({
            message: 'Syncing transactions are queued. Will begin soon.',
          })
        }
      }
    } else {
      res.status(200).send({
        message: 'Transactions are recently refreshed.',
      })
    }
  } catch (err) {
    logger.error(`err: ${err}`)
    res.status(400).send(err)
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
            startToken: collection?.startToken,
            type: collection?.type,
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
app.get('/raritySyncCollections', authMiddleWare, async (_req, res) => {
  try {
    const cachedCollections = await cache.zrevrangebyscore(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, '+inf', '(0')

    let message = 'No Collections Running!'
    if (cachedCollections.length) {
      message = `Sync in progress for ${cachedCollections.join(' ')}`
    }
    return res.status(200).send({ message })
  } catch (error) {
    logger.error(`Error in rarity sync cache fetch: ${error}`)
    return res.status(400).send({ message: JSON.stringify(error) })
  }
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

// sync collection images - authenticated
app.get('/syncCollectionBannerImages', authMiddleWare, async (_req, res) => {
  try {
    const jobId = 'sync_collection_images'
    const collectionBannerImageQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_IMAGES)
    const job: Bull.Job = await collectionBannerImageQueue.getJob(jobId)
    if (job && (job.isFailed() || job.isPaused() || job.isStuck() || job.isDelayed())) {
      await job.remove()
    }

    if(!job) {
      collectionBannerImageQueue
        .add({
          SYNC_CONTRACTS: QUEUE_TYPES.SYNC_COLLECTION_IMAGES,
          chainId: process.env.CHAIN_ID,
        }, {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          jobId: 'sync_collection_images',
        })
      return res.status(200).send({ message: 'Sync Started!' })
    }

    return res.status(200).send({ message: 'Sync In Progress Already!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// sync collection images - authenticated
app.get('/stopSyncCollectionBannerImages', authMiddleWare, async (_req, res) => {
  try {
    const jobId = 'sync_collection_images'
    const collectionBannerImageQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_IMAGES)
    const job: Bull.Job = await collectionBannerImageQueue.getJob(jobId)
    if (job) {
      await job.moveToFailed(new Error('Abort Triggered!'), true)
      await job.discard()
      await job.remove()
      // await killProcess(job.data.pid)
      return res.status(200).send({ message: 'Stopped Sync!' })
    }

    return res.status(200).send({ message: 'No Sync In Progress!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// sync collection name - authenticated
app.get('/syncCollectionName', authMiddleWare, validate(collectionNameSyncSchema), async (_req, res) => {
  const { official, contract } = _req.query
  try {
    const jobId = 'sync_collection_name'
    const collectionNameQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_NAME)
    const job: Bull.Job = await collectionNameQueue.getJob(jobId)
    if (job && (job.isFailed() || job.isPaused() || job.isStuck() || job.isDelayed())) {
      await job.remove()
    }

    if(!job) {
      collectionNameQueue
        .add({
          SYNC_CONTRACTS: QUEUE_TYPES.SYNC_COLLECTION_NAME,
          chainId: process.env.CHAIN_ID,
          contract,
          official,
        }, {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          jobId: 'sync_collection_name',
        })
      return res.status(200).send({ message: 'Collection Name Sync Started!' })
    }

    return res.status(200).send({ message: 'Collection Name Sync In Progress Already!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// stop sync collection name - authenticated
app.get('/stopSyncCollectionName', authMiddleWare, async (_req, res) => {
  try {
    const jobId = 'sync_collection_name'
    const collectionNameQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_NAME)
    const job: Bull.Job = await collectionNameQueue.getJob(jobId)
    if (job) {
      await job.moveToFailed(new Error('Abort Triggered!'), true)
      await job.discard()
      await job.remove()
      // await killProcess(job.data.pid)
      return res.status(200).send({ message: 'Stopped Collection Name Sync!' })
    }

    return res.status(200).send({ message: 'No Collection Name Sync In Progress!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// sync collection rarity - authenticated
app.post('/syncCollectionRarity', authMiddleWare, validate(collectionSyncSchema), async (_req, res) => {
  try {
    const { collections } = _req.body
    const validCollections: SyncCollectionInput[] = []
    const invalidCollections: SyncCollectionInput[] = []
    const recentlyRefreshed: SyncCollectionInput[] = []
    const inprogress: SyncCollectionInput[] = []

    if (!collections.length) {
      return res.status(400).send({ message: 'No collection to be synced!' })
    }

    for (const collection of collections) {
      let checksumContract = ''
      try {
        checksumContract = helper.checkSum(collection?.address)
      } catch(err) {
        invalidCollections.push(collection)
        continue
      }

      if (checksumContract) {
        const contractInRefreshedCache: string = await cache.zscore(`${CacheKeys.REFRESHED_COLLECTION_RARITY}_${chainId}`, checksumContract)

        if (Number(contractInRefreshedCache)) {
          const ttlNotExpiredCond: boolean = Date.now() < Number(contractInRefreshedCache)
          if (ttlNotExpiredCond) {
            recentlyRefreshed.push(collection)
            continue
          }
        }

        const contractInRefreshCache: string = await cache.zscore(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, checksumContract)

        if (Number(contractInRefreshCache)) {
          inprogress.push(collection)
          continue
        }

        validCollections.push({
          address: checksumContract,
        })
      }
    }

    for (const collection of validCollections) {
      await cache.zadd(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, 1, collection.address)
    }

    let message = ''
    if (validCollections.length) {
      message += `Collection Rarity Sync Started for ${validCollections.map(col => col.address).join(', ')}! `
    }

    if (invalidCollections.length) {
      message += `The following collections are invalid: ${invalidCollections.map(col => col.address).join(', ')} `
    }

    if (recentlyRefreshed.length) {
      message += `The following collections are recently refreshed: ${recentlyRefreshed.map(col => col.address).join(', ')}`
    }

    return res.status(200).send({ message })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// stop sync collection rarity - authenticated
app.post('/stopSyncCollectionRarity', authMiddleWare, async (_req, res) => {
  try {
    const { contract } = _req.body
    const checksumContract: string = helper.checkSum(contract)
    await cache.zrem(`${CacheKeys.REFRESHED_COLLECTION_RARITY}_${chainId}`, checksumContract)
    return res.status(200).send({ message: 'No Collection Null Rarity Sync In Progress!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// sync collection nft - authenticated
app.post('/syncCollectionNftRarity', authMiddleWare, validate(nftRaritySyncSchema), async (_req, res) => {
  const { contract, tokenIds } = _req.body
  try {
    const jobId = 'sync_collection_nft_rarity'
    const collectionNullRarityQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY)
    const job: Bull.Job = await collectionNullRarityQueue.getJob(jobId)
    if (job && (job.isFailed() || job.isPaused() || job.isStuck() || job.isDelayed())) {
      await job.remove()
    }

    if(!job) {
      collectionNullRarityQueue
        .add({
          SYNC_CONTRACTS: QUEUE_TYPES.SYNC_COLLECTION_NAME,
          chainId: process.env.CHAIN_ID,
          contract,
          tokenIds,
        }, {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          jobId: 'sync_collection_nft_rarity',
        })
      return res.status(200).send({ message: 'Collection Name Sync Started!' })
    }

    return res.status(200).send({ message: 'Collection Name Sync In Progress Already!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
  }
})

// stop sync collection nft rarity - authenticated
app.post('/stopSyncCollectionNftRarity', authMiddleWare, async (_req, res) => {
  try {
    const jobId = 'sync_collection_nft_rarity'
    const collectionNameQueue = queues.get(QUEUE_TYPES.SYNC_COLLECTION_NAME)
    const job: Bull.Job = await collectionNameQueue.getJob(jobId)
    if (job) {
      await job.moveToFailed(new Error('Abort Triggered!'), true)
      await job.discard()
      await job.remove()
      // await killProcess(job.data.pid)
      return res.status(200).send({ message: 'Stopped Collection Sync!' })
    }

    return res.status(200).send({ message: 'No Collection Null Rarity Sync In Progress!!' })
  } catch (error) {
    logger.error(`err: ${error}`)
    return res.status(400).send(error)
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
    .then(db.connectPg)
    .then(startAndListen)
    .then(startServer)
    .then(client.connect)
    .then(initiateStreaming)
    .then(() => startProvider(chainId))
    .then(fp.pause(500))
}

const killPort = (): Promise<unknown> => {
  return kill(PORT)
  // Without this small delay sometimes it's not killed in time -
    .then(fp.pause(500))
    .catch((err: any) => logger.error(err))
}

const logExit = (): void => {
  logger.info('Exited!')
}

const gracefulShutdown = (): Promise<void> => {
  return stopServer()
    .then(killPort)
    .then(stopAndDisconnect)
    .then(client.disconnect)
    .then(stopProvider)
    .then(fp.pause(500))
    .then(db.disconnect)
    .then(db.endPg)
    .then(fp.pause(500))
    .finally(() => {
      logExit()
      process.exit()
    })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
// catches uncaught exceptions
process.on('uncaughtException', async (err) => {
  logger.error(err, 'Uncaught Exception thrown')
  await gracefulShutdown()
})
process.on('unhandledRejection', async (reason, p) => {
  logger.error('Unhandled Rejection at:', p, 'reason:', reason)
  await gracefulShutdown()
})

bootstrap().catch(handleError)
