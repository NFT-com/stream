import { BigNumber, ethers } from 'ethers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore:next-line
import {  nftService } from '@nftcom/gql/service'
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
export const atomicOwnershipUpdate = async (
  contract: string,
  tokenId: string,
  prevOwner: string,
  newOwner: string,
  chainId: string,
): Promise<void> => {
  const csContract = checksumAddress(contract),
    csPrevOwner =  checksumAddress(prevOwner),
    csNewOwner = checksumAddress(newOwner)
  let hexTokenId

  try {
    hexTokenId = helper.bigNumberToHex(tokenId)
  } catch (err) {
    logger.error(err, 'Error while casting tokenId to hex')
  }
  if (csContract && csPrevOwner && csNewOwner && hexTokenId) {
    logger.info(
      `NFT ownership transfer started for contract: ${csContract},
      tokenId: ${hexTokenId},
      previous owner: ${csPrevOwner},
      new owner: ${csNewOwner}`,
    )
    try {
      const wallet = await repositories.wallet.findByNetworkChainAddress(
        'ethereum',
        chainId,
        csNewOwner,
      )
      let updatedNFT: entity.NFT
      const existingNFT: entity.NFT = await repositories.nft.findOne({
        where: {
          contract: csContract,
          tokenId: hexTokenId,
        },
      })
      if (existingNFT) {
        if (!wallet) {
          updatedNFT = await repositories.nft.updateOneById(existingNFT.id, {
            owner: csNewOwner,
            walletId: null,
            userId: null,
            profileId: null,
          })
        } else {
          let cachePromise = []
          // if this NFT is existing and owner changed, we change its ownership...
          if (existingNFT.userId !== wallet.userId || existingNFT.walletId !== wallet.id) {
            // we remove edge of previous profile
            // logger.log(`&&& updateNFTOwnershipAndMetadata: existingNFT.userId ${existingNFT.userId}, userId ${userId}, existingNFT.walletId ${existingNFT.walletId}, walletId ${walletId}`)

            await repositories.edge.hardDelete({
              thatEntityId: existingNFT.id,
              edgeType: defs.EdgeType.Displays,
            })
            
            // delete cache keys only when nft userId or walletId exist
            if (existingNFT.userId || existingNFT.walletId) {
              const oldOwnerProfileQuery = {
                ownerWalletId: existingNFT.walletId,
                ownerUserId: existingNFT.userId,
              }
             
              const oldOwnerProfileCount: number = await repositories.profile
                .count(oldOwnerProfileQuery)
    
              logger.log(`Old owner profiles count: ${oldOwnerProfileCount} - query: ${JSON.stringify(oldOwnerProfileQuery)}`)
    
              for (let i=0; i < oldOwnerProfileCount; i+= MAX_PROCESS_BATCH_SIZE) {
                const oldOwnerProfiles: entity.Profile[] = await repositories.profile.find({
                  where:  oldOwnerProfileQuery,
                  skip: i,
                  take: MAX_PROCESS_BATCH_SIZE,
                  select: {
                    id: true,
                    url: true,
                  },
                })
              
                logger.info(`Old owner profiles length: ${oldOwnerProfiles.length}, batch: ${i}`)
                for (const profile of oldOwnerProfiles) {
                  const key1 = `${CacheKeys.PROFILE_SORTED_VISIBLE_NFTS}_${chainId}_${profile.id}`,
                    key2 = `${CacheKeys.PROFILE_SORTED_NFTS}_${chainId}_${profile.id}`
                  cachePromise.push(
                    cache.keys(`${key1}*`),
                    cache.keys(`${key2}*`),
                  )
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
            } else {
              logger.info(`NFT wallet id and user id are null or undefined. WalletId: ${existingNFT.walletId}, UserId: ${existingNFT.userId}`)
            }
         
            // if this NFT is a profile NFT...
            if (ethers.utils.getAddress(existingNFT.contract) ==
                      ethers.utils.getAddress(contracts.nftProfileAddress(chainId))) {
              logger.info(`Profile is being processed as a Profile NFT - contract ${existingNFT.contract}, tokenId: ${hexTokenId}`)
              const previousWallet = await repositories.wallet.findById(existingNFT.walletId)
              if (previousWallet) {
                const profile: entity.Profile = await repositories.profile.findOne({ where: {
                  tokenId: BigNumber.from(existingNFT.tokenId).toString(),
                  ownerWalletId: previousWallet.id,
                  ownerUserId: previousWallet.userId,
                } })
                // if this NFT was previous owner's preferred profile...
                if (profile && profile?.id === previousWallet.profileId) {
                  await repositories.wallet.updateOneById(previousWallet.id, {
                    profileId: null,
                  })
                }
              } else {
                logger.info(`previous wallet for existing NFT ${existingNFT.id} is undefined`)
              }
            }

            updatedNFT = await repositories.nft.updateOneById(existingNFT.id, {
              owner: csNewOwner,
              userId: wallet.userId,
              walletId: wallet.id,
            })
            if(updatedNFT) {
              await nftService.indexNFTsOnSearchEngine([updatedNFT])
            }

            // new owner profile
            const profileQuery = {
              ownerWalletId: wallet.id,
              ownerUserId: wallet.userId,
            }
            const newOwnerProfileCount: number = await repositories.profile.count(profileQuery)
  
            logger.info(`New owner profiles count: ${newOwnerProfileCount}`)
  
            for (let i=0; i < newOwnerProfileCount; i += MAX_PROCESS_BATCH_SIZE) {
              const newOwnerProfiles: entity.Profile[] = await repositories.profile.find({
                where:  profileQuery,
                skip: i,
                take: MAX_PROCESS_BATCH_SIZE,
                select: {
                  id: true,
                  url: true,
                },
              })
  
              logger.info(`New owner profiles length: ${newOwnerProfiles.length}, batch: ${i}`)
  
              for (const profile of newOwnerProfiles) {
                //
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
                  logger.error(err, `Error in updateEdgesWeightForProfile in ownership for profileId:${profile.id}, url: ${profile.url}`)
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
                  //await nftService.executeUpdateNFTsForProfile(profile.id, chainId)
                  // logger.info(`executeUpdateNFTsForProfile in ownership for profileId: ${profile.id}, url: ${profile.url}`)
                } catch (err) {
                  logger.error(err, `Error in clearing cache for new profileId:${profile.id}, url: ${profile.url}`)
                }
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error(err, `Ownership transfer error for
        contract: ${csContract},
        tokenId: ${hexTokenId},
        previous owner: ${csPrevOwner},
        new owner: ${csNewOwner}`)
    }
  }
}
