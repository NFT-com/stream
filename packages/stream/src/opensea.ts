import { OpenSeaStreamClient } from '@opensea/stream-js'
import { WebSocket } from 'ws'
import { helper, _logger } from '@nftcom/shared'
import axios, { AxiosResponse, AxiosInstance, AxiosError } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'
import { cache, CacheKeys }from './cache'
import { delay } from './utils'
import { Slug } from './interfaces'

const logger = _logger.Factory(_logger.Context.Opensea)

const OPENSEA_API_KEY = process.env.OPENSEA_B_API_KEY || ''
const V1_OPENSEA_API_TESTNET_BASE_URL = 'https://testnets-api.opensea.io/api/v1'
const V1_OPENSEA_API_BASE_URL = 'https://api.opensea.io/api/v1'
const DELAY_AFTER_BATCH_RUN = 4
const MAX_QUERY_LENGTH = 4014 // 4094 - 80
const MAX_BATCH_SIZE = 20
const TESTNET_CHAIN_IDS = ['4', '5']

export const client = new OpenSeaStreamClient({
    token: OPENSEA_API_KEY,
    connectOptions: {
        transport: WebSocket
    }
});


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
          const retry_after: number = Number(err.response.headers['retry-after'])
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
 * Retrieve listings in batches
 * @param slugsQueryParams
 */
 export const retrieveSlugsBatches = async (
    slugsQueryParams: string[]
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
                  cache.set(`${CacheKeys.SLUG}:contract-${contract}`, slug)
                )
              }
            }
          }
        }
        slugsQueryParams = [...slugsQueryParams.slice(size)]
        delayCounter++
        if (delayCounter === DELAY_AFTER_BATCH_RUN) {
          const cached = Promise.all(cacheSlugs)
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
  contracts: string[]
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
  
    for (let contract of contracts) {
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


