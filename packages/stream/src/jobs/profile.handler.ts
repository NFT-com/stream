import { Job } from 'bull'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  nftService } from '@nftcom/gql/service'
import { _logger, db } from '@nftcom/shared'

import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from '../cache'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const PROFILE_NFTS_EXPIRE_DURATION = Number(process.env.PROFILE_NFTS_EXPIRE_DURATION)

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
            try {
              // keep profile to cache, so we won't repeat profiles in progress
              await cache.zadd(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, 'INCR', 1, profile.id)

              await nftService.checkNFTContractAddresses(
                profile.ownerUserId,
                wallet.id,
                wallet.address,
                chainId,
              )
              logger.debug(`checked NFT contract addresses for profile ${profile.id}`)
              await nftService.updateWalletNFTs(
                profile.ownerUserId,
                wallet.id,
                wallet.address,
                chainId,
              )
              logger.debug(`updated wallet NFTs for profile ${profile.id}`)
              await nftService.updateEdgesWeightForProfile(profile.id, profile.ownerWalletId)
              logger.debug(`updated edges with weight for profile ${profile.id}`)
              await nftService.syncEdgesWithNFTs(profile.id)
              logger.debug(`synced edges with NFTs for profile ${profile.id}`)
              // save visible NFT amount of profile
              await nftService.saveVisibleNFTsForProfile(profile.id, repositories)
              logger.debug(`saved amount of visible NFTs to profile ${profile.id}`)
              // refresh NFTs for associated addresses
              let msg = await nftService.updateNFTsForAssociatedAddresses(
                repositories,
                profile,
                chainId,
              )
              logger.debug(msg)
              msg = await nftService.updateCollectionForAssociatedContract(
                repositories,
                profile,
                chainId,
                wallet.address,
              )
              logger.debug(msg)
              // if gkIconVisible is true, we check if this profile owner still owns genesis key,
              if (profile.gkIconVisible) {
                await nftService.updateGKIconVisibleStatus(repositories, chainId, profile)
                logger.debug(`gkIconVisible updated for profile ${profile.id}`)
                const updateEnd = Date.now()
                logger.debug(`updateNFTsForProfile for profile ${profile.id} took ${(updateEnd - updateBegin) / 1000} seconds`)
              } else {
                const updateEnd = Date.now()
                logger.debug(`updateNFTsForProfile for profile ${profile.id} took ${(updateEnd - updateBegin) / 1000} seconds`)
              }
              // save profile score
              await nftService.saveProfileScore(repositories, profile)
              logger.debug(`updated score for profile ${profile.id}`)
              // 3. Once we update NFTs for profile, we cache it to UPDATED_NFTS_PROFILE with expire date
              const now: Date = new Date()
              now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
              const ttl = now.getTime()
              await cache.zadd(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, ttl, profile.id)
              await cache.zrem(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, [profile.id])
              await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
            } catch (err) {
              logger.error(`Error in updateNFTsForProfilesHandler: ${err}`)
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Error in updateNFTsForProfilesHandler: ${err}`)
  }
}
