/* eslint-disable @typescript-eslint/no-unused-vars */
import { Job, Queue, Worker } from 'bullmq'

import { _logger } from '@nftcom/shared'

import { redisConfig } from '../config'
import { cache, CacheKeys } from '../service/cache'
import { collectionBannerImageSync, collectionIssuanceDateSync, collectionNameSync, collectionSyncHandler, nftRaritySyncHandler, nftSyncHandler, raritySync, spamCollectionSyncHandler } from './collection.handler'
// import { getEthereumEvents } from './mint.handler'
import { syncTxsFromNFTPortHandler } from './nftport.handler'
import { nftExternalOrdersOnDemand, orderReconciliationHandler } from './order.handler'
import { profileGKOwnersHandler, pullNewNFTsHandler, saveProfileExpireAt, updateNFTsForNonProfilesHandler, updateNFTsOwnershipForProfilesHandler } from './profile.handler'
import { searchListingIndexHandler } from './search.handler'
import { nftExternalOrderBatchProcessor, nftExternalOrders } from './sync.handler'
import { syncTrading } from './trading.handler'

const BULL_MAX_REPEAT_COUNT = parseInt(process.env.BULL_MAX_REPEAT_COUNT) || 250
const ORDER_RECONCILIATION_PERIOD = parseInt(process.env.ORDER_RECONCILIATION_PERIOD) || 1440 // default is once every day
const logger = _logger.Factory(_logger.Context.Bull)

export const connection = {
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
  UPDATE_PROFILES_NFTS_STREAMS = 'UPDATE_PROFILES_NFTS_STREAMS',
  UPDATE_NON_PROFILES_NFTS_STREAMS = 'UPDATE_NON_PROFILES_NFTS_STREAMS',
  UPDATE_PROFILES_WALLET_NFTS_STREAMS = 'UPDATE_PROFILES_WALLET_NFTS_STREAMS',
  FETCH_EXTERNAL_ORDERS = 'FETCH_EXTERNAL_ORDERS',
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

export const nftOrderSubqueue: Queue = null
// export let nftUpdateSubqueue: Bull.Queue = null
export const collectionSyncSubqueue: Queue = null
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
const createQueues = (): Promise<void> => {
  return new Promise((resolve) => {
    networks.forEach((chainId: string, network: string) => {
      queues.set(network, new Queue(chainId, {
        prefix: queuePrefix,
        connection,
      }))
    })

    // // add trading handler job to queue...
    // queues.set(QUEUE_TYPES.SYNC_TRADING, new Queue(
    //   QUEUE_TYPES.SYNC_TRADING, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // add composite image generation job to queue...
    // queues.set(QUEUE_TYPES.GENERATE_COMPOSITE_IMAGE, new Queue(
    //   QUEUE_TYPES.GENERATE_COMPOSITE_IMAGE, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync collection images...
    // queues.set(QUEUE_TYPES.SYNC_COLLECTION_IMAGES, new Queue(
    //   QUEUE_TYPES.SYNC_COLLECTION_IMAGES, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync collection images...
    // queues.set(QUEUE_TYPES.SYNC_COLLECTION_NAME, new Queue(
    //   QUEUE_TYPES.SYNC_COLLECTION_NAME, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // queues.set(QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT, new Queue(
    //   QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // queues.set(QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS, new Queue(
    //   QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync external orders
    // queues.set(QUEUE_TYPES.SYNC_CONTRACTS, new Queue(
    //   QUEUE_TYPES.SYNC_CONTRACTS, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync txs from nftport
    // queues.set(QUEUE_TYPES.SYNC_TXS_NFTPORT, new Queue(
    //   QUEUE_TYPES.SYNC_TXS_NFTPORT, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync external collections
    // queues.set(QUEUE_TYPES.SYNC_COLLECTIONS, new Queue(
    //   QUEUE_TYPES.SYNC_COLLECTIONS, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync collection rarity
    // queues.set(QUEUE_TYPES.SYNC_COLLECTION_RARITY, new Queue(
    //   QUEUE_TYPES.SYNC_COLLECTION_RARITY, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync nft/null nft rarity
    // queues.set(QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY, new Queue(
    //   QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync collection issuance date
    // queues.set(QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE, new Queue(
    //   QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // sync spam collections
    // queues.set(QUEUE_TYPES.SYNC_SPAM_COLLECTIONS, new Queue(
    //   QUEUE_TYPES.SYNC_SPAM_COLLECTIONS, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // //order subqueue
    // nftOrderSubqueue = new Queue(orderSubqueueName, {
    //   connection,
    //   prefix: orderSubqueuePrefix,
    // })
    // subqueueWorkers.push(new Worker(
    //   nftOrderSubqueue.name,
    //   nftExternalOrderBatchProcessor,
    //   { connection, prefix: orderSubqueuePrefix },
    // ))

    // //collection subqueue
    // collectionSyncSubqueue = new Queue(collectionSubqueueName, {
    //   connection,
    //   prefix: collectionSubqueuePrefix,
    // })
    // subqueueWorkers.push(new Worker(
    //   collectionSyncSubqueue.name,
    //   nftSyncHandler,
    //   { connection, prefix: collectionSubqueuePrefix },
    // ))

    //nft subqueue
    //  nftSyncSubqueue = new Bull(nftSyncSubqueueName, {
    //   redis: redis,
    //   prefix: nftSyncSubqueuePrefix,
    // })

    // nftUpdateSubqueue = new Bull(subqueueNFTName, {
    //   redis: redis,
    //   prefix: subqueuePrefix,
    // })

    queues.set(QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS, new Queue(
      QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS, {
        prefix: queuePrefix,
        connection,
      }))

    queues.set(
      QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS,
      new Queue(QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS, {
        prefix: queuePrefix,
        connection,
      }),
    )

    queues.set(QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS, new Queue(
      QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS, {
        prefix: queuePrefix,
        connection,
      }))

    // // external orders on demand
    // queues.set(QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND, new Queue(
    //   QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // queues.set(QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE, new Queue(
    //   QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    // // reconcile exchange orders
    // queues.set(QUEUE_TYPES.RECONCILE_ORDERS, new Queue(
    //   QUEUE_TYPES.RECONCILE_ORDERS, {
    //     prefix: queuePrefix,
    //     connection,
    //   }))

    resolve()
  })
}

const getExistingJobs = (): Promise<Job[][]> => {
  const values = [...queues.values()]
  return Promise.all(values.map((queue) => {
    return queue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting', 'waiting-children', 'repeat', 'wait'])
  }))
}

const jobHasNotRunRecently = (job: Job<any>): boolean  => {
  const currentMillis = Date.now()
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: @types/bull is outdated
  return currentMillis > (job.opts.repeat.every * 1.2) + job.opts.prevMillis
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

const publishJobs = (shouldPublish: boolean): Promise<void> => {
  if (shouldPublish) {
    didPublish = true
    const chainIds = [...queues.keys()]
    return Promise.all(chainIds.map((chainId) => {
      switch (chainId) {
      case QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS:
        return queues.get(QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS)
          .add(QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS, {
            UPDATE_PROFILES_NFTS_STREAMS: QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS,
            chainId: process.env.CHAIN_ID,
          },
          {
            repeat: { every: 1 * 60000 },
            jobId: 'update_profiles_nfts_streams',
          })
      case QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS:
        return queues.get(QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS)
          .add(QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS, {
            UPDATE_NON_PROFILES_NFTS_STREAMS: QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS,
            chainId: process.env.CHAIN_ID,
          },
          {
            repeat: { every: 1 * 60000 },
            jobId: 'update_non_profiles_nfts_streams',
          })
      case QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS:
        return queues.get(QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS)
          .add(QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS, {
            UPDATE_PROFILES_WALLET_NFTS_STREAMS: QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS,
            chainId: process.env.CHAIN_ID,
          },
          {
            repeat: { every: 1 * 60000 },
            jobId: 'update_profiles_wallet_nfts_streams',
          })
      // case QUEUE_TYPES.SYNC_COLLECTION_RARITY:
      //   return queues.get(QUEUE_TYPES.SYNC_COLLECTION_RARITY)
      //     .add(QUEUE_TYPES.SYNC_COLLECTION_RARITY, {
      //       SYNC_COLLECTION_RARITY: QUEUE_TYPES.SYNC_COLLECTION_RARITY,
      //       chainId: process.env.CHAIN_ID,
      //     },
      //     {
      //       repeat: { every: 5 * 60000 },
      //       jobId: 'sync_collection_rarity',
      //     })
      // case QUEUE_TYPES.SYNC_SPAM_COLLECTIONS:
      //   return queues.get(QUEUE_TYPES.SYNC_SPAM_COLLECTIONS)
      //     .add(QUEUE_TYPES.SYNC_SPAM_COLLECTIONS, {
      //       SYNC_SPAM_COLLECTIONS: QUEUE_TYPES.SYNC_SPAM_COLLECTIONS,
      //       chainId: process.env.CHAIN_ID,
      //     },
      //     {
      //       repeat: { every: 24 * 60 * 60000 },
      //       jobId: 'sync_spam_collections',
      //     })
      // case QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT:
      //   return queues.get(QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT)
      //     .add(QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT, {
      //       SAVE_PROFILE_EXPIRE_AT: QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT,
      //       chainId: process.env.CHAIN_ID,
      //     },
      //     {
      //       repeat: { every: 24 * 60 * 60000 },
      //       jobId: 'save_profile_expire_at',
      //     })
      // case QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS:
      //   return queues.get(QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS).add(
      //     QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS,
      //     { chainId: process.env.CHAIN_ID }, {
      //       repeat: { every: 10 * 60000 },
      //       jobId: 'sync_profile_gk_owners',
      //     })
      // case QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND:
      //   return queues.get(QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND)
      //     .add(QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND, {
      //       FETCH_EXTERNAL_ORDERS_ON_DEMAND: QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND,
      //       chainId: process.env.CHAIN_ID,
      //     }, {
      //       attempts: 5,
      //       backoff: {
      //         type: 'exponential',
      //         delay: 2000,
      //       },
      //       repeat: { every: 2 * 60000 },
      //       jobId: 'fetch_external_orders_on_demand',
      //     })
      // case QUEUE_TYPES.SYNC_TRADING:
      //   return queues.get(QUEUE_TYPES.SYNC_TRADING).add(QUEUE_TYPES.SYNC_TRADING,
      //     { chainId: process.env.CHAIN_ID }, {
      //       removeOnComplete: true,
      //       removeOnFail: true,
      //       // repeat every 5 minutes
      //       repeat: { every: 5 * 60000 },
      //       jobId: 'sync_trading',
      //     })
      // case QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE:
      //   return queues.get(QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE)
      //     .add(QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE, {
      //       FETCH_COLLECTION_ISSUANCE_DATE: QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE,
      //       chainId: process.env.CHAIN_ID,
      //     }, {
      //       attempts: 5,
      //       backoff: {
      //         type: 'exponential',
      //         delay: 2000,
      //       },
      //       repeat: { every: 12 * 60 * 60000 },
      //       jobId: 'fetch_collection_issuance_date',
      //     })
      // case QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE:
      //   return queues.get(QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE)
      //     .add(QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE, {
      //       removeOnComplete: true,
      //       removeOnFail: true,
      //       repeat: { every: 10 * 60000 },
      //       jobId: 'search_engine_listings_update',
      //     })
      // case QUEUE_TYPES.RECONCILE_ORDERS:
      //   return queues.get(QUEUE_TYPES.RECONCILE_ORDERS)
      //     .add(QUEUE_TYPES.RECONCILE_ORDERS, {
      //       chainId: process.env.CHAIN_ID,
      //     }, {
      //       repeat: { every: ORDER_RECONCILIATION_PERIOD * 60000 },
      //       jobId: 'reconcile_orders',
      //     })
      default:
        logger.info('No job for queue [publishJobs]')
        // return queues.get(chainId).add('default',
        //   { chainId: chainId || process.env.CHAIN_ID }, {
        //     removeOnComplete: true,
        //     removeOnFail: true,
        //     // repeat every 3 minutes
        //     repeat: { every: 3 * 60000 },
        //     jobId: `chainid_${chainId}_job`,
        //   })
      }
    })).then(() => undefined)
  }

  return new Promise(resolve => resolve(undefined))
}

const defaultWorkerOpts = { connection, prefix: queuePrefix }
const listenToJobs = async (): Promise<void> => {
  for (const queue of queues.values()) {
    switch (queue.name) {
    // case QUEUE_TYPES.SYNC_CONTRACTS:
    //   new Worker(queue.name, nftExternalOrders, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_COLLECTION_IMAGES:
    //   new Worker(queue.name, collectionBannerImageSync, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_TRADING:
    //   new Worker(queue.name, syncTrading, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_COLLECTION_NAME:
    //   new Worker(queue.name, collectionNameSync, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_TXS_NFTPORT:
    //   new Worker(queue.name, syncTxsFromNFTPortHandler, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_COLLECTIONS:
    //   new Worker(queue.name, collectionSyncHandler, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_COLLECTION_RARITY:
    //   new Worker(queue.name, raritySync, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_COLLECTION_NFT_RARITY:
    //   new Worker(queue.name, nftRaritySyncHandler, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_SPAM_COLLECTIONS:
    //   new Worker(queue.name, spamCollectionSyncHandler, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.FETCH_EXTERNAL_ORDERS_ON_DEMAND:
    //   new Worker(queue.name, nftExternalOrdersOnDemand, defaultWorkerOpts)
    //   break
    case QUEUE_TYPES.UPDATE_PROFILES_NFTS_STREAMS:
      new Worker(queue.name, updateNFTsOwnershipForProfilesHandler, defaultWorkerOpts)
      break
    case QUEUE_TYPES.UPDATE_PROFILES_WALLET_NFTS_STREAMS:
      new Worker(queue.name, pullNewNFTsHandler, {
        ...defaultWorkerOpts,
        concurrency: 10,
      })
      break
    case QUEUE_TYPES.UPDATE_NON_PROFILES_NFTS_STREAMS:
      new Worker(queue.name, updateNFTsForNonProfilesHandler, {
        ...defaultWorkerOpts,
        concurrency: 10,
      })
      break
    // case QUEUE_TYPES.FETCH_COLLECTION_ISSUANCE_DATE:
    //   new Worker(queue.name, collectionIssuanceDateSync, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SAVE_PROFILE_EXPIRE_AT:
    //   new Worker(queue.name, saveProfileExpireAt, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SYNC_PROFILE_GK_OWNERS:
    //   new Worker(queue.name, profileGKOwnersHandler, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.SEARCH_ENGINE_LISTINGS_UPDATE:
    //   new Worker(queue.name, searchListingIndexHandler, defaultWorkerOpts)
    //   break
    // case QUEUE_TYPES.RECONCILE_ORDERS:
    //   new Worker(queue.name, orderReconciliationHandler, defaultWorkerOpts)
    //   break
    default:
      logger.info(`No worker for default queue ${queue.name}!`)
      // new Worker(queue.name, getEthereumEvents, defaultWorkerOpts)
    }
  }
}

export const cleanupProgressCache = (): Promise<any> => {
  const chainId: string = process.env.CHAIN_ID
  return cache.del([
    `${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`,
    `${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`,
    `${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`,
    `${CacheKeys.PROFILE_WALLET_FAIL_SCORE}_${chainId}`,
  ])
}

export const startAndListen = (): Promise<void> => {
  return createQueues()
    .then(() => getExistingJobs())
    .then((jobs) => checkJobQueues(jobs))
    .then((shouldPublish) => publishJobs(shouldPublish))
    .then(() => cleanupProgressCache())
    .then(() => listenToJobs())
    .then(() => {
      setTimeout(() => {
        didPublish ? logger.info('🍊 queue was restarted -- listening for jobs...')
          : logger.info('🍊 queue is healthy --- listening for jobs...')
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
