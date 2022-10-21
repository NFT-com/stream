// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  alchemyService,nftService } from '@nftcom/gql/service'
import { defs, entity, helper } from '@nftcom/shared'

import { NFTAlchemy } from '../../interface'

export const collectionEntityBuilder = async (
  contract: string,
  chainId: string,
): Promise<Partial<entity.Collection>> => {
  // get collection info
  let collectionName = await nftService.getCollectionNameFromContract(
    contract,
    chainId,
    defs.NFTType.ERC721,
  )
  if (collectionName === 'Unknown Name') {
    collectionName = await nftService.getCollectionNameFromContract(
      contract,
      chainId,
      defs.NFTType.ERC1155,
    )
  }
    
  // check if deployer of associated contract is in associated addresses
  const deployer = await alchemyService.getCollectionDeployer(contract, chainId)
  return {
    contract,
    name: collectionName,
    chainId,
    deployer,
  }
}

// TODO: record more information, maybe re-use update logic from up updateNFTMetadata
// @rohan, @jason
export const nftEntityBuilder = (
  nft: NFTAlchemy,
  chainId: string,
): entity.NFT => {
  return {
    contract: helper.checkSum(nft.contract.address),
    tokenId: helper.bigNumberToHex(nft.id.tokenId),
    type: nft.id.tokenMetadata.tokenType,
    metadata: {
      name: nft.metadata.name,
      description: nft.description,
      imageURL: nft.metadata.image,
      traits: [],
    },
    chainId,
    userId: 'test',
    walletId: 'test',

  } as entity.NFT
}