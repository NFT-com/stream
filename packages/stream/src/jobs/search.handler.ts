import { Job } from 'bull'
import { LessThanOrEqual, MoreThanOrEqual } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { searchEngineService } from '@nftcom/gql/service'
import { _logger, db, defs, entity, utils } from '@nftcom/shared'

const logger = _logger.Factory('search.handler', _logger.Context.Bull)
const seService = searchEngineService.SearchEngineService()
const repos = db.newRepositories()

export const searchListingIndexHandler = async (job: Job): Promise<boolean> => {
  logger.log('intiated listing sync')
  try {
    const listings: entity.TxActivity[] = await repos
      .txActivity
      .find({ where: [{
        activityType: defs.ActivityType.Listing,
        updatedAt: MoreThanOrEqual(new Date(job.timestamp)),
      }, {
        activityType: defs.ActivityType.Listing,
        updatedAt: LessThanOrEqual(Date.now()),
      }],
      })
    logger.log(`total listings in search index sync: ${listings.length}`)
    if (listings) {
      try {
        const nftsWithListingUpdates = await utils.getNFTsFromTxActivities(listings)
        logger.log(`nft with listing updates: ${nftsWithListingUpdates.length}`)
        await seService.indexNFTs(nftsWithListingUpdates)
      } catch (err) {
        logger.error(`Error in getNFTs or indexNFTs: ${err}`)
      }
    }
    logger.log('completed listing sync')
    return Promise.resolve(true)
  } catch (err) {
    logger.error(`search index listing sync error: ${err}`)
    return Promise.resolve(false)
  }
}