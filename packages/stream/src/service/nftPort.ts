import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'
import { ethers } from 'ethers'
import qs from 'qs'

import { _logger } from '@nftcom/shared'

import { chainFromId } from '../utils'
import { cache } from './cache'

const NFTPORT_API_BASE_URL = 'https://api.nftport.xyz/v0'

const logger = _logger.Factory(_logger.Context.NFTPort)
const NFTPORT_API_KEY = process.env.NFTPORT_KEY
type NFTPortDetailIncludes = 'rarity' | 'attributes'
type NFTPortContractNFTIncludes = 'rarity' | 'metadata' | 'file_information' | 'last_sale_price' | 'all'

export interface NFTPortRarityAttributes {
  trait_type: string
  value: string
  statistics: {
    total_count: number
    prevalence: number
  }
}

export interface NFTPortNFT {
  nft: {
    token_id?: string
    metadata_url?: string
    cached_file_url?: string
    metadata: {
      attributes: any
      name: string
      description: string
      image: string
      image_url: string
    }
    rarity: {
      strategy: string
      score: number
      rank: number
      max_rank: number
      updated_date: string
    }
    attributes: NFTPortRarityAttributes[]
  }
  contract: {
    name?: string
    symbol?: string
    type?: string
    metadata: {
      description?: string
      banner_url?: string
      cached_thumbnail_url?: string
      cached_banner_url?: string
    }
  }
  owner: string
  status_message?: string
}

export const getNFTPortInterceptor = (
  baseURL: string,
): AxiosInstance => {
  const instance = axios.create({
    baseURL,
    headers: {
      Authorization: NFTPORT_API_KEY,
      'Content-Type': 'application/json',
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
        const retry_after =  Number(err.response.headers['retry-after'])
        if (retry_after) {
          return retry_after
        }
      }
      return axiosRetry.exponentialDelay(retryCount)
    },
  }
  axiosRetry(instance as any,  retryOptions)

  return instance
}

export const retrieveNFTDetailsNFTPort = async (
  contract: string,
  tokenId: string,
  chainId: string,
  refreshMetadata = false,
  include?: NFTPortDetailIncludes[],
): Promise<NFTPortNFT | undefined> => {
  try {
    logger.debug(`starting retrieveNFTDetailsNFTPort: ${contract} ${tokenId} ${chainId}`)
    const key = `NFTPORT_NFT_DETAIL_${chainId}_${contract}_${tokenId}`
    const cachedData = await cache.get(key)
    if (cachedData)
      return JSON.parse(cachedData)
    const chain = chainFromId(chainId)
    if (!chain) return
    const nftInterceptor = getNFTPortInterceptor(NFTPORT_API_BASE_URL)
    const tokenIdInteger = ethers.BigNumber.from(tokenId).toString()
    const url = `/nfts/${contract}/${tokenIdInteger}`

    const res = await nftInterceptor.get(url, {
      params: {
        chain: chain,
        refresh_metadata: refreshMetadata || undefined,
        include: include?.length ? include : [],
      },
      paramsSerializer: (params) => qs.stringify(params, { arrayFormat: 'repeat' }),
    })
    if (res && res?.data) {
      await cache.set(key, JSON.stringify(res.data), 'EX', 60 * 10)
      return res.data as NFTPortNFT
    } else {
      return undefined
    }
  } catch (err) {
    logger.error(`Error in retrieveNFTDetailsNFTPort: ${err}`)
    return undefined
  }
}

export const retrieveContractNFTsNFTPort = async (
  contract: string,
  chainId: string,
  refreshMetadata = false,
  page: number,
  include?: NFTPortContractNFTIncludes[],
): Promise<any> => {
  try {
    logger.debug(`starting retrieveContractNFTs: ${contract} ${chainId} - page: ${page}`)
    const key = `NFTPORT_CONTRACT_NFTS_${chainId}_${contract}_page_${page}`
    const cachedData = await cache.get(key)
    if (cachedData)
      return JSON.parse(cachedData)
    const chain = chainFromId(chainId)
    if (!chain) return
    const nftInterceptor = getNFTPortInterceptor(NFTPORT_API_BASE_URL)
    const url = `/nfts/${contract}`
    const res = await nftInterceptor.get(url, {
      params: {
        chain: chain,
        refresh_metadata: refreshMetadata || undefined,
        include: include?.length ? include : [],
        page_size: 50,
        page_number: page,
      },
      paramsSerializer: (params) => qs.stringify(params, { arrayFormat: 'repeat' }),
    })
    if (res && res?.data) {
      await cache.set(key, JSON.stringify(res.data), 'EX', 60 * 10)
      return res.data
    } else {
      return undefined
    }
  } catch (err) {
    logger.error(`Error in retrieveContractNFTsNFTPort: ${err}`)
    return undefined
  }
}