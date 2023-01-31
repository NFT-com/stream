import { Job } from 'bull'

import { nftPortService } from '@nftcom/gql/dist/packages/gql/src/service'
import { _logger, helper } from '@nftcom/shared/src/index'

import { cache, CacheKeys } from '../service/cache'

const logger = _logger.Factory(_logger.Context.Bull)

export const syncTxsFromNFTPortHandler = async (job: Job): Promise<void> => {
  logger.log('initiated transactions sync from NFTPort')
  const address = job.data.address
  const tokenId = job.data.tokenId
  const endpoint = job.data.endpoint
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  try {
    // check recently imported
    // check in progress
    const itemPresentInRefreshedCache: number = await cache.sismember(`${CacheKeys.NFTPORT_RECENTLY_SYNCED}_${chainId}`, helper.checkSum(address) + ':' + tokenId)
    if (itemPresentInRefreshedCache) {
      return
    }

    const itemPresentInProgressCache: number = await cache.sismember(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, helper.checkSum(address) + ':' + tokenId)
    if (itemPresentInProgressCache) {
      return
    }

    // move to in progress cache
    await cache.sadd(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, helper.checkSum(address) + ':' + tokenId)
    await nftPortService.fetchTxsFromNFTPort(endpoint, 'ethereum', ['all'], address, tokenId)
    await cache.srem(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, helper.checkSum(address) + ':' + tokenId)
    await cache.sadd(`${CacheKeys.NFTPORT_RECENTLY_SYNCED}_${chainId}`, helper.checkSum(address) + ':' + tokenId)
    logger.log('completed transactions sync from NFTPort')
  } catch (err) {
    logger.error(`Error in syncTxsFromNFTPortHandler: ${err}`)
  }
}
