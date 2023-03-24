// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  alchemyService, nftService } from '@nftcom/gql/service'
import { defs, entity, helper } from '@nftcom/shared'
import { _logger } from '@nftcom/shared'

import { NFT_NftPort, NFTAlchemy } from '../../interface'
import { NFTPortRarityAttributes } from '../../service/nftPort'

const logger = _logger.Factory('nftBuilder', _logger.Context.Bull)

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

const checkSumOwner = (owner: string): string | undefined => {
  try {
    return helper.checkSum(owner)
  } catch (err) {
    logger.error(err, `Unable to checkSum owner ${owner}`)
  }
  return
}

// for NftPort CryptoPunks specifically
export const nftEntityBuilderCryptoPunks = (
  nft: NFT_NftPort,
  chainId: string,
): entity.NFT => {
  const csOwner = checkSumOwner(nft.owner)
  return {
    contract: helper.checkSum(nft.contract_address),
    tokenId: helper.bigNumberToHex(nft.token_id),
    type: nftService.getNftType(undefined, nft), // skip alchemy, pass in nftport nft
    owner: csOwner,
    metadata: {
      name: nft?.metadata?.name,
      description: '',
      imageURL: nft?.cached_file_url,
      traits: nftService.getMetadataTraits(undefined, { nft }),
    },
    chainId,
  } as entity.NFT
}

export const nftEntityBuilder = async (
  nft: NFTAlchemy & { owner: string },
  chainId: string,
): Promise<entity.NFT> => {
  const csOwner = checkSumOwner(nft.owner)
  return {
    contract: helper.checkSum(nft.contract.address),
    tokenId: helper.bigNumberToHex(nft.id.tokenId),
    type: nftService.getNftType(nft),
    owner: csOwner,
    metadata: {
      name: nftService.getNftName(
        nft,
        undefined,
        nft.contractMetadata,
        helper.bigNumberToString(nft.id.tokenId),
      ),
      description: nftService.getNftDescription(nft, undefined, nft.contractMetadata),
      imageURL: await nftService.getNftImage(nft),
      traits: nftService.getMetadataTraits(nft?.metadata),
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
            && String(rarityAttribute?.value || '').trim() === String(attribute?.value || '').trim()) {
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