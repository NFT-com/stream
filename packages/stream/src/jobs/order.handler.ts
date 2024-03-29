
import { Job } from 'bullmq'
import { ethers } from 'ethers'
import { In, MoreThanOrEqual } from 'typeorm'

import { Result } from '@ethersproject/abi'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { core, looksrareService, openseaService, x2y2Service } from '@nftcom/gql/service'
import { _logger, contracts, db, defs, entity, helper, provider } from '@nftcom/shared'

import { MulticallResponse } from '../interface'
import { cache, CacheKeys, removeExpiredTimestampedZsetMembers, ttlForTimestampedZsetMembers } from '../service/cache'
import { checksumAddress } from '../service/ownership'

export const repositories = db.newRepositories()
const logger = _logger.Factory(_logger.Context.Bull)

const MAX_CHUNK_SIZE = 500
const CALL_SAMPLE_BATCH_SIZE = 10000
const CALL_BATCH_SIZE = 1000

// commented for future reference

// const MAX_PROCESS_BATCH_SIZE = 1500

// const subQueueBaseOptions: Bull.JobOptions = {
//   attempts: 3,
//   removeOnComplete: true,
//   removeOnFail: true,
//   backoff: {
//     type: 'exponential',
//     delay: 2000,
//   },
// }

//batch processor
// const nftExternalOrderBatchProcessor = async (job: Job): Promise<void> => {
//   logger.debug(`initiated external orders batch processor for ${job.data.exchange} | series: ${job.data.offset} | batch:  ${job.data.limit}`)
//   try {
//     const { offset, limit, exchange } = job.data
//     const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
//     const nfts: entity.NFT[] = await repositories.nft.find({
//       where: { chainId, deletedAt: null },
//       select: ['contract', 'tokenId', 'chainId'],
//       skip: offset,
//       take: limit,
//     })

//     if (nfts.length && exchange) {
//       const nftRequest: Array<OpenseaOrderRequest> = nfts.map((nft: any) => ({
//         contract: nft.contract,
//         tokenId: helper.bigNumber(nft.tokenId).toString(),
//         chainId: nft.chainId,
//       }))

//       const persistActivity = []
//       let openseaResponse: OpenseaExternalOrder
//       let looksrareResponse: LooksrareExternalOrder

//       switch (exchange) {
//       case ExchangeType.OpenSea:
//         openseaResponse = await retrieveMultipleOrdersOpensea(nftRequest, chainId, true)

//         // listings
//         if (openseaResponse.listings.length) {
//           persistActivity.push(repositories.txOrder.saveMany(openseaResponse.listings,
//             { chunk: MAX_PROCESS_BATCH_SIZE }))
//         }

//         // offers
//         if (openseaResponse.offers.length) {
//           persistActivity.push(repositories.txOrder.saveMany(openseaResponse.offers,
//             { chunk: MAX_PROCESS_BATCH_SIZE }))
//         }
//         break
//       case ExchangeType.LooksRare:
//         looksrareResponse = await retrieveMultipleOrdersLooksrare(nftRequest, chainId, true)

//         // listings
//         if (looksrareResponse.listings.length) {
//           persistActivity.push(repositories.txOrder.saveMany(looksrareResponse.listings,
//             { chunk: MAX_PROCESS_BATCH_SIZE }))
//         }

//         // offers
//         if (looksrareResponse.offers.length) {
//           persistActivity.push(repositories.txOrder.saveMany(looksrareResponse.offers,
//             { chunk: MAX_PROCESS_BATCH_SIZE }))
//         }
//         break
//       }

//       // settlements should not depend on each other
//       await Promise.allSettled(persistActivity)
//       logger.debug(`completed external orders for ${job.data.exchange} | series: ${job.data.offset} | batch:  ${job.data.limit}`)
//     }
//   } catch (err) {
//     Sentry.captureMessage(`Error in nftExternalOrders Job: ${err}`)
//   }
// }

// export const nftExternalOrders = async (job: Job): Promise<void> => {
//   logger.debug('initiated external orders for nfts', job.data)
//   try {
//     if (!nftCronSubqueue) {
//       await job.moveToFailed({ message: 'nft-cron-queue is not defined!' })
//     }
//     const chainId: string =  job.data?.chainId || process.env.CHAIN_ID

//     const nftCount: number = await repositories.nft.count({ chainId, deletedAt: null })
//     const limit: number = MAX_PROCESS_BATCH_SIZE
//     let offset = 0
//     // sub-queue assignmemt

//     //sub-queue job additions
//     for (let i=0; i < nftCount; i+=MAX_PROCESS_BATCH_SIZE) {
//       offset = i
//       // opensea
//       nftCronSubqueue.add({ offset, limit, chainId, exchange: ExchangeType.OpenSea }, {
//         ...subQueueBaseOptions,
//         jobId: `nft-batch-processor-opensea|offset:${offset}|limit:${limit}-chainId:${chainId}`,
//       })

//       // looksrare
//       nftCronSubqueue.add({ offset, limit, chainId, exchange: ExchangeType.LooksRare  }, {
//         ...subQueueBaseOptions,
//         jobId: `nft-batch-processor-looksrare|offset:${offset}|limit:${limit}-chainId:${chainId}`,
//       })
//     }

//     const existingJobs: Bull.Job[] = await nftCronSubqueue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])

//     // clear existing jobs
//     if (existingJobs.flat().length) {
//       nftCronSubqueue.obliterate({ force: true })
//     }

//     // process subqueues in series; hence concurrency is explicitly set to one for rate limits
//     nftCronSubqueue.process(1, nftExternalOrderBatchProcessor)

//     logger.debug('updated external orders for nfts')
//   } catch (err) {
//     logger.error(`Error in nftExternalOrders Job: ${err}`)
//     Sentry.captureMessage(`Error in nftExternalOrders Job: ${err}`)
//   }
// }

const filterExistingSeaportListings = async (listings): Promise<entity.TxOrder[] | []> => {
  if (listings.length) {
    logger.info('order.handler.filterExistingSeaportListings -> pre-filter', JSON.stringify(listings))
    const orderHashes = listings.map(listing => listing.orderHash)

    // Find existing orderHashes in the TxOrder table
    const existingOrderHashes = await repositories.txOrder.find({
      where: {
        orderHash: {
          $in: orderHashes, // Using 'in' filter
        },
      },
      select: ['orderHash'],
    })

    const existingOrderHashSet = new Set(existingOrderHashes.map(txOrder => txOrder.orderHash))

    // Filter out the listings that have an orderHash already in the TxOrder table
    const filteredListings = listings.filter(
      listing => !existingOrderHashSet.has(listing.orderHash))

    logger.info('order.handler.filterExistingSeaportListings -> post-filter', JSON.stringify(filteredListings))
    return filteredListings
  }

  return []
}

export const nftExternalOrdersOnDemand = async (job: Job): Promise<void> => {
  logger.debug('external orders on demand', job.data)
  try {
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    await removeExpiredTimestampedZsetMembers(
      `${CacheKeys.REFRESHED_NFT_ORDERS_EXT}_${chainId}`,
      Date.now(),
    )
    const cachedNfts = await cache.zrevrangebyscore(`${CacheKeys.REFRESH_NFT_ORDERS_EXT}_${chainId}`, '+inf', '(0')

    const nfts: Array<string> = []

    for (const item of cachedNfts) {
      const itemSplit: string[] = item.split(':')
      const isItemForced = itemSplit.length === 3 && itemSplit?.[2] === 'force' ? true: false

      const itemPresentInRefreshedCache: string = await cache.zscore(`${CacheKeys.REFRESHED_NFT_ORDERS_EXT}_${chainId}`, item)

      // item is not present in refresh cache
      if(!itemPresentInRefreshedCache || isItemForced) {
        nfts.push(item)
      }
    }

    if (nfts.length) {
      const nftRequest: Array<openseaService.OpenseaOrderRequest> = nfts.map((nft: string) => {
        const nftSplit: Array<string> = nft.split(':')
        const contract: string = nftSplit?.[0]
        const tokenId: string = helper.bigNumber(nftSplit?.[1]).toString()

        return {
          contract,
          tokenId,
          chainId,
        }
      })

      // settlements should not depend on each other
      const [opensea, looksrare, x2y2] = await Promise.allSettled([
        openseaService.retrieveMultipleOrdersOpensea(nftRequest, chainId, true),
        looksrareService.retrieveMultipleOrdersLooksrare(nftRequest, chainId, true),
        x2y2Service.retrieveMultipleOrdersX2Y2(nftRequest, chainId, true),
      ])

      const listings: entity.TxOrder[] = []
      const bids: entity.TxOrder[] = []
      const persistActivity: any[] = []

      if (opensea.status === 'fulfilled') {
        // opensea listings
        if (opensea.value.listings.length) {
          // filter out listings that already exist in the TxOrder table -> this is to avoid overwriting listings with existing fields like signature
          const nonExistingListings = await filterExistingSeaportListings(opensea.value.listings)
          listings.push(...nonExistingListings)
        }

        // opensea offers
        if (opensea.value.offers.length) {
          bids.push(...opensea.value.offers)
        }
      }

      if (looksrare.status === 'fulfilled') {
        // looksrare listings
        if (looksrare.value.listings.length) {
          listings.push(...looksrare.value.listings)
        }

        // looksrare offers
        if (looksrare.value.offers.length) {
          bids.push(...looksrare.value.offers)
        }
      }

      if (x2y2.status === 'fulfilled') {
        // x2y2 listings
        if (x2y2.value.listings.length) {
          listings.push(...x2y2.value.listings)
        }

        // x2y2 offers
        if (x2y2.value.offers.length) {
          bids.push(...x2y2.value.offers)
        }
      }

      // save listings
      if (listings.length) {
        persistActivity.push(repositories.txOrder.saveMany(listings, { chunk: MAX_CHUNK_SIZE }))
      }

      // save bids
      if (bids.length) {
        persistActivity.push(repositories.txOrder.saveMany(bids, { chunk: MAX_CHUNK_SIZE }))
      }

      await Promise.all(persistActivity)

      const refreshedOrders  = nfts.reduce((acc, curr) => {
        const nftSplit: Array<string> = curr.split(':')
        const nft: string = nftSplit.slice(0, 2).join(':')
        let ttlCondition = ''

        if (nftSplit.length === 3) {
          if (nftSplit?.[2] === 'force') {
            ttlCondition = 'force'
          } else if (nftSplit?.[2] === 'manual') {
            ttlCondition = 'manual'
          } else {
            ttlCondition = 'automated'
          }
        }

        const currentTime: Date = new Date()
        let date: Date
        switch(ttlCondition) {
        case 'manual':
          currentTime.setMinutes(currentTime.getMinutes() + 5)
          date = currentTime
          break
        case 'automated':
          date = new Date(Number(nftSplit?.[2]))
          break
        case 'force':
        default:
          break
        }
        const ttl: number = ttlForTimestampedZsetMembers(date)
        acc.push(...[ttl, nft])
        return acc
      }, [])
      await Promise.all([
        cache.zadd(
          `${CacheKeys.REFRESHED_NFT_ORDERS_EXT}_${chainId}`,
          ...refreshedOrders,
        ),
        cache.zremrangebyscore(`${CacheKeys.REFRESH_NFT_ORDERS_EXT}_${chainId}`, 1, '+inf'),
      ])
    }

    logger.debug('updated external orders for nfts - on demand')
  } catch (err) {
    logger.error(`Error in nftExternalOrdersOnDemand Job: ${err}`)
  }
}

enum OrderStatusCallType {
  OPENSEA = 'getOrderStatus',
  X2Y2 = 'inventoryStatus'
}

interface OSCallResponse {
  isValidated: boolean
  isCancelled: boolean
  totalFilled: number
  totalSize: number
  contractAddress?: string // used to differentiate between seaport versions
}

const reconcileInvalidCounterOrdersOpenSea = async (
  openSeaInvalidCounterArray: string[],
  chainId: string,
): Promise<void> => {
  try {
    const seaportAbi = contracts.openseaSeaportABI()
    const abiInterface = new ethers.utils.Interface(seaportAbi)
    // at any instant not pulling more than call_batch_size
    let openSeaListings = await repositories.txOrder.find({
      relations: ['activity'],
      where: {
        activity: {
          activityType: defs.ActivityType.Listing,
          status: defs.ActivityStatus.Valid,
          expiration: MoreThanOrEqual(new Date()),
          chainId,
        },
        exchange: defs.ExchangeType.OpenSea,
        orderHash: In([...openSeaInvalidCounterArray]),
      },
      select: {
        id: true,
        activity: {
          id: true,
          walletAddress: true,
          status: true,
          expiration: true,
        },
        orderHash: true,
        makerAddress: true,
        nonce: true,
        hexNonce: true, // included since seaport 1.4 for string type
      },
    })

    const opensea1_1 = openSeaListings.filter(listing => !listing.hexNonce)
    const opensea1_4 = openSeaListings.filter(listing => listing.hexNonce)
    openSeaListings = null // free memory

    const nonceCalls = []
    const makerHighestNonceMap = {}
    for (const listing of opensea1_1) {
      if ((listing.nonce >= 0)
            && !makerHighestNonceMap[listing.makerAddress]
            || (makerHighestNonceMap[listing.makerAddress] < listing.nonce)) {
        makerHighestNonceMap[listing.makerAddress] = listing.nonce
      }

      nonceCalls.push({
        contract: contracts.openseaSeaportAddress(chainId),
        name: 'getCounter',
        params: [listing.makerAddress],
      })
    }

    const nonceCalls1_4 = []

    // get unique maker addresses for seaport 1.4
    const uniqueMakerAddresses1_4 = [...new Set(opensea1_4.map((listing) => listing.makerAddress))]

    // add to nonceCall using Seaport 1.4 address
    for (const makerAddress of uniqueMakerAddresses1_4) {
      nonceCalls1_4.push({
        contract: contracts.openseaSeaportAddress1_4(chainId),
        name: 'getCounter',
        params: [makerAddress],
      })
    }

    /* ------------------------- seaport 1.4 nonce check ------------------------ */
    let listingsToBeUpdated = []
    if (nonceCalls1_4.length) {
      const results = await core.fetchDataUsingMulticall(
        nonceCalls1_4,
        seaportAbi,
        chainId,
        true,
        provider.provider(Number(chainId), true),
      )

      for (let i=0; i < results.length; i++) {
        const result = results?.[i]
        const callName: string = nonceCalls1_4[i]?.name
        const callParams: any = nonceCalls1_4[i].params
        if (result.returnData !== '0x') {
          const resultDecoded = abiInterface.decodeFunctionResult(
            callName,
            result.returnData,
          )
          const maker: string = checksumAddress(callParams?.[0])
          let currentNonceInString = '0'
          
          if (resultDecoded?.counter) {
            currentNonceInString = resultDecoded?.counter
          }

          if (maker) {
            for (const listing of opensea1_4) {
              if (listing.makerAddress === maker) {
                // string comparison of nonce
                // we can do this because the pseudorandom nonce is generated by the contract
                // is impossible to predict, therefore, it is unlikely to have pre-generated nonces
                // from being used in the future. As such, we only care about if the current nonce
                // is equal to the nonce in the order
                if (currentNonceInString !== listing.hexNonce) {
                  listing.activity.status = defs.ActivityStatus.Cancelled
                  listingsToBeUpdated.push(listing)
                  logger.info(
                    `[SEAPORT 1.4] Invalid counter order found for listing -> updating to cancelled ${JSON.stringify(
                      listing,
                    )} - currentNonceString: ${currentNonceInString}`,
                  )
                }
              }

              logger.info(`[SEAPORT 1.4] maker: ${maker} has ${JSON.stringify(listingsToBeUpdated)}`)
            }
          }
        }
      }
    }

    /* ------------------- seaport 1.1 invalid nonce [LEGACY] ------------------- */
    if (nonceCalls.length) {
      const results = await core.fetchDataUsingMulticall(
        nonceCalls,
        seaportAbi,
        chainId,
        true,
        provider.provider(Number(chainId), true),
      )

      for (let i=0; i < results.length; i++) {
        const result = results?.[i]
        const callName: string = nonceCalls[i]?.name
        const callParams: any = nonceCalls[i].params
        if (result.returnData !== '0x') {
          const resultDecoded = abiInterface.decodeFunctionResult(
            callName,
            result.returnData,
          )
          const maker: string = checksumAddress(callParams?.[0])
          let currentNonceInNumber = 0

          if (resultDecoded?.counter) {
            currentNonceInNumber = helper.bigNumberToNumber(
              resultDecoded?.counter,
            )
          }

          if (maker && (currentNonceInNumber > makerHighestNonceMap[maker])) {
            for (const listing of opensea1_1) {
              if (listing.makerAddress === maker) {
                listing.activity.status = defs.ActivityStatus.Cancelled
                listingsToBeUpdated.push(listing)
              }
            }
            logger.info(`[SEAPORT 1.1] maker: ${maker} has ${JSON.stringify(listingsToBeUpdated)}`)
          }
          if (listingsToBeUpdated.length) {
            await repositories.txOrder.saveMany(listingsToBeUpdated, { chunk: 20 })
            logger.info(`Successfully cancelled ${listingsToBeUpdated.length} lower counter listings for maker: ${maker}`)
            listingsToBeUpdated = []
          }
        }
      }
    }
  } catch (err) {
    logger.error(err, 'error in reconcileInvalidCounterOrdersOpenSea')
  }
}

const fulfillOrCancelOpenSea = async (
  orderHash: string,
  callResponse: OSCallResponse,
  openSeaInvalidCounterArray: string[],
): Promise<void> => {
  let status: defs.ActivityStatus
  if (callResponse?.isCancelled) {
    status = defs.ActivityStatus.Cancelled
  } else {
    if (
      callResponse?.isValidated
        && callResponse?.totalFilled
        && callResponse?.totalSize
    ) {
      const totalFilled: number = helper.bigNumberToNumber(callResponse?.totalFilled)
      const totalSize: number = helper.bigNumberToNumber(callResponse?.totalSize)
      const filledRatio: number = totalFilled/totalSize
      if (filledRatio === 1) {
        status = defs.ActivityStatus.Executed
      }
    }
  }

  if (status) {
    await repositories.txActivity.update({
      activityType: defs.ActivityType.Listing,
      status: defs.ActivityStatus.Valid,
      activityTypeId: orderHash,
    }
    , {
      status,
    })
    logger.debug(`OS order with orderhash: ${orderHash} has been ${status}`)
  } else {
    // collect all
    openSeaInvalidCounterArray.push(orderHash)
  }
}

const fulfillOrCancelX2Y2 = async (
  orderHash: string,
  callResponse: number,
): Promise<void> => {
  let status: defs.ActivityStatus
  if (callResponse === 2) {
    status = defs.ActivityStatus.Executed
  } else if (callResponse === 3) {
    status = defs.ActivityStatus.Cancelled
  }

  if (status) {
    await repositories.txActivity.update({
      activityType: defs.ActivityType.Listing,
      status: defs.ActivityStatus.Valid,
      activityTypeId: orderHash,
    }
    , {
      status,
    })
    logger.debug(`X2Y2 order with orderhash: ${orderHash} has been ${status}`)
  }
}

/**
 * Fetches information about pools and return as `Pair` array using multicall contract.
 * @param calls 'Call' array
 * @param abi
 * @param chainId
 * based on:
 * - https://github.com/mds1/multicall#deployments
 * - https://github.com/sushiswap/sushiswap-sdk/blob/canary/src/constants/addresses.ts#L323
 * - https://github.com/joshstevens19/ethereum-multicall#multicall-contracts
 */

const fetchDataUsingMulticallAndReconcile = async (
  calls: Array<core.Call>,
  abi: any[],
  chainId: string,
): Promise<Array<Result | undefined>> => {
  try {
    const abiInterface = new ethers.utils.Interface(abi)
    const results: MulticallResponse[] =
      await core.fetchDataUsingMulticall(
        calls,
        abi,
        chainId,
        true,
        provider.provider(Number(chainId), true),
      )

    let openSeaPromiseArray = [],
      x2y2PromiseArray = [],
      openSeaInvalidCounterArray = []
    // 3. decode bytes array to useful data array...
    for (let i=0; i < results.length; i++) {
      const result = results?.[i]
      const callContract: string = calls[i]?.contract
      const callName: string = calls[i]?.name
      const callParams: any = calls[i]?.params
      if (result.returnData !== '0x') {
        const resultDecoded = abiInterface.decodeFunctionResult(
          callName,
          result.returnData,
        )
        switch (callName) {
        case OrderStatusCallType.OPENSEA:
          // eslint-disable-next-line
            const [ isValidated, isCancelled, totalFilled, totalSize ] = resultDecoded
          openSeaPromiseArray.push(fulfillOrCancelOpenSea(callParams?.[0],
            { isValidated,
              isCancelled,
              totalFilled,
              totalSize,
              contractAddress: callContract,
            },
            openSeaInvalidCounterArray,
          ),
          )
          break
        case OrderStatusCallType.X2Y2:
          x2y2PromiseArray.push(fulfillOrCancelX2Y2(callParams?.[0],
            resultDecoded?.[0],
          ),
          )
          break
        default:
          break
        }
        if (openSeaPromiseArray.length > CALL_BATCH_SIZE) {
          await Promise.all(openSeaPromiseArray)
          openSeaPromiseArray = []
        }
        if (x2y2PromiseArray.length > CALL_BATCH_SIZE) {
          await Promise.all(x2y2PromiseArray)
          x2y2PromiseArray = []
        }
        if (openSeaInvalidCounterArray.length > CALL_BATCH_SIZE) {
          await reconcileInvalidCounterOrdersOpenSea(
            openSeaInvalidCounterArray,
            chainId,
          )
          openSeaInvalidCounterArray = []
        }
      }
    }
    if (openSeaPromiseArray.length) {
      await Promise.all(openSeaPromiseArray)
      openSeaPromiseArray = []
    }
    if (x2y2PromiseArray.length) {
      await Promise.all(x2y2PromiseArray)
      x2y2PromiseArray = []
    }
    if (openSeaInvalidCounterArray.length) {
      await reconcileInvalidCounterOrdersOpenSea(
        openSeaInvalidCounterArray,
        chainId,
      )
      openSeaInvalidCounterArray = []
    }
  } catch (error) {
    logger.error(
      `Failed to fetch data using multicall: ${error}`,
    )
    return []
  }
}

export const orderReconciliationHandler = async (job: Job): Promise<void> =>  {
  logger.log('initiated order reconciliation process')
  try {
    const chainId: string = job.data.chainId || process.env.CHAIN_ID
    const expirationFilters = {
      activityType: defs.ActivityType.Listing,
      status: defs.ActivityStatus.Valid,
      expiration: MoreThanOrEqual(new Date()),
      chainId,
    }
    const countFilter = {
      activity: {
        ...expirationFilters,
      },
      orderType: defs.ActivityType.Listing,
      chainId,
    } as any
    const unexpiredListingsCount: number = await repositories.txOrder.count(countFilter)
    logger.log(`current valid listing count: ${unexpiredListingsCount}`)
  
    for (let i=0; i < unexpiredListingsCount; i+= CALL_SAMPLE_BATCH_SIZE) {
      const unexpiredListingBatch: Partial<entity.TxOrder>[] = await repositories.txOrder.find({
        relations: ['activity'],
        where: {
          activity: {
            ...expirationFilters,
          },
        },
        skip: i,
        take: CALL_SAMPLE_BATCH_SIZE,
        select: {
          id: true,
          orderHash: true,
          exchange: true,
          protocolData: true,
          makerAddress: true,
        },
      })
  
      if (unexpiredListingBatch?.length) {
        let seaportCalls = [], x2y2Calls = []
        const seaportAbi = contracts.openseaSeaportABI()
        const x2y2Abi = contracts.x2y2ABI()
    
        for (const listing of unexpiredListingBatch) {
          switch (listing.exchange) {
            case defs.ExchangeType.OpenSea:
              if (listing?.nonce) {
                seaportCalls.push({
                  contract: contracts.openseaSeaportAddress(chainId),
                  name: 'getOrderStatus',
                  params: [listing.orderHash],
                })
              }

              // hexNonce string only used for 1.4
              if (listing?.hexNonce) {
                seaportCalls.push({
                  contract: contracts.openseaSeaportAddress1_4(chainId),
                  name: 'getOrderStatus',
                  params: [listing.orderHash],
                })
              }
              break
            case defs.ExchangeType.X2Y2:
              // 0 -> not fulfilled, 1 -> auction, 2 -> fulfilled, 3 -> cancelled, 4 -> refunded
              x2y2Calls.push({
                contract: contracts.x2y2Address(chainId),
                name: 'inventoryStatus',
                params: [listing.orderHash],
              })
              break
            default:
              break
          }
    
          if (seaportCalls.length >= CALL_BATCH_SIZE) {
            await fetchDataUsingMulticallAndReconcile(seaportCalls, seaportAbi, chainId)
            seaportCalls = []
          }

          if (seaportCalls.length >= CALL_BATCH_SIZE) {
            await fetchDataUsingMulticallAndReconcile(seaportCalls, seaportAbi, chainId)
            seaportCalls = []
          }
    
          if (x2y2Calls.length >= CALL_BATCH_SIZE) {
            await fetchDataUsingMulticallAndReconcile(x2y2Calls, x2y2Abi, chainId)
            x2y2Calls = []
          }
        }
    
        if (seaportCalls.length) {
          await fetchDataUsingMulticallAndReconcile(seaportCalls, seaportAbi, chainId)
          seaportCalls = []
        }
    
        if (x2y2Calls.length) {
          await fetchDataUsingMulticallAndReconcile(x2y2Calls, x2y2Abi, chainId)
          x2y2Calls = []
        }
      }
    }
  } catch (err) {
    logger.error(err, 'Error in order reconciliation process')
  }
  
  logger.log('completed order reconciliation process')
}