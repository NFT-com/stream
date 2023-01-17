
import { AxiosInstance, AxiosResponse } from 'axios'
import Bull, { Job } from 'bull'
import { BigNumber } from 'ethers'
import { FindOptionsWhere,ILike, In, IsNull, Not } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { nftService } from '@nftcom/gql/service'
import { _logger, db, defs, entity, helper } from '@nftcom/shared'

import { NFT_NftPort, NFTAlchemy } from '../interface'
import { CollectionType, SyncCollectionInput } from '../middleware/validate'
import { getAlchemyInterceptor } from '../service/alchemy'
import { cache, CacheKeys, removeExpiredTimestampedZsetMembers, ttlForTimestampedZsetMembers } from '../service/cache'
import { getEtherscanInterceptor } from '../service/etherscan'
import { getNFTPortInterceptor, NFTPortNFT, retrieveContractNFTsNFTPort, retrieveNFTDetailsNFTPort } from '../service/nftPort'
import { delay } from '../utils'
import { collectionEntityBuilder, nftEntityBuilder, nftEntityBuilderCryptoPunks, nftTraitBuilder } from '../utils/builder/nftBuilder'
import { uploadImageToS3 } from '../utils/uploader'
import { collectionSyncSubqueue } from './jobs'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()
const CRYPTOPUNK = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb'

const exceptionBannerUrls: string[] = [
  'https://cdn.nft.com/collections/1/%banner.png',
  'https://cdn.nft.com/collections/1/%banner.jpg',
  'https://cdn.nft.com/collections/1/%banner.jpeg',
  'https://cdn.nft.com/collectionBanner_default.png',
]

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
    const nftPortInstance: AxiosInstance = await getNFTPortInterceptor('https://api.nftport.xyz/v0')
  
    // nft port specific sync
    if (contract?.toLowerCase() == CRYPTOPUNK) {
      // process nfts for collection
      let processCondition = true
      let startPage = 1

      let queryParams = `chain=ethereum&page_number=${startPage}&page_size=50&include=metadata&refresh_metadata=false`
      while(processCondition) {
        const collectionNFTs: AxiosResponse = await nftPortInstance
          .get(
            `/nfts/${contract}?${queryParams}`)

        logger.log(`=============== nft sync handler nftport: ${collectionNFTs?.data?.nfts.length}`)

        if (collectionNFTs?.data?.nfts.length) {
          const nfts = collectionNFTs?.data?.nfts
          const nftTokenMap: string[] = nfts.map(
            (nft: NFT_NftPort) => BigNumber.from(nft.token_id).toHexString())

          logger.log(`=============== nft sync handler nftTokenMap: ${JSON.stringify(nftTokenMap)}`)

          const existingNFTs: entity.NFT[] = await repositories.nft.find(
            { where: { contract: helper.checkSum(contract), tokenId: In(nftTokenMap), chainId } },
          )
          const existingNFTTokenMap: string[] = existingNFTs.map(
            (nft: entity.NFT) => BigNumber.from(nft.tokenId).toHexString())

          logger.log(`=============== nft sync handler existingNFTTokenMap: ${JSON.stringify(existingNFTTokenMap)}`)
            
          const nftPromiseArray: entity.NFT[] = []
          const nftPortNfts: NFT_NftPort[] = nfts

          for (const nft of nftPortNfts) {
            // create if not exist, update if does
            if (!existingNFTTokenMap.includes(BigNumber.from(nft.token_id).toHexString())) {
              nftPromiseArray.push(nftEntityBuilderCryptoPunks(nft, chainId))
            }
          }

          logger.log(`nftPromiseArray?.length: ${nftPromiseArray?.length}`)

          try {
            if (nftPromiseArray?.length > 0) {
              await nftService.indexNFTsOnSearchEngine(nftPromiseArray)
              await repositories.nft.saveMany(nftPromiseArray, { chunk: 50 }) // temp chunk
              logger.log(`saved ${queryParams}`)
            }
    
            startPage += 1
            queryParams = `chain=ethereum&page_number=${startPage}&page_size=50&include=metadata&refresh_metadata=false`
          } catch (errSave) {
            logger.log(`error while saving nftSyncHandler but continuing ${errSave}...${startPage}...${queryParams}`)
            logger.log(`error nftPromiseArray: ${nftPromiseArray}`)
            logger.log(`error existing: ${existingNFTs}`)

            startPage += 1
            queryParams = `chain=ethereum&page_number=${startPage}&page_size=50&include=metadata&refresh_metadata=false`
          }
        } else {
          // no nfts found
          processCondition = false
        }
      }
    } else {
      // process nfts for collection
      let processCondition = true
      let startToken = Number(startTokenParam) || ''
      let queryParams = `contractAddress=${contract}&withMetadata=true&startToken=${startToken}&limit=100`
      while(processCondition) {
        const collectionNFTs: AxiosResponse = await alchemyInstance
          .get(
            `/getNFTsForCollection?${queryParams}`)

        logger.log('collectionNFTs', collectionNFTs)
        if (collectionNFTs?.data?.nfts.length) {
          const nfts = collectionNFTs?.data?.nfts
          const nftTokenMap: string[] = nfts.map(
            (nft: NFTAlchemy) => BigNumber.from(nft.id.tokenId).toHexString())
          const existingNFTs: entity.NFT[] = await repositories.nft.find(
            { where: { contract: helper.checkSum(contract), tokenId: In(nftTokenMap), chainId } },
          )
          // const existingNFTTokenMap: string[] = existingNFTs.map(
          //   (nft: entity.NFT) => BigNumber.from(nft.tokenId).toHexString())
            
          const nftPromiseArray: entity.NFT[] = []
          const alchemyNFTs: NFTAlchemy[] = nfts
          
          for (const nft of alchemyNFTs) {
            logger.log('alchemyNFT', nft)
            // create if not exist, update if does
            //if (!existingNFTTokenMap.includes(BigNumber.from(nft.id.tokenId).toHexString())) {
            nftPromiseArray.push(nftEntityBuilder(nft, chainId))
            //}
          }

          logger.log('nft promise array', nftPromiseArray)
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
            // logger.log(`error nftPromiseArray: ${nftPromiseArray}`)
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
    }
    // remove from in progress cache
    // move to recently refreshed cache
    await cache.srem(`${CacheKeys.SYNC_IN_PROGRESS}_${chainId}`, contract + `${Number(startTokenParam) || ''}`)
    await cache.sadd(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, contract + `${Number(startTokenParam) || ''}`)

    const zscoreOfContractInRefreshCache: string = await cache.zscore(
      `${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, contract,
    )
    const zscoreOfContractInRefreshedCache: string = await cache.zscore(
      `${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, contract,
    )
    const ttl = Number(zscoreOfContractInRefreshedCache)
    const expiredInRefreshedCache: boolean = new Date() > new Date(ttl)

    if(!Number(zscoreOfContractInRefreshCache) && expiredInRefreshedCache) {
      // rarity process
      await cache.zadd(
        `${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`,
        1, contract,
      )
    }
    // process subqueues in series; hence concurrency is explicitly set to one for rate limits
    // nftSyncSubqueue.process(1, nftBatchPersistenceHandler)
    logger.log(`nft sync handler process completed for: ${contract}, chainId: ${chainId}`)
  } catch (err) {
    logger.error(`Error in nft sync handler for: ${contract}, chainId: ${chainId} --- err: ${err}`)
  }
}

export const collectionSyncHandler = async (job: Job): Promise<void> => {
  logger.log('initiated collection sync')
  const collections: SyncCollectionInput[] = job.data.collections
  const filteredCollections: string[] = collections.map(i => i.address)
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  try {
    // check recently imported
    // check in progress
    const contractInput: SyncCollectionInput[] = []
    const contractsToBeProcessed: string[] = []
    const contractToBeSaved: Promise<Partial<entity.Collection>>[] = []
    const existsInDB: entity.Collection[] = await repositories.collection.find({
      where: {
        contract: In(filteredCollections),
      },
    })

    for (let i = 0; i < collections.length; i++) {
      const contract: string = collections[i].address
      const startTokenParam: string = collections[i]?.startToken || ''
      const itemPresentInRefreshedCache: number = await cache.sismember(`${CacheKeys.RECENTLY_SYNCED}_${chainId}`, contract + startTokenParam)
      if (itemPresentInRefreshedCache) {
        continue
      }

      const itemPresentInProgressCache: number = await cache.sismember(`${CacheKeys.SYNC_IN_PROGRESS}_${chainId}`, contract + startTokenParam)
      if (itemPresentInProgressCache) {
        continue
      }
      // check collection spam (Alchemy cache)
      const contractExistsInDB: entity.Collection = existsInDB.filter(
        (collection: entity.Collection) => collection.contract === contract,
      )?.[0]

      const collectionType: string = collections[i].type
      const isSpamFromInput: boolean = collectionType === CollectionType.SPAM
      const isSpamFromCache: number = await cache.sismember(
        CacheKeys.SPAM_COLLECTIONS, contract + startTokenParam,
      )
      const isOfficial: boolean = collectionType === CollectionType.OFFICIAL
      const isSpam: boolean = Boolean(isSpamFromCache) || isSpamFromInput
      if (!contractExistsInDB) {
        if(!isSpam) {
          // for v2,  checks for collection type and runs when official; for v1 endpoint, runs for triggered collections
          if (collectionType && isOfficial || !collectionType) {
            contractInput.push(collections[i])
            contractsToBeProcessed.push(contract + startTokenParam)
          }
        }

        contractToBeSaved.push(collectionEntityBuilder(
          contract,
          isOfficial,
          isSpam,
          chainId,
        ))
      } else {
        if (isSpam) {
          await repositories.collection.updateOneById(contractExistsInDB.id,
            { ...contractExistsInDB, isSpam: true, isOfficial: false },
          )
        } else {
          if (collectionType && isOfficial || !collectionType) {
            if (collectionType) {
              if (isOfficial) {
                const updatedCollection: Partial<entity.Collection> = {
                  ...contractExistsInDB, isSpam: false, isOfficial: true,
                }
                await repositories.collection.updateOneById(contractExistsInDB.id,
                  { ...updatedCollection },
                )
                await nftService.indexCollectionsOnSearchEngine([updatedCollection])
              } else {
                const updatedCollection: Partial<entity.Collection> = {
                  ...contractExistsInDB, isSpam: false, isOfficial: false,
                }
                await repositories.collection.updateOneById(contractExistsInDB.id,
                  { ...updatedCollection },
                )
                await nftService.indexCollectionsOnSearchEngine([updatedCollection])
              }
            }
           
            contractInput.push(collections[i])
            contractsToBeProcessed.push(contract + startTokenParam) // full resync (for cases where collections already exist, but we want to fetch all the NFTs)
          }
        }
      }
    }

    if (contractToBeSaved.length) {
      Promise.all(contractToBeSaved)
        .then(
          (collections: entity.Collection[]) =>
            repositories.collection.saveMany(collections, { chunk: 100 }),
        )
        .then(
          (savedCollections: entity.Collection[]) => {
            const collections: string[] = savedCollections.map(
              (savedCollection: entity.Collection) => savedCollection.id,
            )
            logger.log(`Collections Saved: ${collections.join(', ')}`)
            nftService.indexCollectionsOnSearchEngine(savedCollections)
          })
        .then(() => logger.log('Collections Indexed!'))
        .catch(err => logger.error(err, 'Collection Sync error while saving or indexing collections'))
    }
    if (contractsToBeProcessed.length) {
      // move to in progress cache
      await cache.sadd(CacheKeys.SYNC_IN_PROGRESS, ...contractsToBeProcessed)
      // run process
      for (let i = 0; i < contractInput.length; i++) {
        const contract: string = contractInput?.[i]?.address
        const startTokenParam: string = contractInput?.[i]?.startToken || ''
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

export const collectionIssuanceDateSync = async (job: Job): Promise<void> => {
  logger.log('initiating collection issuance sync')
  const chainId: string = job?.data?.chainId || process.env.CHAIN_ID || '5'

  try {
    const processedContracts: string[] = await cache.smembers(
      CacheKeys.COLLECTION_ISSUANCE_DATE,
    )
    const progressContracts: string[] = await cache.smembers(
      CacheKeys.COLLECTION_ISSUANCE_DATE_IN_PROGRESS,
    )
    const cachedContracts: string[] = [...processedContracts, ...progressContracts]
    // official collection
    const collections: entity.Collection[] = await repositories.collection.find({
      where: {
        issuanceDate: null,
        chainId,
        contract: Not(In(cachedContracts)),
      },
      select: {
        id: true,
        contract: true,
      },
    })
  
    let count = 0
    const updatedCollections: Partial<entity.Collection>[] = []
    const etherscanInterceptor = getEtherscanInterceptor(chainId)
    for (const collection of collections) {
      const collectionInCache: number = await cache.sismember(
        CacheKeys.COLLECTION_ISSUANCE_DATE, collection.contract,
      )
      const collectionInProgressCache: number = await cache.sismember(
        CacheKeys.COLLECTION_ISSUANCE_DATE_IN_PROGRESS, collection.contract,
      )
      // if collection does not have issuance date, process
      if (!collectionInCache && !collectionInProgressCache) {
        await cache.sadd(CacheKeys.COLLECTION_ISSUANCE_DATE_IN_PROGRESS, collection.contract)
        const response: AxiosResponse = await etherscanInterceptor.get('/', {
          params: {
            module: 'account',
            action: 'txlist',
            address: collection.contract,
            page: '1',
            offset: '1',
            startblock: '0',
            block: '99999999',
            sort: 'asc',
          } })
        if (response?.data) {
          const issuanceDateTimeStamp: string = response?.data?.result?.[0]?.timeStamp
          if (issuanceDateTimeStamp) {
            const issuanceDate = new Date(Number(issuanceDateTimeStamp) * 1000)
            updatedCollections.push({ ...collection, issuanceDate })
            await cache.srem(CacheKeys.COLLECTION_ISSUANCE_DATE_IN_PROGRESS, collection.contract)
          }
        }
        count++
        if (count === 5) {
          await delay(1000)
        }
      }
  
      // for efficient memory storage, process persistence in batches of 1000
      if (updatedCollections.length >= 500) {
        await repositories.collection.saveMany(updatedCollections, { chunk: 100 })
        await nftService.indexCollectionsOnSearchEngine(updatedCollections)
        const cacheContracts: string[] = updatedCollections.map(
          (item: entity.Collection) => item.contract,
        )
        await cache.sadd(CacheKeys.COLLECTION_ISSUANCE_DATE, ...cacheContracts)
      }
    }
  
    if (updatedCollections.length) {
      await repositories.collection.saveMany(updatedCollections, { chunk: 100 })
      await nftService.indexCollectionsOnSearchEngine(updatedCollections)
      const cacheContracts: string[] = updatedCollections.map(
        (item: entity.Collection) => item.contract,
      )
      await cache.sadd(CacheKeys.COLLECTION_ISSUANCE_DATE, ...cacheContracts)
    }
  } catch (err) {
    logger.error(`Error in collection issuance sync: ${err}`)
  }
  logger.log('completed collection issuance sync')
}

const indexNFTs = async (nfts: Partial<entity.NFT>[]): Promise<void> => {
  if (nfts?.length) {
    try {
      await nftService.indexNFTsOnSearchEngine(nfts)
      await repositories.nft.saveMany(nfts, { chunk: 50 }) // temp chunk
    } catch(err) {
      logger.error(`Error while indexing nfts: ${err}`)
    }
  }
}

// collection image sync
export const collectionBannerImageSync = async (job: Job): Promise<void> => {
  logger.log('initiated collection banner image sync')
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  const queryFilters = exceptionBannerUrls.map((exceptionBannerUrl: string) =>
    ({ bannerUrl: ILike(exceptionBannerUrl) }))
  try {
    const collections: Partial<entity.Collection>[] = await repositories.collection.find(
      {
        where:[
          { bannerUrl: IsNull() },
          ...queryFilters,
        ],
        select: {
          id: true,
          contract: true,
          bannerUrl: true,
          chainId: true,
        },
      })

    for (const collection of collections) {
      try {
        const contractNFT: Partial<entity.NFT> = await repositories.nft.findOne({
          where: {
            contract: collection?.contract,
            chainId: collection.chainId || chainId,
          },
          select: {
            tokenId: true,
            metadata: {
              imageURL: true,
            },
          },
        })

        if (collection?.contract && contractNFT?.tokenId) {
          let result
          try {
            result = await retrieveNFTDetailsNFTPort(
              collection.contract,
              contractNFT.tokenId,
              chainId,
              false,
              [],
            )
          } catch (err) {
            logger.error(`Error while fetching NFT details from NFT Port for contract: 
                  ${collection.contract} and tokenId: ${contractNFT.tokenId}`)
          }
  
          let bannerUrl: string = null
          const uploadPath = `collections/${chainId}/`
          //  NFT Port Collection Image
          if (result?.contract?.metadata?.cached_banner_url) {
            bannerUrl = result.contract.metadata.cached_banner_url
          } else if (result?.nft?.cached_file_url) {
            bannerUrl = result.nft.cached_file_url
          } else if (contractNFT?.metadata?.imageURL) {
            bannerUrl = contractNFT.metadata.imageURL
          }
  
          if (bannerUrl) {
            const filename = bannerUrl.split('/').pop()
            const banner = await uploadImageToS3(
              bannerUrl,
              filename,
              chainId,
              collection.contract,
              uploadPath,
            )
            bannerUrl = banner ? banner : bannerUrl
            await repositories.collection.updateOneById(collection.id, {
              bannerUrl,
            })
          }
        }
      } catch (err) {
        logger.error(`Error occured while fetching contract NFT for ${collection.contract}: ${err}`)
      }
    }
  } catch (err) {
    logger.log(`Error in collection banner image sync: ${err}`)
  }
  logger.log('completed collection banner image sync')
}

// collection image sync
export const collectionNameSync = async (job: Job): Promise<void> => {
  logger.log('initiated collection name sync')
  const chainId: string = job.data.chainId
  const contract: string = job.data.contract
  const official: string = job.data.official
  try {
    let filters: FindOptionsWhere<any> = {
      isSpam: false,
      chainId,
    }
  
    if (contract !== undefined && contract !== null) {
      filters = { ...filters, contract: helper.checkSum(contract) }
    }
  
    if (official !== undefined && official !== null) {
      filters = { ...filters, isOfficial: Boolean(official) }
    }
  
    const collections: entity.Collection[] = await repositories.collection.find({
      where: {
        ...filters,
      },
    })

    // initiate web3
    nftService.initiateWeb3(chainId)
    let updatedCollections: entity.Collection[] = []

    for (const collection of collections) {
      // get collection info
      let collectionName = await nftService.getCollectionNameFromDataProvider(
        collection.contract,
        chainId,
        defs.NFTType.ERC721,
      )

      if (collectionName === 'Unknown Name') {
        collectionName = await nftService.getCollectionNameFromDataProvider(
          collection.contract,
          chainId,
          defs.NFTType.ERC1155,
        )
      }
      collection.name = collectionName
      updatedCollections.push(collection)

      if (updatedCollections.length >= 100) {
        await repositories.collection.saveMany(updatedCollections, { chunk: 100 })
        await nftService.indexCollectionsOnSearchEngine(updatedCollections)
        updatedCollections = []
      }
    }

    if (updatedCollections.length) {
      await repositories.collection.saveMany(updatedCollections, { chunk: 100 })
      await nftService.indexCollectionsOnSearchEngine(updatedCollections)
    }
  } catch (err) {
    logger.log(`Error in collection name sync: ${err}`)
  }
  logger.log('completed collection name sync')
}

export const raritySync = async (job: Job): Promise<void> => {
  logger.log('initiated rarity sync')
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  try {
    await removeExpiredTimestampedZsetMembers(
      `${CacheKeys.REFRESHED_NFT_ORDERS_EXT}_${chainId}`,
      Date.now(),
    )
    const cachedContracts = await cache.zrevrangebyscore(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, '+inf', '(0')
    if(cachedContracts?.length) {
      // loop
      for (const contract of cachedContracts) {
        const existsInRefreshedCache: string = await cache.zscore(`${CacheKeys.REFRESHED_COLLECTION_RARITY}_${chainId}`, contract)

        if (Number(existsInRefreshedCache)) {
          const ttlNotExpired: boolean = Date.now() < Number(existsInRefreshedCache)
          if (ttlNotExpired) {
            await cache.zrem(`${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, contract)
            logger.log(`Contract ${contract} was recently synced`)
            return
          }
        }
        let processCondition = true
        let page = 1
        let rateLimitDelayCounter = 0
        let nftPromiseArray: Partial<entity.NFT>[] = []
        while(processCondition) {
          const nftPortResult = await retrieveContractNFTsNFTPort(
            contract,
            chainId,
            false,
            page,
            ['rarity'],
          )

          if (nftPortResult?.nfts?.length) {
            const nfts = nftPortResult?.nfts
            const nftTokenMap: string[] = nfts.map(
              (nft: NFT_NftPort) => BigNumber.from(nft.token_id).toHexString())
  
            logger.log(`=============== nft sync handler nftTokenMap: ${JSON.stringify(nftTokenMap)}`)
  
            const existingNFTs: entity.NFT[] = await repositories.nft.find(
              { where: {
                contract: helper.checkSum(contract),
                tokenId: In(nftTokenMap),
                chainId,
                rarity: IsNull(),
              },
              select: {
                id: true,
                tokenId: true,
                metadata: true,
              },
              },
            )

            if (existingNFTs?.length) {
              for (const nft of nfts) {
                // create if not exist, update if does
                const processNFT: entity.NFT = existingNFTs.find(
                  (existingNft: entity.NFT) => {
                    if( existingNft.tokenId === BigNumber.from(nft.token_id).toHexString()) {
                      return {
                        ...existingNft,
                      }
                    }
                  })
  
                if (processNFT?.id) {
                  let updatedNFT: Partial<entity.NFT> = { id: processNFT?.id }
                  // update NFT raritys
                  updatedNFT = {
                    ...updatedNFT,
                    rarity: nft?.rarity?.score || '0',
                    metadata: {
                      ...processNFT?.metadata,
                      traits: nftTraitBuilder(processNFT?.metadata?.traits, nft?.attributes),
                    },
                  }

                  nftPromiseArray.push(updatedNFT)
                }

                try {
                  if (nftPromiseArray?.length > 5) {
                    await indexNFTs(nftPromiseArray)
                    nftPromiseArray = []
                  }
                } catch (errSave) {
                  logger.log(`error while saving nftSyncHandler but continuing ${errSave}...${page}`)
                }
              }
    
              logger.log(`nftPromiseArray?.length: ${nftPromiseArray?.length}`)
    
              try {
                if (nftPromiseArray?.length) {
                  await indexNFTs(nftPromiseArray)
                  nftPromiseArray = []
                }
              } catch (errSave) {
                logger.log(`error while saving nftSyncHandler but continuing ${errSave}...${page}`)
              }
            }

            page += 1
          } else {
            // no nfts found
            processCondition = false
          }

          rateLimitDelayCounter++

          if (rateLimitDelayCounter === 99) {
            await delay(1000)
          }
        }

        try {
          if (nftPromiseArray?.length) {
            await indexNFTs(nftPromiseArray)
            nftPromiseArray = []
          }
        } catch (errSave) {
          logger.log(`error while saving nftSyncHandler but continuing ${errSave}...${page}`)
        }

        // remove contract from cache in either scenario
        const date = new Date()
        date.setHours(date.getHours() + 2) // two hours ttl
        const ttl: number = ttlForTimestampedZsetMembers(date)
        await Promise.all([
          cache.zadd(
            `${CacheKeys.REFRESHED_COLLECTION_RARITY}_${chainId}`,
            ttl, contract,
          ),
          cache.zremrangebyscore(
            `${CacheKeys.REFRESH_COLLECTION_RARITY}_${chainId}`, 1, '+inf',
          ),
        ])
      }
    }
  } catch (err) {
    logger.log(`Error in rarity sync: ${err}`)
  }
  logger.log('completed rarity sync')
}

export const nftRaritySyncHandler = async (job: Job): Promise<void> => {
  logger.log('Nft rarity sync started')
  const chainId: string = job.data.chainId || process.env.CHAIN_ID
  const contract: string = job.data.contract ? helper.checkSum(job.data.contract) : ''
  const tokenIds: string[] = job.data.tokenIds

  if (contract) {
    const collection: entity.Collection = await repositories.collection.findOne({
      where: { contract },
    })
    if (collection.isOfficial) {
      let filter = { where: { contract, rarity: IsNull() } }
      if (tokenIds.length) {
        const tokenHexMap: string[] = tokenIds.map(
          (tokenId: string) => helper.bigNumberToHex(tokenId),
        )
        filter = { ...filter, tokenId: In(tokenHexMap) } as any
      }
      const nftsWithNullRarity: entity.NFT[] = await repositories.nft.find(filter)
      if (nftsWithNullRarity?.length) {
        for (const nft of nftsWithNullRarity) {
          const nftPortNFT: NFTPortNFT = await retrieveNFTDetailsNFTPort(
            contract,
            helper.bigNumberToNumber(nft?.tokenId).toString(),
            chainId,
            false,
            ['rarity', 'attributes'],
          )

          let rarity = '0', traits: defs.Trait[] = nft.metadata.traits

          if (nftPortNFT?.nft?.rarity?.score) {
            rarity = String(nftPortNFT?.nft?.rarity?.score)
          }

          if (nftPortNFT?.nft?.attributes) {
            traits = nftTraitBuilder(traits, nftPortNFT?.nft?.attributes)
          }

          await repositories.nft.updateOneById(nft.id, {
            rarity,
            metadata: { ...nft.metadata, traits },
          })
        }
      }
    } else {
      logger.log('Collection provided to nft rarity sync is not official')
    }
  } else {
    logger.log('No contract provided to nft rarity sync')
  }
}

