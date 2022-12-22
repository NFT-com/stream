// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  nftService } from '@nftcom/gql/service'
import { entity,helper } from '@nftcom/shared/'

export const updateNFTOwnershipAndMetadata = async (
  order: entity.TxOrder,
  chainId: string,
  contract: string,
): Promise<void> => {
  // update NFT ownership
  const tokenId: string = helper.bigNumberToHex(
    order.protocolData?.tokenId,
  )
  const obj = {
    contract: {
      address: contract,
    },
    id: {
      tokenId,
    },
  }

  const wallet = await nftService.getUserWalletFromNFT(
    contract, tokenId, chainId,
  )
  if (wallet) {
    await nftService.updateNFTOwnershipAndMetadata(
      obj, wallet.userId, wallet.id, chainId,
    )
  }
}
