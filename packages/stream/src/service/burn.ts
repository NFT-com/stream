import { db, defs, helper } from '@nftcom/shared'

interface BurnService {
  handleBurn({ contract, tokenId }: { contract: string; tokenId: string }): Promise<void>
}

export function getBurnService(repos: db.Repository = db.newRepositories()): BurnService {
  async function handleBurn({ contract, tokenId }): Promise<void> {
    const csContract = helper.checkSum(contract)
    const nft = await repos.nft.findOne({
      where: {
        contract: csContract,
        tokenId,
      },
    })
    if (nft) {
      Promise.allSettled([
        repos.nft.hardDeleteByIds([nft.id]),
        repos.edge.hardDelete({
          thatEntityType: defs.EntityType.NFT,
          thatEntityId: nft.id,
        }),
      ])
    }
  }

  return {
    handleBurn,
  }
}
export const burnService = getBurnService()
