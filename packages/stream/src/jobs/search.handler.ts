import { Job } from 'bull'
import { MoreThanOrEqual } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { searchEngineService } from '@nftcom/gql/service'
import { _logger, db, defs, entity, utils } from '@nftcom/shared'

const logger = _logger.Factory('search.handler', _logger.Context.Bull)
const seService = searchEngineService.SearchEngineService()
const repos = db.newRepositories()

export const searchListingIndexHandler = async (job: Job): Promise<boolean> => {
  try {
    const listings: entity.TxActivity[] = await repos
      .txActivity
      .find({ where: {
        activityType: defs.ActivityType.Listing,
        updatedAt: MoreThanOrEqual(new Date(job.timestamp)),
      } })
    if (listings) {
      const nftsWithListingUpdates = await utils.getNFTsFromTxActivities(listings)
      await seService.indexNFTs(nftsWithListingUpdates)
    }
    return Promise.resolve(true)
  } catch (err) {
    logger.error(err)
    return Promise.resolve(false)
  }
}