
import { AxiosInstance, AxiosResponse } from 'axios'
import Bull, { Job } from 'bull'
import { In } from 'typeorm'

import { _logger, db, entity } from '@nftcom/shared'

import { getAlchemyInterceptor } from '../alchemy'
import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from '../cache'
import { NFTAlchemy } from '../interfaces'
import { collectionEntityBuilder, nftEntityBuilder } from '../utils/nftBuilder'
import { collectionSyncSubqueue } from './jobs'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const subQueueBaseOptions: Bull.JobOptions = {
  attempts: 2,
  removeOnComplete: true,
  removeOnFail: true,
  backoff: {
    type: 'fixed',
    delay: 1000,
  },
}

export const nftSyncHandler = async (job: Job): Promise<void> => {
  const { contract, chainId } = job.data
  logger.log(`nft sync handler process started for: ${contract}, chainId: ${chainId}`)
  try {
    const alchemyInstance: AxiosInstance = await getAlchemyInterceptor(chainId)
    // process nfts for collection
    let processCondition = true
    let startToken = ''
    const queryParams = `contractAddress=${contract}&withMetadata=true&startToken=${startToken}&limit=100`
    while(processCondition) {
      const collectionNFTs: AxiosResponse = await alchemyInstance
        .get(
          `/getNFTsForCollection?${queryParams}`)
      if(collectionNFTs?.data?.nfts.length) {
        const nfts = collectionNFTs?.data?.nfts
        const nftTokenMap: string[] = nfts.map((nft: NFTAlchemy) => nft.id.tokenId)
        const existingNFTs: entity.NFT[] = await repositories.nft.find(
          { where: { contract, tokenId: In(nftTokenMap) } },
        )
        const existingNFTTokenMap: string[] = existingNFTs.map((nft: entity.NFT) => nft.tokenId)
        const nftPromiseArray: entity.NFT[] = []
        const alchemyNFTs: NFTAlchemy[] = nfts

        for (const nft of alchemyNFTs) {
          // create if not exist, update if does
          if (!existingNFTTokenMap.includes(nft.id.tokenId)) {
            nftPromiseArray.push(nftEntityBuilder(nft))
          }
        }
        await repositories.nft.saveMany(nftPromiseArray)

        if(!collectionNFTs?.data?.nextToken) {
          processCondition = false
        } else {
          startToken = collectionNFTs?.data?.nextToken
        }
      }
    }
    // remove from in progress cache
    // move to recently refreshed cache
    await Promise.all([
      cache.srem(`${CacheKeys.SYNC_IN_PROGRESS}_${chainId}`, contract),
      cache.zadd(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, Date.now(), contract),
    ])
    // process subqueues in series; hence concurrency is explicitly set to one for rate limits
    // nftSyncSubqueue.process(1, nftBatchPersistenceHandler)
    logger.log(`nft sync handler process completed for: ${contract}, chainId: ${chainId}`)
  } catch (err) {
    logger.error(`Error in nft sync handler for: ${contract}, chainId: ${chainId} --- err: ${err}`)
  }
}

export const collectionSyncHandler = async (job: Job): Promise<void> => {
  logger.log('initiated collection sync')
  const collections: string[] = job.data.collections
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  try {
    // remove expired
    await removeExpiredTimestampedZsetMembers(
      `${CacheKeys.RECENTLY_SYNCED}_${chainId}`,
      Date.now(),
    )
    // check recently imported

    // check in progress
    const contractEntitiesToBeProcessed: Promise<Partial<entity.Collection>>[] = []
    const contractsToBeProcessed: string[] = []
    const existsInDB: entity.Collection[] = await repositories.collection.find({
      where: {
        contract: In(collections),
      },
    })

    for (let i = 0; i < collections.length; i++) {
      const contract: string = collections[i]
      const itemPresentInRefreshedCache: string = await cache.zscore(`${CacheKeys.REFRESHED_NFT_ORDERS_EXT}_${chainId}`, contract)
      if (itemPresentInRefreshedCache) {
        continue
      }

      const itemPresentInProgressCache: number = await cache.sismember(`${CacheKeys.REFRESHED_NFT_ORDERS_EXT}_${chainId}`, contract)
      if (itemPresentInProgressCache) {
        continue
      }
      // check collection spam (Alchemy cache)
      const contractExistsInDB: entity.Collection = existsInDB.filter(
        (collection: entity.Collection) => collection.contract === contract,
      )?.[0]
      const isSpam: number = await cache.sismember(CacheKeys.SPAM_COLLECTIONS, contract)
      if (!contractExistsInDB) {
        if(!isSpam) {
          contractEntitiesToBeProcessed.push(collectionEntityBuilder(
            contract,
            chainId,
          ))
          contractsToBeProcessed.push(contract)
        }
      } else {
        if(isSpam) {
          await repositories.collection.updateOneById(contractExistsInDB.id,
            { ...contractExistsInDB, isSpam: true },
          )
        }
      }
    }

    if (contractsToBeProcessed.length) {
      // move to in progress cache
      await cache.sadd(CacheKeys.SYNC_IN_PROGRESS, ...contractsToBeProcessed)
      Promise.all(contractEntitiesToBeProcessed)
        .then(
          (collections: entity.Collection[]) =>
            repositories.collection.saveMany(collections),
        )
        .then(
          (savedCollections: entity.Collection[]) => {
            console.log('saved', savedCollections)
            const collections: string[] = savedCollections.map(
              (savedCollection: entity.Collection) => savedCollection.id,
            )
            logger.log(`Collections Saved: ${collections.join(', ')}`)
          })
      // run process
      for (let i = 0; i < contractEntitiesToBeProcessed.length; i++) {
        const contract: string = contractsToBeProcessed?.[i]
        // build queues
        const jobId = `collection-nft-batch-processor-collection|contract:${contract}-chainId:${chainId}`
        const job: Bull.Job = await collectionSyncSubqueue.getJob(jobId)

        if (!job || !job?.isActive() || !job?.isWaiting()) {
          collectionSyncSubqueue.add(
            { contract, chainId },
            {
              ...subQueueBaseOptions,
              jobId,
            },
          )
        }
              
        if (job) {
          // clean up
          if (job.isStuck() || job.isPaused() || job.isDelayed() || job.isCompleted()) {
            logger.log(`Stack trace: ${job.stacktrace}`)
            await job.remove()
          }
    
          if (job.isFailed()) {
            logger.log(`Failed reason for jobId-${job.id}: ${job.failedReason}`)
            logger.log(`Stack trace: ${job.stacktrace}`)
            await job.remove()
          }
        }
      }
      // const process = collectionSyncSubqueue.getJobCounts()
      // process subqueues in series; hence concurrency is explicitly set to one for rate limits
      collectionSyncSubqueue.process(1, nftSyncHandler)
    }
    logger.log('completed collection sync')
  } catch (err) {
    logger.error(`Error in collectionSyncHandler: ${err}`)
  }
}

// export const nftBatchPersistenceHandler = async (job: Job): Promise<void> => {
//     const { contract, nfts, chainId } = job.data
//     console.log('here')
//     logger.log(`nft batch persistence handler process started for: ${contract}, chainId: ${chainId}`)

//     try {
     
//     } catch (err) {
//         logger.error(`Error in nft persistence handler for: ${contract}, chainId: ${chainId} --- err: ${err}`)
//     }
// }

export const spamCollectionSyncHandler = async (job: Job): Promise<void> => {
  logger.log('initiated spam collection sync')
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  const alchemyInstance: AxiosInstance = await getAlchemyInterceptor(chainId)
    
  try {
    const spamCollectionsResponse: AxiosResponse = await alchemyInstance.get('/getSpamContracts')
    if (spamCollectionsResponse?.data?.length) {
      const spamCollections: string[] = spamCollectionsResponse?.data
      await cache.sadd(CacheKeys.SPAM_COLLECTIONS, ...spamCollections)
    }
    logger.log('completed spam collection sync')
  } catch (err) {
    logger.log(`Error in spam collection sync: ${err}`)
  }
}