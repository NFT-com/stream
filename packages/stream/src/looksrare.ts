import axios, { AxiosError,AxiosInstance, AxiosResponse } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'
import { BigNumber } from 'ethers'

import { _logger, db, defs, entity } from '@nftcom/shared'

import { cache, CacheKeys } from './cache'
import { delay } from './utils'
import { orderEntityBuilder } from './utils/orderBuilder'

const LOOKSRARE_API_BASE_URL = 'https://api.looksrare.org/api/v1'
const LOOKSRARE_API_TESTNET_BASE_URL = 'https://api-rinkeby.looksrare.org/api/v1'
const LOOKSRARE_LISTING_BATCH_SIZE = 4
const LOOKSRARE_API_KEY = process.env.LOOKSRARE_API_KEY

const logger = _logger.Factory(_logger.Context.Looksrare)
const repositories = db.newRepositories()
export interface LooksRareOrderRequest {
  contract: string
  tokenId: string
  chainId: string
}

export interface LooksRareOrder {
  hash: string
  collectionAddress: string
  tokenId: string
  isOrderAsk: boolean
  signer: string
  strategy: string
  currencyAddress: string
  amount: number
  price: string
  nonce: string
  startTime:number
  endTime:number
  minPercentageToAsk:number
  params: string
  status: string
  signature: string
  v: number
  r: string
  s: string
}

export interface LooksrareExternalOrder {
  listings: entity.TxOrder[]
  offers: entity.TxOrder[]
}

export interface LookrareResponse {
  collectionAddress: string
  tokenId: string
  isOrderAsk: boolean // if isOrderAsk is true, it's listing, or else it's offer
  currencyAddress: string
  price: string
  startTime: number
  endTime: number
  status: string
}

const getLooksRareInterceptor = (
  baseURL: string,
  chainId: string,
): AxiosInstance => {
  const looksrareInstance = axios.create({
    baseURL,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Looks-Api-Key': chainId === '1'? LOOKSRARE_API_KEY : '',
    },
  })
  // retry logic with exponential backoff
  const retryOptions: IAxiosRetryConfig= { retries: 3,
    retryCondition: (err: AxiosError<any>) => {
      return (
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response.status === 429
      )
    },
    retryDelay: (retryCount: number, err: AxiosError<any>) => {
      if (err.response) {
        const retry_after = Number(err.response.headers['retry-after'])
        if (retry_after) {
          return retry_after
        }
      }
      return axiosRetry.exponentialDelay(retryCount)
    },
  }
  axiosRetry(looksrareInstance,  retryOptions)
  return looksrareInstance
}

/**
 * Retrieve listings in batches
 * @param listingQueryParams
 * @param chainId
 * @param batchSize
 */
const retrieveLooksRareOrdersInBatches = async (
  listingQueryParams: string[],
  chainId: string,
  batchSize: number,
): Promise<LooksrareExternalOrder> => {
  const listings: any[] = []
  const offers: any[] = []
  let queryUrl
  const listingBaseUrl = chainId === '4' ? LOOKSRARE_API_TESTNET_BASE_URL : LOOKSRARE_API_BASE_URL
  const listingInterceptorLooksrare = getLooksRareInterceptor(
    listingBaseUrl,
    chainId,
  )
  let delayCounter = 0
  let size: number
  while(listingQueryParams.length>0) {
    size = batchSize
    queryUrl = listingQueryParams.pop()

    const response: AxiosResponse = await listingInterceptorLooksrare(
      `/orders?${queryUrl}`,
    )
    let orderHash: string, activityId: string
    if (response?.data?.data?.length)
    {
      const orders = response?.data?.data
      logger.log('looksrare order', orders)
      if( queryUrl.includes('isOrderAsk=true')){
        const listing = await orderEntityBuilder(
          defs.ProtocolType.LooksRare,
          defs.ActivityType.Listing,
          orders[0],
          chainId,
          orders[0]?.collectionAddress,
        )
        const savedListing: entity.TxOrder = await repositories.txOrder.save(listing)
        orderHash = orders?.[0]
        activityId = savedListing.activity.id

        const contract: string =  orders[0]?.collectionAddress
        const tokenId: string =  BigNumber.from(
          orders[0]?.tokenId,
        ).toHexString()

        logger.log(`Saved LR listing with hash: ${orderHash} for contract: ${contract} and tokenId: ${tokenId}`)

        const cacheKey = `contract-${contract}:tokenId-${tokenId}:orderHash-${orderHash}:activity-${activityId}`
        await cache.sadd(CacheKeys.SYNCED_LR, cacheKey)
      }
      else  {
        const offer = await orderEntityBuilder(
          defs.ProtocolType.LooksRare,
          defs.ActivityType.Bid,
          orders?.[0],
          chainId,
          orders[0]?.collectionAddress,
        )
        const savedOffer: entity.TxOrder = await repositories.txOrder.save(offer)
        orderHash = orders?.[0]
        activityId = savedOffer.activity.id

        const contract: string =  orders[0]?.collectionAddress
        const tokenId: string =  BigNumber.from(
          orders[0]?.tokenId,
        ).toHexString()

        logger.log(`Saved LR offer with hash: ${orderHash} for contract: ${contract} and tokenId: ${tokenId}`)
        const cacheKey = `contract-${contract}:tokenId-${tokenId}:orderHash-${orderHash}:activity-${activityId}`
        await cache.sadd(CacheKeys.SYNCED_LR, cacheKey)
      }
    }
    delayCounter = delayCounter +1
    if (delayCounter === size) {
      await delay(1000)
      delayCounter = 0
    }
  }

  return {
    listings: await Promise.all(listings),
    offers: await Promise.all(offers),
  }
}

/**
 * Retrieve multiple sell or buy orders
 * @param looksrareMultiOrderRequest
 * @param chainId
 * @param includeOffers
 */
export const retrieveMultipleOrdersLooksrare = async (
  looksrareMultiOrderRequest: Array<LooksRareOrderRequest>,
  chainId: string,
  includeOffers: boolean,
): Promise<LooksrareExternalOrder> => {
  let responseAggregator: LooksrareExternalOrder = {
    listings: [],
    offers: [],
  }

  try {
    if (looksrareMultiOrderRequest?.length) {
      const orderQueries: Array<string> = []
      for (const looksrareReq of looksrareMultiOrderRequest) {
        orderQueries.push(`isOrderAsk=true&collection=${looksrareReq.contract}&tokenId=${looksrareReq.tokenId}&status[]=VALID&sort=PRICE_ASC`)
        if (includeOffers) {
          orderQueries.push(`isOrderAsk=false&collection=${looksrareReq.contract}&tokenId=${looksrareReq.tokenId}&status[]=VALID&sort=PRICE_DESC`)
        }
      }
      if (orderQueries.length) {
        responseAggregator = await retrieveLooksRareOrdersInBatches(
          orderQueries,
          chainId,
          LOOKSRARE_LISTING_BATCH_SIZE,
        )
      }
    }
  } catch (err) {
    logger.error(`Error in retrieveMultipleOrdersLooksrare: ${err}`)
    // Sentry.captureMessage(`Error in retrieveOrdersLooksrare: ${err}`)
  }
  return responseAggregator
}