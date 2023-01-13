// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  alchemyService, nftService } from '@nftcom/gql/service'
import { defs, entity, helper } from '@nftcom/shared'

import { NFT_NftPort, NFTAlchemy } from '../../interface'
import { NFTPortRarityAttributes } from '../../service/nftPort'

export const collectionEntityBuilder = async (
  contract: string,
  isOfficial: boolean,
  isSpam: boolean,
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
    isOfficial,
    isSpam,
  }
}

// for NftPort CryptoPunk specifically
export const nftEntityBuilderCryptoPunks = (
  nft: NFT_NftPort,
  chainId: string,
): entity.NFT => {
  return {
    contract: helper.checkSum(nft.contract_address),
    tokenId: helper.bigNumberToHex(nft.token_id),
    type: nftService.getNftType(undefined, nft), // skip alchemy, pass in nftport nft
    metadata: {
      name: nft?.metadata?.name,
      description: '',
      imageURL: nft?.cached_file_url,
      traits: nftService.getMetadata(undefined, nft),
    },
    chainId,
  } as entity.NFT
}

export const nftEntityBuilder = (
  nft: NFTAlchemy,
  chainId: string,
): entity.NFT => {
  return {
    contract: helper.checkSum(nft.contract.address),
    tokenId: helper.bigNumberToHex(nft.id.tokenId),
    type: nftService.getNftType(nft),
    metadata: {
      name: nft?.title || nft?.metadata?.name,
      description: nftService.getNftDescription(nft),
      imageURL: nftService.getNftImage(nft?.metadata),
      traits: nftService.getMetadata(nft?.metadata),
    },
    chainId,
  } as entity.NFT
}

// traits with rarity
export const nftTraitBuilder = (
  nftAttributes: defs.Trait[],
  rarityAttributes: NFTPortRarityAttributes[],
): defs.Trait[] => {
  const traits: defs.Trait[] = []
  if (nftAttributes.length) {
    for (const attribute of nftAttributes) {
      const traitExists: NFTPortRarityAttributes = rarityAttributes.find(
        (rarityAttribute: NFTPortRarityAttributes) => {
          if (rarityAttribute?.trait_type === attribute?.type
            && rarityAttribute?.value.trim() === attribute?.value.trim()) {
            return rarityAttribute
          }
        },
      )
      let traitsToBePushed: defs.Trait = {
        ...attribute,
      }

      if (traitExists) {
        traitsToBePushed = {
          ...traitsToBePushed,
          type: traitExists?.trait_type || attribute?.type || '',
          value: traitExists?.value || attribute?.value|| '',
        }
        if (traitExists?.statistics?.prevalence) {
          traitsToBePushed = {
            ...traitsToBePushed,
            rarity: String(traitExists.statistics.prevalence || '0'),
          }
        }
      }

      traits.push(
        traitsToBePushed,
      )
    }
  }
  return traits
}