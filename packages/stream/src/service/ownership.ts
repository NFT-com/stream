import { BigNumber, ethers } from 'ethers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore:next-line
import { nftService } from '@nftcom/gql/service'
import { _logger, contracts, db, defs, entity, helper } from '@nftcom/shared'

import { cache, CacheKeys } from './cache'

const MAX_PROCESS_BATCH_SIZE = parseInt(process.env.MAX_PROFILE_BATCH_SIZE) || 5
const logger = _logger.Factory(_logger.Context.NFT)
const repositories = db.newRepositories()

export const checksumAddress = (address: string): string | undefined => {
  try {
    return helper.checkSum(address)
  } catch (err) {
    logger.error(err, `Unable to checkSum address: ${address}`)
  }
  return
}

/**
 * Processes the Profile NFT.
 * @param existingNFT - The existing NFT entity in the database.
 * @param chainId - The chain ID of the blockchain network.
 */
const processProfileNFT = async (existingNFT: entity.NFT): Promise<void> => {
  logger.info(
    `Profile is being processed as a Profile NFT - contract ${existingNFT.contract}, tokenId: ${existingNFT.tokenId}`,
  )
  const previousWallet = await repositories.wallet.findById(existingNFT.walletId)
  if (previousWallet) {
    const profile: entity.Profile = await repositories.profile.findOne({
      where: {
        tokenId: BigNumber.from(existingNFT.tokenId).toString(),
        ownerWalletId: previousWallet.id,
        ownerUserId: previousWallet.userId,
      },
    })

    // If this NFT was the previous owner's preferred profile...
    if (profile && profile?.id === previousWallet.profileId) {
      await repositories.wallet.updateOneById(previousWallet.id, {
        profileId: null,
      })
    }
  } else {
    logger.info(`previous wallet for existing NFT ${existingNFT.id} is undefined`)
  }
}

/**
 * Handles the new owner profile.
 * @param wallet - The wallet of the new owner.
 * @param updatedNFT - The updated NFT entity.
 * @param chainId - The chain ID of the blockchain network.
 * @returns A Promise that resolves to void.
 */
const handleNewOwnerProfile = async (wallet: entity.Wallet, updatedNFT: entity.NFT, chainId: string): Promise<void> => {
  const profileQuery = {
    ownerWalletId: wallet.id,
    ownerUserId: wallet.userId,
  }
  const newOwnerProfileCount: number = await repositories.profile.count(profileQuery)

  logger.info(`New owner profiles count: ${newOwnerProfileCount}`)

  for (let i = 0; i < newOwnerProfileCount; i += MAX_PROCESS_BATCH_SIZE) {
    const newOwnerProfiles: entity.Profile[] = await repositories.profile.find({
      where: profileQuery,
      skip: i,
      take: MAX_PROCESS_BATCH_SIZE,
      select: {
        id: true,
        url: true,
      },
    })

    logger.info(`New owner profiles length: ${newOwnerProfiles.length}, batch: ${i}`)

    for (const profile of newOwnerProfiles) {
      try {
        await repositories.edge.save({
          thisEntityType: defs.EntityType.Profile,
          thatEntityType: defs.EntityType.NFT,
          thisEntityId: profile.id,
          thatEntityId: updatedNFT.id,
          edgeType: defs.EdgeType.Displays,
          hide: true,
        })
        logger.info(`updated edges for profile in ownership for profileId: ${profile.id}, url: ${profile.url}.`)
      } catch (err) {
        logger.error(
          err,
          `Error in updateEdgesWeightForProfile in ownership for profileId:${profile.id}, url: ${profile.url}`,
        )
      }

      try {
        await nftService.syncEdgesWithNFTs(profile.id)
        logger.info(`synced edges with NFTs for profile in ownership for profileId: ${profile.id}, url: ${profile.url}`)
      } catch (err) {
        logger.error(err, `Error in syncEdgesWithNFTs in ownership for profileId:${profile.id}, url: ${profile.url}`)
      }

      try {
        await Promise.all([
          cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.url]),
          cache.zrem(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, [profile.url]),
        ])
      } catch (err) {
        logger.error(err, `Error in removing cache in ownership for profileId:${profile.id}, url: ${profile.url}`)
      }
    }
  }
}

// Add these utility functions at the top of the file or in a separate utility file
const removePreviousProfileEdge = async (nftId: string): Promise<void> => {
  try {
    await repositories.edge.hardDelete({
      thatEntityId: nftId,
      edgeType: defs.EdgeType.Displays,
    })
  } catch (err) {
    logger.error(err, `Error in removing previous profile edge for walletId: nftId: ${nftId}`)
  }
}

const deleteCacheKeys = async (existingNFT: entity.NFT, chainId: string): Promise<void> => {
  try {
    const oldOwnerProfileQuery = {
      ownerWalletId: existingNFT.walletId,
      ownerUserId: existingNFT.userId,
    }

    const oldOwnerProfileCount: number = await repositories.profile.count(oldOwnerProfileQuery)

    logger.log(`Old owner profiles count: ${oldOwnerProfileCount} - query: ${JSON.stringify(oldOwnerProfileQuery)}`)

    for (let i = 0; i < oldOwnerProfileCount; i += MAX_PROCESS_BATCH_SIZE) {
      const oldOwnerProfiles: entity.Profile[] = await repositories.profile.find({
        where: oldOwnerProfileQuery,
        skip: i,
        take: MAX_PROCESS_BATCH_SIZE,
        select: {
          id: true,
          url: true,
        },
      })

      logger.info(`Old owner profiles length: ${oldOwnerProfiles.length}, batch: ${i}`)
      let cachePromise = []
      for (const profile of oldOwnerProfiles) {
        const key1 = `${CacheKeys.PROFILE_SORTED_VISIBLE_NFTS}_${chainId}_${profile.id}`,
          key2 = `${CacheKeys.PROFILE_SORTED_NFTS}_${chainId}_${profile.id}`
        cachePromise.push(cache.keys(`${key1}*`), cache.keys(`${key2}*`))
        logger.info(`Old profileId: ${profile.id}, key1: ${key1}, key2: ${key2}.`)
      }

      if (cachePromise.length) {
        try {
          const keysArray = await Promise.all(cachePromise)
          if (keysArray.length) {
            for (const keys of keysArray) {
              if (keys?.length) {
                await cache.del(...keys)
                logger.info(`Key deleted: ${keys}`)
              }
            }
          }
          cachePromise = []
        } catch (err) {
          logger.info(err, 'Error while clearing cache...')
        }
      }
    }
  } catch (err) {
    logger.error({ err, existingNFT }, `Error in deleteCacheKeys for existingNFT: ${existingNFT.id}`)
  }
}

/**
 * Handles the NFT ownership change and related caching.
 * @param wallet - The wallet of the new owner.
 * @param existingNFT - The existing NFT entity in the database.
 * @param csNewOwner - The new owner's checksum address.
 * @param chainId - The chain ID of the blockchain network.
 * @returns The updated NFT entity.
 */
const updateNFTWithWallet = async (
  wallet: entity.Wallet,
  existingNFT: entity.NFT,
  csNewOwner: string,
  chainId: string,
): Promise<entity.NFT> => {
  // Check if the ownership has changed and, if so, remove the edge of the previous profile
  if (existingNFT.userId !== wallet.userId || existingNFT.walletId !== wallet.id) {
    await removePreviousProfileEdge(existingNFT.id)

    // Delete cache keys only when the NFT userId or walletId exists
    if (existingNFT.userId || existingNFT.walletId) {
      await deleteCacheKeys(existingNFT, chainId)
    } else {
      logger.info(
        `NFT wallet id and user id are null or undefined. WalletId: ${existingNFT.walletId}, UserId: ${existingNFT.userId}`,
      )
    }

    // If this NFT is a profile NFT, process it as such
    if (
      ethers.utils.getAddress(existingNFT.contract) === ethers.utils.getAddress(contracts.nftProfileAddress(chainId))
    ) {
      await processProfileNFT(existingNFT)
    }
  }

  const updatedNFT = await repositories.nft.updateOneById(existingNFT.id, {
    owner: csNewOwner,
    userId: wallet.userId,
    walletId: wallet.id,
  })

  if (updatedNFT) {
    await nftService.indexNFTsOnSearchEngine([updatedNFT])
  }

  // Handle new owner profile
  await handleNewOwnerProfile(wallet, updatedNFT, chainId)

  return updatedNFT
}

/**
 * Updates an NFT without an associated wallet.
 * @param existingNFT - The existing NFT entity in the database.
 * @param csNewOwner - The new owner's checksum address.
 * @returns The updated NFT entity.
 */
const updateNFTWithoutWallet = async (existingNFT: entity.NFT, csNewOwner: string): Promise<entity.NFT> => {
  const updatedNFT = await repositories.nft.updateOneById(existingNFT.id, {
    owner: csNewOwner,
    walletId: null,
    userId: null,
    profileId: null,
  })
  return updatedNFT
}

/**
 * Updates the ownership of an NFT atomically.
 * @param contract - The contract address of the NFT.
 * @param tokenId - The token ID of the NFT.
 * @param prevOwner - The previous owner's address.
 * @param newOwner - The new owner's address.
 * @param chainId - The chain ID of the blockchain network.
 * @returns A Promise that resolves to void.
 */
export const atomicOwnershipUpdate = async (
  contract: string,
  tokenId: string,
  prevOwner: string,
  newOwner: string,
  chainId: string,
): Promise<void> => {
  const csContract = checksumAddress(contract),
    csPrevOwner = checksumAddress(prevOwner),
    csNewOwner = checksumAddress(newOwner)

  let hexTokenId: string

  try {
    hexTokenId = helper.bigNumberToHex(tokenId)
  } catch (err) {
    logger.error(err, 'Error while casting tokenId to hex')
    return
  }

  if (!csContract || !csPrevOwner || !csNewOwner || !hexTokenId) {
    logger.error(
      `Invalid NFT ownership transfer parameters for
      contract: ${csContract},
      tokenId: ${hexTokenId},
      previous owner: ${csPrevOwner},
      new owner: ${csNewOwner}`,
    )
    return
  }

  try {
    const wallet = await repositories.wallet.findByNetworkChainAddress('ethereum', chainId, csNewOwner)

    const existingNFT: entity.NFT = await repositories.nft.findOne({
      where: {
        contract: csContract,
        tokenId: hexTokenId,
      },
    })

    if (existingNFT) {
      if (!wallet) {
        const updatedNFT: entity.NFT = await updateNFTWithoutWallet(existingNFT, csNewOwner)
        logger.info(`Ownership transfer for non-user-owned NFT ${updatedNFT.id} completed.`)
      } else {
        const updatedNFT: entity.NFT = await updateNFTWithWallet(wallet, existingNFT, csNewOwner, chainId)
        logger.info(`Ownership transfer for user-owned NFT ${updatedNFT.id} completed.`)
      }
    } else {
      const metadata = await nftService.getNFTMetaData(csContract, hexTokenId, chainId)
      const { type, name, description, image, traits } = metadata
      const savedNFT = await repositories.nft.save({
        chainId: chainId,
        walletId: wallet?.id,
        userId: wallet?.userId,
        owner: csNewOwner,
        contract: csContract,
        tokenId: hexTokenId,
        type,
        metadata: {
          name,
          description,
          imageURL: image,
          traits: traits,
        },
      })
      await seService.indexNFTs([savedNFT])
      await nftService.updateCollectionForNFTs([savedNFT])
    }
  } catch (err) {
    logger.error(
      err,
      `Ownership transfer error for
      contract: ${csContract},
      tokenId: ${hexTokenId},
      previous owner: ${csPrevOwner},
      new owner: ${csNewOwner}`,
    )
  }
}
