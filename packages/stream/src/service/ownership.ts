import { BigNumber, ethers } from 'ethers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore:next-line
import { nftService } from '@nftcom/gql/service'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { searchEngineService } from '@nftcom/gql/service'
import { _logger, contracts, db, defs, entity, helper } from '@nftcom/shared'

import { cache, CacheKeys } from './cache'

const MAX_PROCESS_BATCH_SIZE = parseInt(process.env.MAX_PROFILE_BATCH_SIZE) || 5
const logger = _logger.Factory(_logger.Context.NFT)
const repositories = db.newRepositories()
const seService = searchEngineService.SearchEngineService()
const BATCH_THRESHOLD_MAX = 500 // Define the threshold for batch processing
const BATCH_PROCESSING_SEC = 5000 // 5 seconds
let batchIntervalId: NodeJS.Timeout | null = null;

// Define the type for an NFT item
type NFTItem = {
  contract: string
  tokenId: string
  schema: string | null
  chainId: string
  csNewOwner: string
  walletId: string
  userId: string
}

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
const handleNewOwnerProfile = async (wallet: Partial<entity.Wallet>, updatedNFT: entity.NFT, chainId: string): Promise<void> => {
  // wallet must be defined
  if (!wallet?.id || !wallet?.userId) return

  const profileQuery = {
    ownerWalletId: wallet?.id,
    ownerUserId: wallet?.userId,
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

// Function to process a batch of NFT items
const batchProcessNFTs = async (nftItems: NFTItem[]): Promise<void> => {
  const startNewNFT = new Date().getTime()

  // Build the batch request for token URIs
  const tokenUriBatch = nftItems.map((item) => {
    return { contractAddress: item.contract, tokenId: item.tokenId, schema: item.schema }
  })

  // Batch call to get token URIs
  const tokenUris = await nftService.batchCallTokenURI(tokenUriBatch, nftItems[0].chainId)

  // Process each item in the batch
  for (let i = 0; i < nftItems.length; i++) {
    try {
      const item = nftItems[i]
      const { contract: csContract, tokenId: hexTokenId, schema, chainId, csNewOwner, walletId, userId } = item

      let parsedMetadata = undefined
      if (schema && tokenUris[i]) {
        parsedMetadata = await nftService.parseNFTUriString(tokenUris[i], hexTokenId)
      }

      // If the parsed name isn't found, fetch the name from collection table
      if (parsedMetadata && !parsedMetadata.name) {
        parsedMetadata.name = (await repositories.collection.findOne({
          where: { contract: csContract }
        }))?.name + ' #' + Number(hexTokenId).toString()
      }

      // If the parsed description isn't found, fetch the description from collection table
      if (parsedMetadata && !parsedMetadata.description) {
        parsedMetadata.description = (await repositories.collection.findOne({
          where: { contract: csContract }
        }))?.description
      }

      // Determine if the parsed metadata is valid (has both image and name)
      const validParsedMetadata = parsedMetadata?.image && parsedMetadata?.name

      // Get metadata, either from parsed data or from nftService.getNFTMetaData
      const metadata = validParsedMetadata
        ? parsedMetadata
        : await nftService.getNFTMetaData(csContract, hexTokenId, chainId, true, false, true)
      const { type, name, description, image, traits } = metadata

      // check if nft exists in db
      const existingNFT = await repositories.nft.findOne({
        where: { contract: csContract, tokenId: hexTokenId, chainId: chainId }
      })

      // If the NFT doesn't exist, create it
      if (!existingNFT) {
        const savedNFT = await repositories.nft.save({
          chainId: chainId,
          walletId: walletId,
          userId: userId,
          owner: csNewOwner,
          contract: csContract,
          tokenId: hexTokenId,
          type: type ?? schema?.toUpperCase(),
          uriString: tokenUris[i],
          metadata: { name, description, imageURL: image, traits }
        })

        // Index, update collection, and handle new owner profile for the saved NFT
        await seService.indexNFTs([savedNFT])
        await nftService.updateCollectionForNFTs([savedNFT])
        await handleNewOwnerProfile({ id: walletId, userId: userId }, savedNFT, chainId)

        logger.info(`${validParsedMetadata ? '[Internal Metadata]' : '[Alchemy Metadata]'} streamingFast: new NFT ${schema ? `${schema}/` : ''}${csContract}/${hexTokenId} (owner=${csNewOwner}) uri=${tokenUris[0]}, ${tokenUris[0] !== undefined ? `parsedUri=${JSON.stringify(parsedMetadata, null, 2)}, ` : ',\n'}savedMetadata=${JSON.stringify({
          name,
          description,
          imageURL: image,
          traits: traits,
        })} saved in db ${savedNFT.id} completed in ${new Date().getTime() - startNewNFT}ms`)
      } else {
        // If the NFT already exists, update it if the new owner is different
        if (existingNFT.owner !== csNewOwner || existingNFT.uriString !== tokenUris[i] ||
          existingNFT.walletId !== walletId || existingNFT.userId !== userId) {
            const updatedNFT = await repositories.nft.updateOneById(existingNFT.id, {
              uriString: tokenUris[i],
              metadata: { name, description, imageURL: image, traits },
              owner: csNewOwner,
              walletId: walletId,
              userId: userId,
            })

            await seService.indexNFTs([updatedNFT])
            await nftService.updateCollectionForNFTs([updatedNFT])
            await handleNewOwnerProfile({ id: walletId, userId: userId }, updatedNFT, chainId)

            logger.info(`${validParsedMetadata ? '[Internal Metadata]' : '[Alchemy Metadata]'} streamingFast: updated NFT ${schema ? `${schema}/` : ''}${csContract}/${hexTokenId} (owner=${csNewOwner}) uri=${tokenUris[0]}, ${tokenUris[0] !== undefined ? `parsedUri=${JSON.stringify(parsedMetadata, null, 2)}, ` : ',\n'}savedMetadata=${JSON.stringify({
              name,
              description,
              imageURL: image,
              traits: traits,
            })} updated in db ${updatedNFT.id} completed in ${new Date().getTime() - startNewNFT}ms`)
        }
      }
    } catch (error) {
      // Log error message and continue processing the next item
      logger.error(`[streamingFast]: Error processing NFT item ${i}: ${error.message}`);
    }
  }
}

const handleNewNFTItem = async (newItem: NFTItem): Promise<void> => {
  // Use SADD to add the newItem to the Redis set (duplicates are automatically ignored)
  await cache.sadd(CacheKeys.STREAMING_FAST_QUEUE, JSON.stringify(newItem))

  // If the interval is not already set, set it up
  if (!batchIntervalId) {
    batchIntervalId = setInterval(async () => {
      // Get the current size of the Redis set
      const setSize = await cache.scard(CacheKeys.STREAMING_FAST_QUEUE)

      // If the set is not empty, process the items in the set
      if (setSize > 0) {
        // Retrieve all items from the Redis set
        const currentBatch = await cache.smembers(CacheKeys.STREAMING_FAST_QUEUE)
        const parsedBatch = currentBatch.map(item => JSON.parse(item))

        // Remove the processed items from the Redis set
        await cache.del(CacheKeys.STREAMING_FAST_QUEUE)

        logger.info(
          { nfts: parsedBatch, threshold: BATCH_THRESHOLD_MAX },
          `[streamingFast | Cron ${BATCH_PROCESSING_SEC / 1000}s]: Processing ${parsedBatch.length} NFTs...`
        )
        // Trigger the batch process for the items in the parsedBatch
        await batchProcessNFTs(parsedBatch)
      }
    }, BATCH_PROCESSING_SEC)
  }

  // Check if the set size has reached the threshold
  const setSize = await cache.scard(CacheKeys.STREAMING_FAST_QUEUE)

  // Check if the queue size has reached the threshold
  if (setSize >= BATCH_THRESHOLD_MAX) {
    // If the interval is active, clear it
    if (batchIntervalId) {
      clearInterval(batchIntervalId)
      batchIntervalId = null
    }

    // Retrieve all items from the Redis set
    const currentBatch = await cache.smembers(CacheKeys.STREAMING_FAST_QUEUE)
    const parsedBatch = currentBatch.map(item => JSON.parse(item))
    
    // Remove the processed items from the Redis set
    await cache.del(CacheKeys.STREAMING_FAST_QUEUE)

    logger.info(
      { nfts: parsedBatch, threshold: BATCH_THRESHOLD_MAX },
      `[streamingFast]: Batch threshold reached. Processing ${parsedBatch.length} NFTs...`
    )
    // Trigger the batch process for the items in the parsedBatch
    await batchProcessNFTs(parsedBatch)
  }
}

/**
 * Updates the ownership of an NFT atomically
 * @param contract - The contract address of the NFT.
 * @param tokenId - The token ID of the NFT.
 * @param prevOwner - The previous owner's address.
 * @param newOwner - The new owner's address.
 * @param chainId - The chain ID of the blockchain network.
 * @returns A Promise that resolves to void
 */
export const atomicOwnershipUpdate = async (
  contract: string,
  tokenId: string,
  prevOwner: string,
  newOwner: string,
  chainId: string,
  schema?: string
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
        logger.debug(`Ownership transfer for non-user-owned NFT ${updatedNFT.id} completed.`)
      } else {
        const updatedNFT: entity.NFT = await updateNFTWithWallet(wallet, existingNFT, csNewOwner, chainId)
        logger.debug(`Ownership transfer for user-owned NFT ${updatedNFT.id} completed.`)
      }
    } else {
      const startNewNFT = new Date().getTime()
      
      // if schema exists, batch calls as it is request from streaming fast
      if (schema) {
        // batch up calls for tokenURI / URI to decrease the number of infura calls
        await handleNewNFTItem({ contract: csContract, tokenId: hexTokenId, schema, chainId, csNewOwner, walletId: wallet?.id, userId: wallet?.userId })
      } else {
        // Get metadata from nftService.getNFTMetaData
        const metadata = await nftService.getNFTMetaData(csContract, hexTokenId, chainId, true, false, true)
        const { type, name, description, image, traits } = metadata

        // Save the NFT data to the database
        const savedNFT = await repositories.nft.save({
          chainId: chainId,
          walletId: wallet?.id,
          userId: wallet?.userId,
          owner: csNewOwner,
          contract: csContract,
          tokenId: hexTokenId,
          type: type,
          uriString: '', // Use appropriate value for uriString in this scenario
          metadata: {
            name,
            description,
            imageURL: image,
            traits: traits,
          },
        })

        await seService.indexNFTs([savedNFT])
        await nftService.updateCollectionForNFTs([savedNFT])
        await handleNewOwnerProfile(wallet, savedNFT, chainId)
        logger.info(
          `[Non-Schema Alchemy Metadata] streamingFast: new NFT ${csContract}/${hexTokenId} (owner=${csNewOwner}) savedMetadata=${JSON.stringify({
            name,
            description,
            imageURL: image,
            traits: traits,
          })} saved in db ${savedNFT.id} completed in ${new Date().getTime() - startNewNFT}ms`
        )
      }
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