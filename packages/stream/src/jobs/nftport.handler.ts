import { Job } from 'bullmq'
import { BigNumber } from 'ethers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { nftPortService } from '@nftcom/gql/service'
import { _logger, helper } from '@nftcom/shared'

import { cache, CacheKeys } from '../service/cache'

const logger = _logger.Factory(_logger.Context.Bull)

const NFTPORT_EXPIRE_DURATION = 12 * 60 * 60000 // 12 hours

export const syncTxsFromNFTPortHandler = async (job: Job): Promise<void> => {
  logger.log(`initiated transactions sync from NFTPort : ${JSON.stringify(job.data)}`)
  const address = job.data.address
  const tokenId = job.data.tokenId
  const endpoint = job.data.endpoint
  const chainId: string = job.data.chainId || process.env.chainId || '5'
  if (!address && !tokenId && !endpoint) return
  try {
    const key = tokenId ? helper.checkSum(address) + '::' + BigNumber.from(tokenId).toHexString() : helper.checkSum(address)
    const chain = (chainId === '1' || chainId === '5') ? 'ethereum' : 'goerli'
    await nftPortService.fetchTxsFromNFTPort(endpoint, chain, ['all'], address, tokenId)
    // Once we fetch transactions for collection or NFT, we cache it to NFTPORT_RECENTLY_SYNCED with expire date
    const now: Date = new Date()
    now.setMilliseconds(now.getMilliseconds() + NFTPORT_EXPIRE_DURATION)
    const ttl = now.getTime()
    await Promise.all([
      cache.zadd(`${CacheKeys.NFTPORT_RECENTLY_SYNCED}_${chainId}`, ttl, key),
      cache.zrem(`${CacheKeys.NFTPORT_SYNC_IN_PROGRESS}_${chainId}`, [key]),
      cache.zrem(`${CacheKeys.NFTPORT_TO_SYNC}_${chainId}`, [key]),
    ])
    logger.info(`Completed transactions sync from NFTPort for address ${address}, tokenId ${tokenId}, endpoint ${endpoint}`)
  } catch (err) {
    logger.error(`Error in syncTxsFromNFTPortHandler: ${err}`)
  }
}
