import { Job } from 'bull'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { searchEngineService } from '@nftcom/gql/service'
import { _logger,entity, utils } from '@nftcom/shared'

const logger = _logger.Factory('search.handler', _logger.Context.Bull)
const seService = searchEngineService.SearchEngineService()

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