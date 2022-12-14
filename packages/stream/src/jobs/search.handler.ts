import { Job } from 'bull'
import { SearchEngineService } from '@nftcom/search-engine'
import { db, entity, _logger } from '@nftcom/shared'

const logger = _logger.Factory('search.handler', _logger.Context.Bull)
const repositories = db.newRepositories()
const seService = new SearchEngineService()

export const searchListingIndexHandler = async (job: Job): Promise<boolean> => {
  try {
    const { listings }: { listings: entity.TxOrder[] } = job.data
    const nftsWithListingUpdates: entity.NFT[] = []
    for (const listing of listings) {
      for (const nftId of listing.activity.nftId) {
        const idParts = nftId.split('/')
        nftsWithListingUpdates.push(await repositories.nft.findOne({
          where: {
            contract: idParts[1],
            tokenId: idParts[2],
          }
        }))
      }
    }
    seService.indexNFTs(nftsWithListingUpdates)
    return Promise.resolve(true)
  } catch (err) {
    logger.error(err)
    return Promise.resolve(false)
  }
}