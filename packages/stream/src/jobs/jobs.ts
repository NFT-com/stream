import Bull from 'bull'

import { _logger } from '@nftcom/shared'

import { redisConfig } from '../config'
import { collectionBannerImageSync, collectionIssuanceDateSync, collectionNameSync, collectionSyncHandler, nftRaritySyncHandler, raritySync, spamCollectionSyncHandler } from './collection.handler'
import { getEthereumEvents } from './mint.handler'
import { nftExternalOrdersOnDemand, orderReconciliationHandler } from './order.handler'
import { deregisterStreamHandler, registerStreamHandler } from './os.handler'
import { profileGKOwnersHandler, saveProfileExpireAt, updateNFTsForProfilesHandler } from './profile.handler'
import { searchListingIndexHandler } from './search.handler'
import { nftExternalOrders } from './sync.handler'
import { syncTrading } from './trading.handler'

const BULL_MAX_REPEAT_COUNT = parseInt(process.env.BULL_MAX_REPEAT_COUNT) || 250
const ORDER_RECONCILIATION_PERIOD = parseInt(process.env.ORDER_RECONCILIATION_PERIOD) || 14400 // default is once every day
const logger = _logger.Factory(_logger.Context.Bull)

export const redis = {
  host: redisConfig.host,
  port: redisConfig.port,
}
const queuePrefix = 'stream-queue'

export enum QUEUE_TYPES {
  SYNC_CONTRACTS = 'SYNC_CONTRACTS',
  SYNC_COLLECTIONS = 'SYNC_COLLECTIONS',
  SYNC_COLLECTION_IMAGES = 'SYNC_COLLECTION_IMAGES',
  SYNC_COLLECTION_NAME = 'SYNC_COLLECTION_NAME',
  SYNC_COLLECTION_RARITY = 'SYNC_COLLECTION_RARITY',
  SYNC_COLLECTION_NFT_RARITY = 'SYNC_COLLECTION_NFT_RARITY',
  SYNC_SPAM_COLLECTIONS = 'SYNC_SPAM_COLLECTIONS',
  REGISTER_OS_STREAMS = 'REGISTER_OS_STREAMS',
  DEREGISTER_OS_STREAMS = 'DEREGISTER_OS_STREAMS',
  UPDATE_PROFILES_NFTS_STREAMS = 'UPDATE_PROFILES_NFTS_STREAMS',
  FETCH_EXTERNAL_ORDERS = 'FETCH_EXTERNAL_ORDERS',
  FETCH_EXTERNAL_ORDERS_ON_DEMAND = 'FETCH_EXTERNAL_ORDERS_ON_DEMAND',
  GENERATE_COMPOSITE_IMAGE = 'GENERATE_COMPOSITE_IMAGE',
  FETCH_COLLECTION_ISSUANCE_DATE = 'FETCH_COLLECTION_ISSUANCE_DATE',
  SAVE_PROFILE_EXPIRE_AT = 'SAVE_PROFILE_EXPIRE_AT',
  SYNC_TRADING = 'SYNC_TRADING',
  SEARCH_ENGINE_LISTINGS_UPDATE = 'SEARCH_ENGINE_LISTINGS_UPDATE',
  SYNC_PROFILE_GK_OWNERS = 'SYNC_PROFILE_GK_OWNERS',
  RECONCILE_ORDERS = 'RECONCILE_ORDERS'
}

export const queues = new Map<string, Bull.Queue>()

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

export let nftOrderSubqueue: Bull.Queue = null
// export let nftUpdateSubqueue: Bull.Queue = null
export let collectionSyncSubqueue: Bull.Queue = null
export const nftSyncSubqueue: Bull.Queue = null

const networkList = process.env.SUPPORTED_NETWORKS.split('|')
const networks = new Map()
networkList.map(network => {
  return networks.set(
    network.replace('ethereum:', '').split(':')[0], // chain id
    network.replace('ethereum:', '').split(':')[1], // human readable network name
  )
})

let didPublish: boolean

const createQueues = (): Promise<void> => {
  return new Promise((resolve) => {
    networks.forEach((chainId: string, network: string) => {
      queues.set(network, new Bull(chainId, {
        prefix: queuePrefix,
        redis,
      }))
    })

    // add trading handler job to queue...
    queues.set(QUEUE_TYPES.SYNC_TRADING, new Bull(
      QUEUE_TYPES.SYNC_TRADING, {
        prefix: queuePrefix,
        redis,
      }))

    // add composite image generation job to queue...
    queues.set(QUEUE_TYPES.GENERATE_COMPOSITE_IMAGE, new Bull(
      QUEUE_TYPES.GENERATE_COMPOSITE_IMAGE, {
        prefix: queuePrefix,
        redis,
      }))

    // sync collection images...
    queues.set(QUEUE_TYPES.SYNC_COLLECTION_IMAGES, new Bull(
      QUEUE_TYPES.SYNC_COLLECTION_IMAGES, {
        prefix: queuePrefix,
        redis,
      }))

    // sync collection images...
    queues.set(QUEUE_TYPES.SYNC_COLLECTION_NAME, new Bull(
      QUEUE_TYPES.SYNC_COLLECTION_NAME, {
        prefix: queuePrefix,
        redis,
      }))

    queues.set(QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT, new Bull(
      QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT, {
        prefix: queuePrefix,
        redis,
      }))

    queues.set(QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS, new Bull(
      QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS, {
        prefix: queuePrefix,
        redis,
      }))

    queues.set(QUEUE_TYPES.REGISTER_OS_STREAMS, new Bull(
      QUEUE_TYPES.REGISTER_OS_STREAMS, {
        prefix: queuePrefix,
        redis,
      }))

    // sync external orders
    queues.set(QUEUE_TYPES.SYNC_CONTRACTS, new Bull(
      QUEUE_TYPES.SYNC_CONTRACTS, {
        prefix: queuePrefix,
        redis,
      }))

    // sync external collections
    queues.set(QUEUE_TYPES.SYNC_COLLECTIONS, new Bull(
      QUEUE_TYPES.SYNC_COLLECTIONS, {
        prefix: queuePrefix,
        redis,
      }))

    // sync collection rarity
    queues.set(QUEUE_TYPES.SYNC_COLLECTION_RARITY, new Bull(
      QUEUE_TYPES.SYNC_COLLECTION_RARITY, {
        prefix: queuePrefix,
        redis,
      }))

    // sync nft/null nft rarity
    queues.set(QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY, new Bull(
      QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY, {
        prefix: queuePrefix,
        redis,
      }))

    // sync collection issuance date
    queues.set(QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE, new Bull(
      QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE, {
        prefix: queuePrefix,
        redis,
      }))

    // sync spam collections
    queues.set(QUEUE_TYPES.SYNC_SPAM_COLLECTIONS, new Bull(
      QUEUE_TYPES.SYNC_SPAM_COLLECTIONS, {
        prefix: queuePrefix,
        redis,
      }))

    //order subqueue
    nftOrderSubqueue = new Bull(orderSubqueueName, {
      redis: redis,
      prefix: orderSubqueuePrefix,
    })

    //collection subqueue
    collectionSyncSubqueue = new Bull(collectionSubqueueName, {
      redis: redis,
      prefix: collectionSubqueuePrefix,
    })

    //nft subqueue
    //  nftSyncSubqueue = new Bull(nftSyncSubqueueName, {
    //   redis: redis,
    //   prefix: nftSyncSubqueuePrefix,
    // })

    // nftUpdateSubqueue = new Bull(subqueueNFTName, {
    //   redis: redis,
    //   prefix: subqueuePrefix,
    // })

    queues.set(QUEUE_TYPES.DEREGISTER_OS_STREAMS, new Bull(
      QUEUE_TYPES.DEREGISTER_OS_STREAMS, {
        prefix: queuePrefix,
        redis,
      }))

    queues.set(QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS, new Bull(
      QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS, {
        prefix: queuePrefix,
        redis,
      }))

    // external orders on demand
    queues.set(QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND, new Bull(
      QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND, {
        prefix: queuePrefix,
        redis,
      }))

    queues.set(QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE, new Bull(
      QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE, {
        prefix: queuePrefix,
        redis,
      }))

    // reconcile exchange orders
    queues.set(QUEUE_TYPES.RECONCILE_ORDERS, new Bull(
      QUEUE_TYPES.RECONCILE_ORDERS, {
        prefix: queuePrefix,
        redis,
      }))

    resolve()
  })
}

const getExistingJobs = (): Promise<Bull.Job[][]> => {
  const values = [...queues.values()]
  return Promise.all(values.map((queue) => {
    return queue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
  }))
}

const jobHasNotRunRecently = (job: Bull.Job<any>): boolean  => {
  const currentMillis = Date.now()
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: @types/bull is outdated
  return currentMillis > (job.opts.repeat.every * 1.2) + job.opts.prevMillis
}

const checkJobQueues = (jobs: Bull.Job[][]): Promise<boolean> => {
  const values = [...queues.values()]
  if (jobs.flat().length < queues.size) {
    logger.info('🐮 fewer bull jobs than queues -- wiping queues for restart')
    return Promise.all(values.map((queue) => {
      return queue.obliterate({ force: true })
    })).then(() => true)
  }

  for (const key of queues.keys()) {
    const queue = queues.get(key)
    const job = jobs.flat().find(job => job.queue === queue)
    if ((job.opts.repeat
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore: @types/bull is outdated
          && (job.opts.repeat.count >= BULL_MAX_REPEAT_COUNT || jobHasNotRunRecently(job)))
        || !job.opts.repeat) {
      logger.info('🐮 bull job needs to restart -- wiping queues for restart')
      return Promise.all(values.map((queue) => {
        return queue.obliterate({ force: true })
      })).then(() => true)
    }
  }
  return new Promise(resolve => resolve(false))
}

const publishJobs = (shouldPublish: boolean): Promise<void> => {
  if (shouldPublish) {
    didPublish = true
    const chainIds = [...queues.keys()]
    return Promise.all(chainIds.map((chainId) => {
      switch (chainId) {
      case QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS:
        return queues.get(QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS)
          .add({
            UPDATE_PROFILES_NFTS_STREAMS: QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS,
            chainId: process.env.CHAIN_ID,
          },
          {
            removeOnComplete: true,
            removeOnFail: true,
            // repeat every minute
            repeat: { every: 1 * 60000 },
            jobId: 'update_profiles_nfts_streams',
          })
      case QUEUE_TYPES.SYNC_COLLECTION_RARITY:
        return queues.get(QUEUE_TYPES.SYNC_COLLECTION_RARITY)
          .add({
            SYNC_COLLECTION_RARITY: QUEUE_TYPES.SYNC_COLLECTION_RARITY,
            chainId: process.env.CHAIN_ID,
          },
          {
            removeOnComplete: true,
            removeOnFail: true,
            // repeat every five minutes - this repeat job runs to pick up collection addresses from cache
            repeat: { every: 5 * 60000 },
            jobId: 'sync_collection_rarity',
          })
      case QUEUE_TYPES.SYNC_SPAM_COLLECTIONS:
        return queues.get(QUEUE_TYPES.SYNC_SPAM_COLLECTIONS)
          .add({
            SYNC_SPAM_COLLECTIONS: QUEUE_TYPES.SYNC_SPAM_COLLECTIONS,
            chainId: process.env.CHAIN_ID,
          },
          {
            removeOnComplete: true,
            removeOnFail: true,
            // repeat every once every day
            repeat: { every: 24 * 60 * 60000 },
            jobId: 'sync_spam_collections',
          })
      case QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT:
        return queues.get(QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT)
          .add({
            SAVE_PROFILE_EXPIRE_AT: QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT,
            chainId: process.env.CHAIN_ID,
          },
          {
            removeOnComplete: true,
            removeOnFail: true,
            // repeat every once every day
            repeat: { every: 24 * 60 * 60000 },
            jobId: 'save_profile_expire_at',
          })
      case QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS:
        return queues.get(QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS).add(
          { chainId: process.env.CHAIN_ID }, {
            removeOnComplete: true,
            removeOnFail: true,
            // repeat every 10 minutes
            repeat: { every: 10 * 60000 },
            jobId: 'sync_profile_gk_owners',
          })
      // case QUEUE_TYPES.REGISTER_OS_STREAMS:
      //   return queues.get(QUEUE_TYPES.REGISTER_OS_STREAMS)
      //     .add({ REGISTER_OS_STREAMS: QUEUE_TYPES.REGISTER_OS_STREAMS }, {
      //       removeOnComplete: true,
      //       removeOnFail: true,
      //       // repeat every  2 minutes
      //       repeat: { every: 10 * 60000 },
      //       jobId: 'register_os_streams',
      //     })
      // case QUEUE_TYPES.DEREGISTER_OS_STREAMS:
      //   return queues.get(QUEUE_TYPES.DEREGISTER_OS_STREAMS)
      //     .add({ DEREGISTER_OS_STREAMS: QUEUE_TYPES.DEREGISTER_OS_STREAMS }, {
      //       removeOnComplete: true,
      //       removeOnFail: true,
      //       // repeat every  2 minutes
      //       repeat: { every: 10 * 60000 },
      //       jobId: 'deregister_os_streams',
      //     })
      case QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND:
        return queues.get(QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND)
          .add({
            FETCH_EXTERNAL_ORDERS_ON_DEMAND: QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND,
            chainId: process.env.CHAIN_ID,
          }, {
            attempts: 5,
            removeOnComplete: true,
            removeOnFail: true,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            // repeat every  2 minutes
            repeat: { every: 2 * 60000 },
            jobId: 'fetch_external_orders_on_demand',
          })
      case QUEUE_TYPES.SYNC_TRADING:
        return queues.get(QUEUE_TYPES.SYNC_TRADING).add({ chainId: process.env.CHAIN_ID }, {
          removeOnComplete: true,
          removeOnFail: true,
          // repeat every 5 minutes
          repeat: { every: 5 * 60000 },
          jobId: 'sync_trading',
        })
      case QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE:
        return queues.get(QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE)
          .add({
            FETCH_COLLECTION_ISSUANCE_DATE: QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE,
            chainId: process.env.CHAIN_ID,
          }, {
            attempts: 5,
            removeOnComplete: true,
            removeOnFail: true,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            // repeat every  12 hours
            repeat: { every: 12 * 60 * 60000 },
            jobId: 'fetch_collection_issuance_date',
          })
      case QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE:
        return queues.get(QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE)
          .add({}, {
            removeOnComplete: true,
            removeOnFail: true,
            repeat: { every: 10 * 60000 },
            jobId: 'search_engine_listings_update',
          })
      case QUEUE_TYPES.RECONCILE_ORDERS:
        return queues.get(QUEUE_TYPES.RECONCILE_ORDERS)
          .add({
            chainId: process.env.CHAIN_ID,
          }, {
            removeOnComplete: true,
            removeOnFail: true,
            // will run every week?
            repeat: { every: ORDER_RECONCILIATION_PERIOD * 60000 },
            jobId: 'reconcile_orders',
          })
      default:
        return queues.get(chainId).add({ chainId }, {
          removeOnComplete: true,
          removeOnFail: true,
          // repeat every 3 minutes
          repeat: { every: 3 * 60000 },
          jobId: `chainid_${chainId}_job`,
        })
      }
    })).then(() => undefined)
  }

  return new Promise(resolve => resolve(undefined))
}

const listenToJobs = async (): Promise<void> => {
  for (const queue of queues.values()) {
    switch (queue.name) {
    case QUEUE_TYPES.SYNC_CONTRACTS:
      queue.process(nftExternalOrders)
      break
    case QUEUE_TYPES.SYNC_COLLECTION_IMAGES:
      queue.process(collectionBannerImageSync)
      break
    case QUEUE_TYPES.SYNC_TRADING:
      queue.process(syncTrading)
      break
    case QUEUE_TYPES.SYNC_COLLECTION_NAME:
      queue.process(collectionNameSync)
      break
    case QUEUE_TYPES.SYNC_COLLECTIONS:
      queue.process(collectionSyncHandler)
      break
    case QUEUE_TYPES.SYNC_COLLECTION_RARITY:
      queue.process(raritySync)
      break
    case QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY:
      queue.process(nftRaritySyncHandler)
      break
    case QUEUE_TYPES.SYNC_SPAM_COLLECTIONS:
      queue.process(spamCollectionSyncHandler)
      break
    case QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND:
      queue.process(nftExternalOrdersOnDemand)
      break
    case QUEUE_TYPES.REGISTER_OS_STREAMS:
      queue.process(registerStreamHandler)
      break
    case QUEUE_TYPES.DEREGISTER_OS_STREAMS:
      queue.process(deregisterStreamHandler)
      break
    case QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS:
      queue.process(updateNFTsForProfilesHandler)
      break
    case QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE:
      queue.process(collectionIssuanceDateSync)
      break
    case QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT:
      queue.process(saveProfileExpireAt)
      break
    case QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS:
      queue.process(profileGKOwnersHandler)
      break
    case QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE:
      queue.process(searchListingIndexHandler)
      break
    case QUEUE_TYPES.RECONCILE_ORDERS:
      queue.process(orderReconciliationHandler)
      break
    default:
      queue.process(getEthereumEvents)
    }
  }
}

export const startAndListen = (): Promise<void> => {
  return createQueues()
    .then(() => getExistingJobs())
    .then((jobs) => checkJobQueues(jobs))
    .then((shouldPublish) => publishJobs(shouldPublish))
    .then(() => listenToJobs())
    .then(() => {
      setTimeout(() => {
        didPublish ? logger.info('🍊 queue was restarted -- listening for jobs...')
          : logger.info('🍊 queue is healthy -- listening for jobs...')
      })
    })
}

export const stopAndDisconnect = (): Promise<any> => {
  const values = [...queues.values()]
  // close order sub-queue
  if (nftOrderSubqueue) {
    values.push(nftOrderSubqueue)
  }
  // close collection sub-queue
  if (collectionSyncSubqueue) {
    values.push(collectionSyncSubqueue)
  }
  // close nft sub-queue
  // if (nftSyncSubqueue) {
  //   values.push(nftSyncSubqueue)
  // }
  return Promise.all(values.map((queue) => {
    return queue.close()
  }))
}
