import  { Job } from 'bullmq'

import { _logger } from '@nftcom/shared'

import { DistinctContract } from '../interface'
import { allowedEvents, fetchAllNFTs, mapContractsToSlugs } from '../pipeline'
import { cache, CacheKeys } from '../service/cache'
import { client } from '../service/opensea'

const logger = _logger.Factory(_logger.Context.Bull)
export const registerStreamHandler = async (job: Job): Promise<any> => {
  logger.debug('register stream handler', job.data)
  try {
    const contractSlugs = await cache.smembers(CacheKeys.SLUG)
    let slugSubscription
    const slugSubscriptionCachePromise = []
    if (contractSlugs.length) {
      for (const contractSlug of contractSlugs) {
        const slugSplit = contractSlug.split(':')
        const slug = slugSplit?.[1]
        const isSlugRegistered: any = await cache.get(`${CacheKeys.REGISTERED}-${slug}`)
        if (slug && !isSlugRegistered) {
          slugSubscription = client.onEvents(
            slug,
            [
              ...allowedEvents,
            ],
            (event) => {
              // @TODO: slug based filtering
              logger.debug('---event---', event.event_type)
            },
          )
          slugSubscriptionCachePromise.push(cache.set(`${CacheKeys.REGISTERED}-${slug}`, JSON.stringify(slugSubscription)))
        }
      }
    }

    await Promise.all(slugSubscriptionCachePromise)
    logger.info('register stream handler', job.id)
  } catch (err) {
    logger.error(`Error in register stream handler: ${err}`)
  }
}

export const deregisterStreamHandler = async (job: Job): Promise<any> => {
  logger.debug('deregister stream handler', job.data)
  try {
    const keyPattern = `${CacheKeys.REGISTERED}-*`
    const keyScan = await cache.scan(0, 'MATCH', keyPattern)
    for(const key of keyScan) {
      // @TODO: deregister
      logger.debug('---deregister key---', key)
    }
    logger.info('deregister stream handler', job.id)
  } catch (err) {
    logger.error(`Error in deregister stream handler: ${err}`)
  }
}

export const syncContractsHandler =  async (job: Job): Promise<any> => {
  logger.debug('sync contracts handler', job.data)
  try {
    const allDistinctContracts: DistinctContract[] = await fetchAllNFTs()
    await mapContractsToSlugs(allDistinctContracts)
    logger.info('sync contract stream handler', job.id)
  } catch (err) {
    logger.error(`Error in sync contract stream handler: ${err}`)
  }
}