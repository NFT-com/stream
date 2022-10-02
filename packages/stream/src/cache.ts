import Redis from 'ioredis'

import { redisConfig } from './config'

let redis: Redis
// const DEFAULT_TTL_MINS = 1 // 1hr

export enum CacheKeys {
  REFRESH_NFT_ORDERS_EXT = 'refresh_nft_orders_ext',
  REFRESHED_NFT_ORDERS_EXT = 'refreshed_nft_orders_ext',
  UPDATED_NFTS_PROFILE = 'updated_nfts_profile',
  UPDATE_NFTS_PROFILE = 'update_nfts_profile',
  PROFILES_IN_PROGRESS = 'profiles_in_progress',
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

// for expired set members
export const removeExpiredTimestampedZsetMembers = (
  zSetKey: string,
  expireTill?: number): Promise<number> => {
  const dateNow: number = Date.now()
  const expireTillCondition: boolean = new Date(expireTill) < new Date(dateNow)
  const expirationTime = expireTill && expireTillCondition? expireTill: dateNow
  if (redis) {
    return redis.zremrangebyscore(zSetKey, '-inf', expirationTime)
  }
  return Promise.resolve(0)
}

// create connection on first import
if (!redis) {
  createCacheConnection()
}

export const cache = redis
