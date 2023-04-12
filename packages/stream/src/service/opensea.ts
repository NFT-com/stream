import axios, { AxiosError,AxiosInstance, AxiosResponse } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'
import { BigNumber } from 'ethers'
import { WebSocket } from 'ws'

import { _logger, db, defs, entity, helper } from '@nftcom/shared'
import { OpenSeaStreamClient } from '@opensea/stream-js'

import { OPENSEA_API_KEY } from '../config'
import { Slug } from '../interface'
import { delay } from '../utils'
import { orderEntityBuilder } from '../utils/builder/orderBuilder'
import { cache, CacheKeys }from './cache'

const logger = _logger.Factory(_logger.Context.Opensea)
const repositories = db.newRepositories()

const V1_OPENSEA_API_TESTNET_BASE_URL = 'https://testnets-api.opensea.io/api/v1'
const V1_OPENSEA_API_BASE_URL = 'https://api.opensea.io/api/v1'
const OPENSEA_API_TESTNET_BASE_URL = 'https://testnets-api.opensea.io/v2'
const OPENSEA_API_BASE_URL = 'https://api.opensea.io/v2'

const DELAY_AFTER_BATCH_RUN = 4
const MAX_QUERY_LENGTH = 4014 // 4094 - 80
const MAX_BATCH_SIZE = 20
const TESTNET_CHAIN_IDS = ['4', '5']
const OPENSEA_LISTING_BATCH_SIZE = 30

enum OpenseaQueryParamType {
  TOKEN_IDS = 'token_ids',
  ASSET_CONTRACT_ADDRESSES = 'asset_contract_addresses',
  ASSET_CONTRACT_ADDRESS = 'asset_contract_address'
}

interface MakerOrTaker {
  address: string
}
interface OpenseaBaseOrder {
  created_date: string
  closing_date: string
  closing_extendable?: boolean
  expiration_time: number
  listing_time: number
  order_hash: string
  current_price: string
  maker: MakerOrTaker
  taker: MakerOrTaker
  cancelled: boolean
  finalized: boolean
  marked_invalid: boolean
  approved_on_chain?: boolean
}

export interface WyvernOrder extends OpenseaBaseOrder {
  payment_token_contract: {
    symbol: string
    address: string
    image_url: string
    name: string
    decimals: number
    eth_price: string
    usd_price: string
  }
  metadata: any
  exchange: string
  current_bounty: string
  bounty_multiple: string
  maker_relayer_fee: string
  taker_relayer_fee: string
  maker_protocol_fee: string
  taker_protocol_fee: string
  maker_referrer_fee: string
  fee_recipient: any
  fee_method: number
  side: number
  sale_kind: number
  target: string
  how_to_call: number
  calldata: string
  replacement_pattern: string
  static_target: string
  static_extradata: string
  payment_token: string
  base_price: string
  extra: string
  quantity: string
  salt: string
  v: number
  r: string
  s: string
  prefixed_hash: string
}

interface MakerOrTakerFees {
  account: {
    address: string
  }
  basis_points: string
}

export interface SeaportOffer {
  itemType: number
  token: string
  identifierOrCriteria: string
  startAmount: string
  endAmount: string
  
}

export interface SeaportConsideration extends SeaportOffer {
  recipient: string
}

export interface SeaportOrder extends OpenseaBaseOrder {
  protocol_data: {
    parameters: {
      offerer: string
      offer: SeaportOffer[]
      consideration: SeaportConsideration[]
      startTime: string
      endTime: string
      orderType: number
      zone: string
      zoneHash: string
      salt: string
      conduitKey: string
      totalOriginalConsiderationItems: number
      counter: number
    }
    signature: string
  }
  protocol_address: string
  maker_fees: MakerOrTakerFees[]
  taker_fees: MakerOrTakerFees[] | null
  side: string
  order_type: string
  client_signature: string
  relay_id: string
  criteria_proof: any
}

export interface OpenseaExternalOrder {
  listings: entity.TxOrder[]
  offers: entity.TxOrder[]
}

// commented for future reference
// const cids = (): string => {
//   const ids = [
//     'ethereum',
//     'usd-coin',
//     'ape',
//     'dai',
//     'the-sandbox',
//   ]

//   return ids.join('%2C')
// }

export interface OpenseaOrderRequest {
  contract: string
  tokenId: string
  chainId: string
}

export const client = new OpenSeaStreamClient({
  token: OPENSEA_API_KEY,
  connectOptions: {
    transport: WebSocket,
  },
  onError: (err: Error) => {
    logger.error(err, 'OpenSeaStreamClient error')
  },
})

export const connectClient = (): void => {
  logger.log('----Connecting to client-----')
  try {
    client.connect()
  } catch (err) {
    logger.error('client connection error:', JSON.stringify(err))
  }
}

export const getOpenseaInterceptor = (
  baseURL: string,
  chainId: string,
): AxiosInstance => {
  const openseaInstance = axios.create({
    baseURL,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-KEY': chainId === '1'? OPENSEA_API_KEY : '',
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
  axiosRetry(openseaInstance,  retryOptions)
  
  return openseaInstance
}

/**
 * Fetches the banner image URL and image URL for a given collection based on its contract address.
 *
 * @param contractAddress - The contract address of the collection to fetch.
 * @param apiKey - The API key to be used for authentication with the OpenSea API.
 * @returns A tuple containing the banner image URL and image URL. Returns [null, null] in case of errors or if URLs are not available.
 */
export const fetchCollectionBannerImages = async (
  contractAddress: string,
  apiKey: string
): Promise<[string | null, string | null]> => {
  // Set up the headers for the request, including the API key.
  const headers = {
    'X-API-KEY': apiKey,
  }

  // Set up the Axios instance with the appropriate OpenSea API base URL.
  const apiBaseUrl = 'https://api.opensea.io/api/v1'
  const openseaInstance = getOpenseaInterceptor(apiBaseUrl, process.env.CHAIN_ID || '1')

  try {
    // Define the OpenSea API endpoint for the collection details based on contract address.
    const url = `/asset_contract/${contractAddress}`

    // Fetch the collection data from the OpenSea API, including the headers.
    const response = await openseaInstance.get(url, { headers })

    // Extract the banner image URL and image URL.
    const bannerImageUrl = response.data.collection?.['banner_image_url']?.replace('?w=500&auto=format', '') ?? null
    const imageUrl = response.data.collection?.['image_url']?.replace('?w=500&auto=format', '') ?? null

    logger.info(`fetchCollectionBannerImages collection banner image for contract ${contractAddress}: ${bannerImageUrl}, ${imageUrl}`)

    // Return the banner image URL and image URL as a tuple.
    return [bannerImageUrl, imageUrl]
  } catch (error) {
    logger.error(`Error fetchCollectionBannerImages fetching collection banner image for contract ${contractAddress}: ${error}`)
    return [null, null]
  }
}

/**
 * Retrieve listings in batches
 * @param slugsQueryParams
 */
export const retrieveSlugsBatches = async (
  slugsQueryParams: string[],
): Promise<any[]> => {
  try {
    const slugs: Slug[] = []
    const cacheSlugs = []
    const chainId = process.env.CHAIN_ID || '4'
    let batch: string[], queryUrl: string
    const slugsBaseUrl: string =  TESTNET_CHAIN_IDS.includes(chainId) ?
      V1_OPENSEA_API_TESTNET_BASE_URL
      : V1_OPENSEA_API_BASE_URL
    const slugsInterceptor = getOpenseaInterceptor(
      slugsBaseUrl,
      chainId,
    )
    let delayCounter = 0
    let size: number
    while(slugsQueryParams.length) {
      size = MAX_BATCH_SIZE
      batch = slugsQueryParams.slice(0, size) // batches of 45
    
      queryUrl = `${batch.join('&')}`
    
      // only executed if query length more than accepted limit by opensea
      // runs once or twice at most
      while(queryUrl.length > MAX_QUERY_LENGTH) {
        size--
        batch = slugsQueryParams.slice(0, size)
        queryUrl = `${batch.join('&')}`
      }
        
      const response: AxiosResponse = await slugsInterceptor(
        `/assets?${queryUrl}`,
      )
      if (response?.data?.assets?.length) {
        const assets = response?.data?.assets
        if (assets?.length) {
          for (const asset of assets) {
            const contract: string = asset?.asset_contract?.address
            const slug: string = asset?.collection?.slug
            if (contract && slug) {
              cacheSlugs.push(
                cache.set(`${CacheKeys.SLUG}:contract-${contract}`, slug),
              )
            }
          }
        }
      }
      slugsQueryParams = [...slugsQueryParams.slice(size)]
      delayCounter++
      if (delayCounter === DELAY_AFTER_BATCH_RUN) {
        await Promise.all(cacheSlugs)
        await delay(1000)
        delayCounter = 0
      }
    }
            
    return slugs
  } catch (err) {
    logger.error('----opensea slug fetch error----::Assets API::---', err)
    return []
  }
}

/**
 * Retrieve listings in batches
 * @param contracts
 */
export const retrieveSlugsForContracts = async (
  contracts: string[],
): Promise<string[]> => {
  try {
    const slugs: string[] = []
    const chainId = process.env.CHAIN_ID || '4'
    const slugsBaseUrl: string =  TESTNET_CHAIN_IDS.includes(chainId) ?
      V1_OPENSEA_API_TESTNET_BASE_URL
      : V1_OPENSEA_API_BASE_URL
    const slugsInterceptor = getOpenseaInterceptor(
      slugsBaseUrl,
      chainId,
    )
  
    for (const contract of contracts) {
      const response: AxiosResponse = await slugsInterceptor(
        `/asset_contract/${contract}`,
      )
      const checksumContract: string = helper.checkSum(contract)
      if (response?.data?.collection) {
        const collection = response?.data?.collection
        const slug: string = collection?.slug
        if (slug) {
          await cache.sadd(`${CacheKeys.SLUG}`, `${checksumContract}:${slug}`)
          slugs.push(slug)
        }
      }
    }
    return slugs
  } catch (err) {
    logger.error('----opensea slug fetch error----::Contracts API::---', err)
    return []
  }
}

/**
 * Retrieve listings in batches
 * @param listingQueryParams
 * @param chainId
 * @param batchSize
 */
const retrieveListingsInBatches = async (
  listingQueryParams: string[],
  chainId: string,
  batchSize: number,
): Promise<void> => {
  let batch: string[], queryUrl: string
  const listingBaseUrl: string =  TESTNET_CHAIN_IDS.includes(chainId) ?
    V1_OPENSEA_API_TESTNET_BASE_URL
    : V1_OPENSEA_API_BASE_URL
  const listingInterceptor = getOpenseaInterceptor(
    listingBaseUrl,
    chainId,
  )

  let delayCounter = 0
  let size: number
  while(listingQueryParams.length) {
    size = batchSize
    batch = listingQueryParams.slice(0, size) // batches of 200

    queryUrl = `${batch.join('&')}`

    // only executed if query length more than accepted limit by opensea
    // runs once or twice at most
    while(queryUrl.length > MAX_QUERY_LENGTH) {
      size--
      batch = listingQueryParams.slice(0, size)
      queryUrl = `${batch.join('&')}`
    }

    const response: AxiosResponse = await listingInterceptor(
      `/assets?${queryUrl}&limit=${batchSize}&include_orders=true`,
    )
    if (response?.data?.assets?.length) {
      const assets = response?.data?.assets
      if (assets?.length) {
        for (const asset of assets) {
          const contract: string = asset?.asset_contract?.address
          const seaportOrders: SeaportOrder[] | null =  asset?.seaport_sell_orders
          logger.log('seaport order', seaportOrders)
          let orderHash: string, activityId: string
          // seaport orders - always returns cheapest order
          if (seaportOrders && Object.keys(seaportOrders?.[0]).length) {
            const listing = await  orderEntityBuilder(
              defs.ProtocolType.Seaport,
              defs.ActivityType.Listing,
              seaportOrders?.[0],
              chainId,
              contract,
            )
            const savedListing: entity.TxOrder = await repositories.txOrder.save(listing)
            orderHash = seaportOrders?.[0]?.order_hash
            activityId = savedListing?.activity?.id
            const tokenId: string =  BigNumber.from(
              seaportOrders?.[0]?.protocol_data?.parameters?.offer?.[0].identifierOrCriteria,
            ).toHexString()

            logger.log(`Saved OS listing with hash: ${orderHash} for contract: ${contract} and tokenId: ${tokenId}`)
       
            const cacheKey = `contract-${contract}:tokenId-${tokenId}:orderHash-${orderHash}:activity-${activityId}`
            await cache.sadd(CacheKeys.SYNCED_OS, cacheKey)
          }
        }
      }
    }

    listingQueryParams = [...listingQueryParams.slice(size)]
    delayCounter++
    if (delayCounter === DELAY_AFTER_BATCH_RUN) {
      await delay(1000)
      delayCounter = 0
    }
  }
}

/**
 * Retrieve offers in batches
 * @param offerQueryParams
 * @param chainId
 * @param batchSize
 */
const retrieveOffersInBatches = async (
  offerQueryParams: Map<string, string[]>,
  chainId: string,
  batchSize: number,
): Promise<void> => {
  let batch: string[], queryUrl: string
  const offerBaseUrl: string =  TESTNET_CHAIN_IDS.includes(chainId) ?
    OPENSEA_API_TESTNET_BASE_URL
    : OPENSEA_API_BASE_URL

  const offerInterceptor = getOpenseaInterceptor(
    offerBaseUrl,
    chainId,
  )

  let delayCounter = 0
  let size: number
  let seaportOffers: SeaportOrder[]

  // contracts exist
  if (offerQueryParams.size) {
    // iterate  on contract
    for (const contract of offerQueryParams.keys()) {
      // contract has tokens
      if (offerQueryParams.get(contract).length) {
        // batches of batchSize tokens
        let tokens: string[] = offerQueryParams.get(contract)
        while (tokens.length) {
          size = batchSize
          batch = tokens.slice(0, size)
          queryUrl = `asset_contract_address=${contract}&${batch.join('&')}`

          // only executed if query length more than accepted limit by opensea
          // runs once or twice at most
          while(queryUrl.length > MAX_QUERY_LENGTH) {
            size--
            batch = tokens.slice(0, size)
            queryUrl = `asset_contract_address=${contract}&${batch.join('&')}`
          }

          const response: AxiosResponse = await offerInterceptor(
            `/orders/${chainId === '1' ? 'ethereum': 'rinkeby'}/seaport/offers?${queryUrl}&limit=${batchSize}&order_direction=desc&order_by=eth_price`,
          )
          let orderHash: string, activityId: string
          if (response?.data?.orders?.length) {
            seaportOffers = response?.data?.orders
            logger.log('seaport offers', seaportOffers)
            
            const offer = await orderEntityBuilder(
              defs.ProtocolType.Seaport,
              defs.ActivityType.Bid,
              seaportOffers?.[0],
              chainId,
              contract,
            )
            const savedOffer: entity.TxOrder = await repositories.txOrder.save(offer)
            activityId = savedOffer?.activity?.id
            orderHash = seaportOffers?.[0]?.order_hash
            const tokenId: string =  BigNumber.from(
              seaportOffers?.[0]?.protocol_data?.parameters?.offer?.[0].identifierOrCriteria,
            ).toHexString()
            logger.log(`Saved OS offer with hash: ${orderHash} for contract: ${contract} and tokenId: ${tokenId}`)
             
            const cacheKey = `contract-${contract}:tokenId-${tokenId}:orderHash-${orderHash}:activity-${activityId}`
            await cache.sadd(CacheKeys.SYNCED_OS, cacheKey)
          }
          tokens = [...tokens.slice(size)]
          delayCounter++
          // add delay
          if (delayCounter === DELAY_AFTER_BATCH_RUN) {
            await delay(1000)
            delayCounter = 0
          }
        }
      }
    }
  }
}

/**
 * Retrieve multiple sell or buy orders
 * TODO: Offer implementation in the offer ticket
 * @param openseaMultiOrderRequest
 * @param chainId
 * @param includeOffers
 */
export const retrieveMultipleOrdersOpensea = async (
  openseaMultiOrderRequest: Array<OpenseaOrderRequest>,
  chainId: string,
  includeOffers: boolean,
): Promise<void> => {
  try {
    if (openseaMultiOrderRequest?.length) {
      const listingQueryParams: Array<string> = []
      const offerQueryParams: Map<string, Array<string>> = new Map()
      for (const openseaReq of openseaMultiOrderRequest) {
        // listing query builder
        listingQueryParams.push(
          `${OpenseaQueryParamType.ASSET_CONTRACT_ADDRESSES}=${openseaReq.contract}&${OpenseaQueryParamType.TOKEN_IDS}=${openseaReq.tokenId}`,
        )

        if (includeOffers) {
          // offer query builder
          if (!offerQueryParams.has(openseaReq.contract)) {
            offerQueryParams.set(openseaReq.contract,
              [],
            )
          }
          offerQueryParams.get(openseaReq.contract)?.push(
            `${OpenseaQueryParamType.TOKEN_IDS}=${openseaReq.tokenId}`,
          )
        }
      }

      // listings 
      if (listingQueryParams.length) {
        await retrieveListingsInBatches(
          listingQueryParams,
          chainId,
          OPENSEA_LISTING_BATCH_SIZE,
        )
      }

      // offers
      if (includeOffers && offerQueryParams.size) {
        await retrieveOffersInBatches(
          offerQueryParams,
          chainId,
          OPENSEA_LISTING_BATCH_SIZE,
        )
      }
    }
  } catch (err) {
    logger.error(`Error in retrieveMultipleOrdersOpensea: ${err}`)
  }
}

