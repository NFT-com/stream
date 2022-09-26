import Bull, { Job } from 'bull'
import { _logger, db, defs,entity, helper } from 'nftcom-backend/shared'

import { retrieveMultipleOrdersLooksrare } from '../looksrare'
import { OpenseaOrderRequest, retrieveMultipleOrdersOpensea } from '../opensea'
import { nftCronSubqueue } from './jobs'

const repositories = db.newRepositories()
const logger = _logger.Factory(_logger.Context.Bull)

const MAX_PROCESS_BATCH_SIZE = 1500

const subQueueBaseOptions: Bull.JobOptions = {
  attempts: 3,
  removeOnComplete: true,
  removeOnFail: true,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
}

// batch processor
const nftExternalOrderBatchProcessor = async (job: Job): Promise<void> => {
  logger.debug(`initiated external orders batch processor for ${job.data.exchange} | series: ${job.data.offset} | batch:  ${job.data.limit}`)
  try {
    const { offset, limit, exchange } = job.data
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    const nfts: entity.NFT[] = await repositories.nft.find({
      where: { chainId, deletedAt: null },
      select: ['contract', 'tokenId', 'chainId'],
      skip: offset,
      take: limit,
    })

    if (nfts.length && exchange) {
      const nftRequest: Array<OpenseaOrderRequest> = nfts.map((nft: any) => ({
        contract: nft.contract,
        tokenId: helper.bigNumber(nft.tokenId).toString(),
        chainId: nft.chainId,
      }))

      const persistActivity = []

      switch (exchange) {
      case defs.ExchangeType.OpenSea:
        await retrieveMultipleOrdersOpensea(nftRequest, chainId, false)
        break
      case defs.ExchangeType.LooksRare:
        await retrieveMultipleOrdersLooksrare(nftRequest, chainId, false)
        break
      }

      // settlements should not depend on each other
      await Promise.allSettled(persistActivity)
      logger.debug(`completed external orders for ${job.data.exchange} | series: ${job.data.offset} | batch:  ${job.data.limit}`)
    }
  } catch (err) {
    logger.error(`Error in nftExternalOrders Job: ${err}`)
  }
}

export const nftExternalOrders = async (job: Job): Promise<void> => {
  logger.debug('initiated external orders for nfts', job.data)
  try {
    if (!nftCronSubqueue) {
      await job.moveToFailed({ message: 'nft-cron-queue is not defined!' })
    }

    const existingJobs: Bull.Job[] = await nftCronSubqueue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
    // clear existing jobs
    if (existingJobs.flat().length) {
      nftCronSubqueue.obliterate({ force: true })
    }
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    const nftCount: number = await repositories.nft.count({ chainId, deletedAt: null })
    logger.log('nft external order count', String(nftCount))
    const limit: number = MAX_PROCESS_BATCH_SIZE
    let offset = 0
    // sub-queue assignmemt

    // sub-queue job additions
    for (let i=0; i < nftCount; i+=MAX_PROCESS_BATCH_SIZE) {
      offset = i
      if (job.id === 'fetch_os_orders') {
        // opensea
        nftCronSubqueue.add({ offset, limit, chainId, exchange: defs.ExchangeType.OpenSea }, {
          ...subQueueBaseOptions,
          jobId: `nft-batch-processor-opensea|offset:${offset}|limit:${limit}-chainId:${chainId}`,
        })
      } else {
        // looksrare
        nftCronSubqueue.add({ offset, limit, chainId, exchange: defs.ExchangeType.LooksRare  }, {
          ...subQueueBaseOptions,
          jobId: `nft-batch-processor-looksrare|offset:${offset}|limit:${limit}-chainId:${chainId}`,
        })
      }
    }

    // process subqueues in series; hence concurrency is explicitly set to one for rate limits
    nftCronSubqueue.process(1, nftExternalOrderBatchProcessor)

    logger.debug('updated external orders for nfts')
  } catch (err) {
    logger.error(`Error in nftExternalOrders Job: ${err}`)
  }
}