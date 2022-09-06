import Redis from 'ioredis'
import { redisConfig } from './config'

let redis: Redis
const DEFAULT_TTL_MINS = 1 // 1hr

export enum CacheKeys {
 SLUG = 'collection-slug',
 REGISTERED = 'registered-slug',
 DEREGISTER = 'deregister-slug'
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
