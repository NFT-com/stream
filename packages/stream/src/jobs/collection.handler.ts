
import { AxiosInstance, AxiosResponse } from 'axios'
import Bull, { Job } from 'bull'
import { BigNumber } from 'ethers'
import { In } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { nftService } from '@nftcom/gql/service'
import { _logger, db, entity, helper } from '@nftcom/shared'

import { NFTAlchemy } from '../interface'
import { getAlchemyInterceptor } from '../service/alchemy'
import { cache, CacheKeys } from '../service/cache'
import { collectionEntityBuilder, nftEntityBuilder } from '../utils/builder/nftBuilder'
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
  const { contract, chainId, startTokenParam } = job.data
  logger.log(`nft sync handler process started for: ${contract}, chainId: ${chainId}`)
  try {
    const alchemyInstance: AxiosInstance = await getAlchemyInterceptor(chainId)

    // process nfts for collection
    let processCondition = true
    let startToken = Number(startTokenParam) || ''
    let queryParams = `contractAddress=${contract}&withMetadata=true&startToken=${startToken}&limit=100`
    while(processCondition) {
      const collectionNFTs: AxiosResponse = await alchemyInstance
        .get(
          `/getNFTsForCollection?${queryParams}`)

      if (collectionNFTs?.data?.nfts.length) {
        const nfts = collectionNFTs?.data?.nfts
        const nftTokenMap: string[] = nfts.map(
          (nft: NFTAlchemy) => BigNumber.from(nft.id.tokenId).toHexString())
        const existingNFTs: entity.NFT[] = await repositories.nft.find(
          { where: { contract: helper.checkSum(contract), tokenId: In(nftTokenMap), chainId } },
        )
        const existingNFTTokenMap: string[] = existingNFTs.map(
          (nft: entity.NFT) => BigNumber.from(nft.tokenId).toHexString())
          
        const nftPromiseArray: entity.NFT[] = []
        const alchemyNFTs: NFTAlchemy[] = nfts

        for (const nft of alchemyNFTs) {
          // create if not exist, update if does
          if (!existingNFTTokenMap.includes(BigNumber.from(nft.id.tokenId).toHexString())) {
            nftPromiseArray.push(nftEntityBuilder(nft, chainId))
          }
        }

        try {
          if (nftPromiseArray?.length > 0) {
            await nftService.indexNFTsOnSearchEngine(nftPromiseArray)
            await repositories.nft.saveMany(nftPromiseArray, { chunk: 50 }) // temp chunk
            logger.log(`saved ${queryParams}`)
          }
  
          if (!collectionNFTs?.data?.nextToken) {
            processCondition = false
          } else {
            startToken = collectionNFTs?.data?.nextToken
            queryParams = `contractAddress=${contract}&withMetadata=true&startToken=${startToken}&limit=100`
          }
        } catch (errSave) {
          logger.log(`error while saving nftSyncHandler but continuing ${errSave}...${startToken}...${queryParams}`)
          logger.log(`error nftPromiseArray: ${nftPromiseArray}`)
          logger.log(`error existing: ${existingNFTs}`)

          if (!collectionNFTs?.data?.nextToken) {
            processCondition = false
          } else {
            startToken = collectionNFTs?.data?.nextToken
            queryParams = `contractAddress=${contract}&withMetadata=true&startToken=${startToken}&limit=100`
          }
        }
      }
    }
    // remove from in progress cache
    // move to recently refreshed cache
    await cache.srem(`${CacheKeys.SYNC_IN_PROGRESS}_${chainId}`, contract)
    await cache.sadd(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, contract)
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
  const startTokenParam: string = job.data.startTokenParam
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  try {
    // check recently imported
    // check in progress
    const contractEntitiesToBeProcessed: Promise<Partial<entity.Collection>>[] = []
    const contractsToBeProcessed: string[] = []
    const contractToBeSaved: Promise<Partial<entity.Collection>>[] = []
    const existsInDB: entity.Collection[] = await repositories.collection.find({
      where: {
        contract: In(collections),
      },
    })

    for (let i = 0; i < collections.length; i++) {
      const contract: string = collections[i]
      const itemPresentInRefreshedCache: number = await cache.sismember(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, contract)
      if (itemPresentInRefreshedCache) {
        continue
      }

      const itemPresentInProgressCache: number = await cache.sismember(`${CacheKeys.SYNC_IN_PROGRESS}_${chainId}`, contract)
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
          contractToBeSaved.push(collectionEntityBuilder(
            contract,
            chainId,
          ))
        }
      } else {
        if (isSpam) {
          await repositories.collection.updateOneById(contractExistsInDB.id,
            { ...contractExistsInDB, isSpam: true },
          )
        } else {
          contractEntitiesToBeProcessed.push(collectionEntityBuilder(
            contract,
            chainId,
          ))
          contractsToBeProcessed.push(contract) // full resync (for cases where collections already exist, but we want to fetch all the NFTs)
        }
      }
    }

    if (contractsToBeProcessed.length) {
      // move to in progress cache
      await cache.sadd(CacheKeys.SYNC_IN_PROGRESS, ...contractsToBeProcessed)
      Promise.all(contractToBeSaved)
        .then(
          (collections: entity.Collection[]) =>
            repositories.collection.saveMany(collections),
        )
        .then(
          (savedCollections: entity.Collection[]) => {
            const collections: string[] = savedCollections.map(
              (savedCollection: entity.Collection) => savedCollection.id,
            )
            logger.log(`Collections Saved: ${collections.join(', ')}`)
          })
      // run process
      for (let i = 0; i < contractEntitiesToBeProcessed.length; i++) {
        const contract: string = contractsToBeProcessed?.[i]
        // build queues
        const jobId = `collection-nft-batch-processor-collection|contract:${contract}-chainId:${chainId}-startTokenParam:${startTokenParam}`
        const job: Bull.Job = await collectionSyncSubqueue.getJob(jobId)

        if (!job || !job?.isActive() || !job?.isWaiting()) {
          collectionSyncSubqueue.add(
            { contract, chainId, startTokenParam },
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