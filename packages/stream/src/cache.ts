import Redis from 'ioredis'

import { redisConfig } from './config'

let redis: Redis
// const DEFAULT_TTL_MINS = 1 // 1hr

export enum CacheKeys {
  REFRESH_NFT_ORDERS_EXT = 'refresh_nft_orders_ext',
  REFRESHED_NFT_ORDERS_EXT = 'refreshed_nft_orders_ext',
  SLUG = 'collection-slug',
  REGISTERED = 'registered-slug',
  DEREGISTER = 'deregister-slug',
  SYNCED_OS = 'synced_os',
  SYNCED_LR = 'synced_lr'
}

const createCacheConnection = (): void => {
  redis = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
  })
}

// create connection on first import
if (!redis) {
  createCacheConnection()
}

export const cache = redis
