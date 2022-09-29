import { Job } from 'bull'
import { ethers } from 'ethers'

import { saveProfileScore, saveVisibleNFTsForProfile } from '@nftcom/gql/resolver/nft.resolver'
import {
  checkNFTContractAddresses, getOwnersOfGenesisKeys, syncEdgesWithNFTs,
  updateCollectionForAssociatedContract,
  updateEdgesWeightForProfile, updateNFTsForAssociatedAddresses,
  updateWalletNFTs,
} from '@nftcom/gql/service/nft.service'
import { _logger, db, entity } from '@nftcom/shared'

import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from '../cache'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const PROFILE_NFTS_EXPIRE_DURATION = Number(process.env.PROFILE_NFTS_EXPIRE_DURATION)

const updateGKIconVisibleStatus = async (
  repositories: db.Repository,
  chainId: string,
  profile: entity.Profile,
): Promise<void> => {
  try {
    const gkOwners = await getOwnersOfGenesisKeys(chainId)
    const wallet = await repositories.wallet.findById(profile.ownerWalletId)
    const index = gkOwners.findIndex((owner) => ethers.utils.getAddress(owner) === wallet.address)
    if (index === -1) {
      await repositories.profile.updateOneById(profile.id, { gkIconVisible: false })
    } else {
      return
    }
  } catch (err) {
    logger.error(`Error in updateGKIconVisibleStatus: ${err}`)
    throw err
  }
}

export const updateNFTsForProfilesHandler = async (job: Job): Promise<any> => {
  const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
  logger.debug('update nfts for profiles', job.data)
  try {
    // 1. remove expired profiles from the UPDATED_NFTS_PROFILE cache
    await removeExpiredTimestampedZsetMembers(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`)
    // 2. update NFTs for profiles cached in UPDATE_NFTS_PROFILE cache
    const cachedProfiles = await cache.zrevrangebyscore(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, '+inf', '(0')
    for (const profileId of cachedProfiles) {
      const profile = await repositories.profile.findById(profileId)
      if (!profile) {
        logger.debug(`No profile found for ID ${profileId}`)
      } else {
        // check if updating NFTs for profile is in progress
        const inProgress = await cache.zscore(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, profileId)
        if (inProgress) {
          logger.debug(`Updating NFTs for profile ${profileId} is in progress`)
        } else {
          const updateBegin = Date.now()
          const wallet = await repositories.wallet.findOne({
            where: {
              id: profile.ownerWalletId,
              chainId,
            },
          })
          if (!wallet) {
            logger.debug(`No wallet found for ID ${profile.ownerWalletId}`)
          } else {
            // keep profile to cache, so we won't repeat profiles in progress
            await cache.zadd(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, 'INCR', 1, profile.id)

            await checkNFTContractAddresses(profile.ownerUserId, wallet.id, wallet.address, chainId)
            logger.debug(`checked NFT contract addresses for profile ${profile.id}`)
            await updateWalletNFTs(profile.ownerUserId, wallet.id, wallet.address, chainId)
            logger.debug(`updated wallet NFTs for profile ${profile.id}`)
            await updateEdgesWeightForProfile(profile.id, profile.ownerWalletId)
            logger.debug(`updated edges with weight for profile ${profile.id}`)
            await syncEdgesWithNFTs(profile.id)
            logger.debug(`synced edges with NFTs for profile ${profile.id}`)
            // save visible NFT amount of profile
            await saveVisibleNFTsForProfile(profile.id, repositories)
            logger.debug(`saved amount of visible NFTs to profile ${profile.id}`)
            // refresh NFTs for associated addresses
            let msg = await updateNFTsForAssociatedAddresses(repositories, profile, chainId)
            logger.debug(msg)
            msg = await updateCollectionForAssociatedContract(
              repositories,
              profile,
              chainId,
              wallet.address,
            )
            logger.debug(msg)
            // if gkIconVisible is true, we check if this profile owner still owns genesis key,
            if (profile.gkIconVisible) {
              await updateGKIconVisibleStatus(repositories, chainId, profile)
              logger.debug(`gkIconVisible updated for profile ${profile.id}`)
              const updateEnd = Date.now()
              logger.debug(`updateNFTsForProfile for profile ${profile.id} took ${(updateEnd - updateBegin) / 1000} seconds`)
            } else {
              const updateEnd = Date.now()
              logger.debug(`updateNFTsForProfile for profile ${profile.id} took ${(updateEnd - updateBegin) / 1000} seconds`)
            }
            // save profile score
            await saveProfileScore(repositories, profile)
            logger.debug(`updated score for profile ${profile.id}`)
            // 3. Once we update NFTs for profile, we cache it to UPDATED_NFTS_PROFILE with expire date
            const now: Date = new Date()
            now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
            const ttl = now.getMilliseconds()
            await cache.zadd(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, ttl, profile.id)
            await cache.zrem(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, [profile.id])
            await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Error in updateNFTsForProfilesHandler: ${err}`)
  }
}
