import 'dotenv/config'

import { helper } from '@nftcom/shared'

export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || 'app',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_DATABASE || 'app',
  logging: helper.parseBoolean(process.env.DB_LOGGING) || false,
  useSSL: helper.parseBoolean(process.env.DB_USE_SSL) || 'true',
  subscribers: ['../../../NFT-backend/packages/shared/src/db/subscriber/*.subscriber.ts'],
}

export const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
}

export const OPENSEA_API_KEY = process.env.OPENSEA_ORDERS_API_KEY || ''
