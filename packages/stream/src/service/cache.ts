import Redis from 'ioredis'

import { redisConfig } from '../config'

let redis: Redis
const DEFAULT_TTL_MINS = Number(process.env.DEFAULT_TTL_MINS) || 15 // 15 mins

export enum CacheKeys {
  REFRESH_NFT_ORDERS_EXT = 'refresh_nft_orders_ext',
  REFRESHED_NFT_ORDERS_EXT = 'refreshed_nft_orders_ext',
  REFRESH_COLLECTION_RARITY= 'refresh_collection_rarity',
  REFRESHED_COLLECTION_RARITY= 'refreshed_collection_rarity',
  UPDATED_NFTS_PROFILE = 'updated_nfts_profile',
  UPDATE_NFTS_PROFILE = 'update_nfts_profile',
  PROFILES_IN_PROGRESS = 'profiles_in_progress',
  SLUG = 'collection-slug',
  REGISTERED = 'registered-slug',
  DEREGISTER = 'deregister-slug',
  SYNCED_OS = 'synced_os',
  SYNCED_LR = 'synced_lr',
  SYNC_COLLECTION = 'sync_collection',
  SPAM_COLLECTIONS = 'spam_collections',
  SYNC_IN_PROGRESS = 'sync_in_progress',
  RECENTLY_SYNCED = 'recently_synced',
  COLLECTION_ISSUANCE_DATE = 'collection_issuance_date',
  COLLECTION_ISSUANCE_DATE_IN_PROGRESS = 'collection_issuance_date_in_progress',
  PROFILE_GK_OWNERS = 'profile_gk_owners',
  NFTPORT_RECENTLY_SYNCED = 'nftport_recently_synced',
  NFTPORT_SYNC_IN_PROGRESS = 'nftport_sync_in_progress',
  NFTPORT_TO_SYNC = 'nftport_to_sync',
}

const createCacheConnection = (): void => {
  redis = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
  })
}

export const ttlForTimestampedZsetMembers = (ttl?: Date): number => {
  const currentTime: Date = new Date(ttl? ttl: Date.now())
  if (!ttl) {
    currentTime.setMinutes(currentTime.getMinutes() + DEFAULT_TTL_MINS)
  }
  return currentTime.getTime()
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
