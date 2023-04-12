/* eslint-disable max-len */
import { Job, Queue, Worker, WorkerOptions } from 'bullmq'

import { _logger } from '@nftcom/shared'

import { redisConfig } from '../config'
import { cache, CacheKeys } from '../service/cache'
import { collectionBannerImageSync, collectionIssuanceDateSync, collectionNameSync, collectionSyncHandler, nftRaritySyncHandler, nftSyncHandler, raritySync, spamCollectionSyncHandler } from './collection.handler'
import { getEthereumEvents } from './mint.handler'
import { syncTxsFromNFTPortHandler } from './nftport.handler'
import { nftExternalOrdersOnDemand, orderReconciliationHandler } from './order.handler'
import { profileGKOwnersHandler, pullNewNFTsHandler, saveProfileExpireAt, updateNFTsForNonProfilesHandler, updateNFTsOwnershipForProfilesHandler } from './profile.handler'
import { searchListingIndexHandler } from './search.handler'
import { nftExternalOrderBatchProcessor, nftExternalOrders } from './sync.handler'
import { syncTrading } from './trading.handler'

/* -------------------------------- Constants ------------------------------- */
const BULL_MAX_REPEAT_COUNT = parseInt(process.env.BULL_MAX_REPEAT_COUNT) || 250
const ORDER_RECONCILIATION_PERIOD = parseInt(process.env.ORDER_RECONCILIATION_PERIOD) || 1440 // default is once every day
const logger = _logger.Factory(_logger.Context.Bull)
const connection = {
  host: redisConfig.host,
  port: redisConfig.port,
}
const queuePrefix = 'stream-queue'

/* ---------------------------------- Enums --------------------------------- */
export enum QUEUE_TYPES {
  SYNC_CONTRACTS = 'SYNC_CONTRACTS',
  SYNC_COLLECTIONS = 'SYNC_COLLECTIONS',
  SYNC_COLLECTION_IMAGES = 'SYNC_COLLECTION_IMAGES',
  SYNC_COLLECTION_NAME = 'SYNC_COLLECTION_NAME',
  SYNC_COLLECTION_RARITY = 'SYNC_COLLECTION_RARITY',
  SYNC_COLLECTION_NFT_RARITY = 'SYNC_COLLECTION_NFT_RARITY',
  SYNC_SPAM_COLLECTIONS = 'SYNC_SPAM_COLLECTIONS',
  UPDATE_PROFILES_NFTS_STREAMS = 'UPDATE_PROFILES_NFTS_STREAMS',
  UPDATE_NON_PROFILES_NFTS_STREAMS = 'UPDATE_NON_PROFILES_NFTS_STREAMS',
  UPDATE_PROFILES_WALLET_NFTS_STREAMS = 'UPDATE_PROFILES_WALLET_NFTS_STREAMS',
  FETCH_EXTERNAL_ORDERS_ON_DEMAND = 'FETCH_EXTERNAL_ORDERS_ON_DEMAND',
  GENERATE_COMPOSITE_IMAGE = 'GENERATE_COMPOSITE_IMAGE',
  FETCH_COLLECTION_ISSUANCE_DATE = 'FETCH_COLLECTION_ISSUANCE_DATE',
  SAVE_PROFILE_EXPIRE_AT = 'SAVE_PROFILE_EXPIRE_AT',
  SYNC_TRADING = 'SYNC_TRADING',
  SEARCH_ENGINE_LISTINGS_UPDATE = 'SEARCH_ENGINE_LISTINGS_UPDATE',
  SYNC_PROFILE_GK_OWNERS = 'SYNC_PROFILE_GK_OWNERS',
  SYNC_TXS_NFTPORT = 'SYNC_TXS_NFTPORT',
  RECONCILE_ORDERS = 'RECONCILE_ORDERS'
}

/* ------------------------------- Handler Map ------------------------------ */
const handlerMap: Record<string, { handler: any; repeat?: number; secondaryOptions?: any }> = {
  [QUEUE_TYPES.SYNC_CONTRACTS]: { handler: nftExternalOrders },
  [QUEUE_TYPES.SYNC_COLLECTIONS]: { handler: collectionSyncHandler },
  [QUEUE_TYPES.SYNC_COLLECTION_IMAGES]: { handler: collectionBannerImageSync },
  [QUEUE_TYPES.SYNC_COLLECTION_NAME]: { handler: collectionNameSync },
  [QUEUE_TYPES.SYNC_COLLECTION_RARITY]: { handler: raritySync, repeat: 5 * 60000 },
  [QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY]: { handler: nftRaritySyncHandler },
  [QUEUE_TYPES.SYNC_SPAM_COLLECTIONS]: { handler: spamCollectionSyncHandler, repeat: 24 * 60 * 60000 },
  [QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS]: { handler: updateNFTsOwnershipForProfilesHandler, repeat: 60000 * 10 }, // 10 minute syncs
  [QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS]: { handler: updateNFTsForNonProfilesHandler, repeat: 60000 * 10 }, // 10 minute syncs
  [QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS]: { handler: pullNewNFTsHandler, repeat: 60000 * 10 }, // 10 minute syncs
  [QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND]: { handler: nftExternalOrdersOnDemand, repeat: 2 * 60000,
    secondaryOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  },
  [QUEUE_TYPES.GENERATE_COMPOSITE_IMAGE]: { handler: collectionBannerImageSync, repeat: 60000 },
  [QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE]: { handler: collectionIssuanceDateSync, repeat: 12 * 60 * 60000,
    secondaryOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  },
  [QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT]: { handler: saveProfileExpireAt, repeat: 24 * 60 * 60000 },
  [QUEUE_TYPES.SYNC_TRADING]: { handler: syncTrading, repeat: 5 * 60000 },
  [QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE]: { handler: searchListingIndexHandler, repeat: 10 * 60000 },
  [QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS]: { handler: profileGKOwnersHandler, repeat: 10 * 60000 },
  [QUEUE_TYPES.SYNC_TXS_NFTPORT]: { handler: syncTxsFromNFTPortHandler, repeat: 15000 },
  [QUEUE_TYPES.RECONCILE_ORDERS]: { handler: orderReconciliationHandler, repeat: ORDER_RECONCILIATION_PERIOD * 60000 },
}

/* -------------------------- Queues and Subqueues -------------------------- */
export const queues = new Map<string, Queue>()

// nft order subqueue
const orderSubqueuePrefix = 'nft-order-sync'
const orderSubqueueName = 'nft-order-batch-processor'

// const subqueueNFTName = 'nft-update-processor'

// collection sync subqueue
const collectionSubqueuePrefix = 'collection-sync'
const collectionSubqueueName = 'collection-batch-processor'

// nft sync subqueue
// const nftSyncSubqueuePrefix: string = 'nft-sync'
// const nftSyncSubqueueName: string = 'nft-sync-batch-processor'

export let nftOrderSubqueue: Queue = null
// export let nftUpdateSubqueue: Bull.Queue = null
export let collectionSyncSubqueue: Queue = null
export const nftSyncSubqueue: Queue = null

const networkList = process.env.SUPPORTED_NETWORKS.split('|')
const networks = new Map()
networkList.map(network => {
  return networks.set(
    network.replace('ethereum:', '').split(':')[0], // chain id
    network.replace('ethereum:', '').split(':')[1], // human readable network name
  )
})

let didPublish: boolean

const subqueueWorkers = []

/* ---------------------------- Utility Functions --------------------------- */
const jobHasNotRunRecently = (job: Job<any>): boolean  => {
  const currentMillis = Date.now()
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: @types/bull is outdated
  return currentMillis > (job.opts.repeat.every * 1.2) + job.opts.prevMillis
}
/* ---------------------------- Queue Management ---------------------------- */
const createQueue = (queueType: QUEUE_TYPES, options: any = {}): Queue => {
  const queue = new Queue(queueType, { prefix: queuePrefix, connection, ...options })
  queues.set(queueType, queue)
  return queue
}

const createSubqueue = (
  subqueueName: string, subqueuePrefix: string, processor: any): Queue => {
  const subqueue = new Queue(subqueueName, { connection, prefix: subqueuePrefix })
  subqueueWorkers.push(new Worker(subqueue.name, processor, { connection, prefix: subqueuePrefix }))
  return subqueue
}

const createQueues = (): Promise<void> => {
  return new Promise((resolve) => {
    networks.forEach((chainId: string, network: string) => {
      queues.set(network, new Queue(chainId, { prefix: queuePrefix, connection }))
    })

    Object.values(QUEUE_TYPES).forEach((queueType) => createQueue(queueType))

    nftOrderSubqueue = createSubqueue(
      orderSubqueueName, orderSubqueuePrefix, nftExternalOrderBatchProcessor)
    collectionSyncSubqueue = createSubqueue(
      collectionSubqueueName, collectionSubqueuePrefix, nftSyncHandler)

    //nft subqueue
    //  nftSyncSubqueue = new Bull(nftSyncSubqueueName, {
    //   redis: redis,
    //   prefix: nftSyncSubqueuePrefix,
    // })

    // nftUpdateSubqueue = new Bull(subqueueNFTName, {
    //   redis: redis,
    //   prefix: subqueuePrefix,
    // })

    resolve()
  })
}

const getExistingJobs = (): Promise<Job[][]> => {
  const values = [...queues.values()]
  return Promise.all(values.map((queue) => {
    return queue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting', 'waiting-children', 'repeat', 'wait'])
  }))
}

const checkJobQueues = (jobs: Job[][]): Promise<boolean> => {
  const values = [...queues.values()]
  if (jobs.flat().length < queues.size) {
    logger.info('🐮 fewer bull jobs than queues --- wiping queues for restart')
    return Promise.all(values.map((queue) => {
      return queue.obliterate({ force: true })
    })).then(() => true)
  }

  for (const key of queues.keys()) {
    const queue = queues.get(key)
    const job = jobs.flat().find(job => job && job.queueName === queue.name)
    if ((job?.opts?.repeat
          && (job.opts.repeat.count >= BULL_MAX_REPEAT_COUNT || jobHasNotRunRecently(job)))
        || !job?.opts.repeat) {
      logger.info('🐮 bull job needs to restart -- wiping queues for restart')
      return Promise.all(values.map((queue) => {
        return queue.obliterate({ force: true })
      })).then(() => true)
    }
  }
  return new Promise(resolve => resolve(false))
}

const publishJobs = async (shouldPublish: boolean): Promise<void> => {
  if (!shouldPublish) {
    return
  }

  didPublish = true
  const chainId = process.env.CHAIN_ID

  const jobPromises = Object.entries(handlerMap)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .filter(([_, { repeat }]) => {
      return repeat // don't create a job for a non-repeatable queue
    })
    .map(async ([queueType, { repeat, secondaryOptions }]) => {
      const queue = queues.get(queueType)
      const defaultJobOptions = {
        removeOnComplete: true,
        removeOnFail: true,
        jobId: queueType,
      }

      const finalJobOptions = {
        ...defaultJobOptions,
        ...(repeat ? { repeat: { every: repeat } } : {}),
        ...(secondaryOptions ? secondaryOptions : {}),
      }

      await queue.add(queueType, { queueType, chainId }, finalJobOptions)
    })

  // Default case
  jobPromises.push((async () => {
    await queues.get(chainId).add('default', { chainId: chainId || process.env.CHAIN_ID }, {
      removeOnComplete: true,
      removeOnFail: true,
      repeat: { every: 3 * 60000 }, // repeat every 3 minutes
      jobId: `chainid_${chainId}_job`,
    })
  })())

  await Promise.all(jobPromises)
}

/* ---------------------------- Worker Management --------------------------- */
const defaultWorkerOpts = { connection, prefix: queuePrefix }

const getWorkerOptions = (queueName: string): WorkerOptions => {
  switch (queueName) {
  case QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS:
  case QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS:
  case QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS:
    return {
      ...defaultWorkerOpts,
      concurrency: 10,
    }
  default:
    return defaultWorkerOpts
  }
}

const listenToJobs = async (): Promise<void> => {
  for (const queue of queues.values()) {
    logger.info('🐮 listening to queue', queue.name)
    if (Object.prototype.hasOwnProperty.call(handlerMap, queue.name)) {
      const handler = handlerMap[queue.name].handler
      const workerOptions = getWorkerOptions(queue.name)
      new Worker(queue.name, handler, workerOptions)
    } else {
      logger.info(`🚨 No handler found for queue: ${queue.name}`)
      new Worker(queue.name, getEthereumEvents, defaultWorkerOpts)
    }
  }
}

/* ------------------------------ Cache Cleanup ----------------------------- */
export const cleanupProgressCache = async (): Promise<any> => {
  const chainId: string = process.env.CHAIN_ID
  await Promise.all([
    cache.del(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`),
    cache.del(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`),
    cache.del(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`),
    cache.del(`${CacheKeys.PROFILE_WALLET_FAIL_SCORE}_${chainId}`),
  ])
}

/* ------------------------ Start and Stop Functions ------------------------ */
export const startAndListen = async (): Promise<void> => {
  await createQueues()
  const jobs = await getExistingJobs()
  const shouldPublish = await checkJobQueues(jobs)
  await publishJobs(shouldPublish)
  await cleanupProgressCache()
  await listenToJobs()

  setTimeout(() => {
    didPublish
      ? logger.info('🍊 queue was restarted -- listening for jobs...')
      : logger.info('🍊 queue is healthy --- listening for jobs...')
  })
}

export const stopAndDisconnect = (): Promise<any> => {
  const values = [
    ...queues.values(),
    nftOrderSubqueue,
    collectionSyncSubqueue,
    // nftSyncSubqueue, // Uncomment if needed
  ].filter(Boolean)

  return Promise.all(values.map((queue) => queue.close()))
}