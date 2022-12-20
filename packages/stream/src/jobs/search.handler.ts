import { Job } from 'bull'

import { SearchEngineService } from '@nftcom/search-engine'
import { _logger,entity, utils } from '@nftcom/shared'

const logger = _logger.Factory('search.handler', _logger.Context.Bull)
const seService = SearchEngineService()

export const searchListingIndexHandler = async (job: Job): Promise<boolean> => {
  try {
    const { listings }: { listings: entity.TxOrder[] } = job.data
    const nftsWithListingUpdates = await utils.getNFTsFromTxOrders(listings)
    seService.indexNFTs(nftsWithListingUpdates)
    return Promise.resolve(true)
  } catch (err) {
    logger.error(err)
    return Promise.resolve(false)
  }
}