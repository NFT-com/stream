import { Job } from 'bull'
import { BigNumber } from 'ethers'
import * as Lodash from 'lodash'
import { IsNull } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  core,nftService } from '@nftcom/gql/service'
import { _logger, contracts, db, entity } from '@nftcom/shared'

import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from '../service/cache'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const PROFILE_NFTS_EXPIRE_DURATION = Number(process.env.PROFILE_NFTS_EXPIRE_DURATION)

export const nftUpdateBatchProcessor = async (job: Job): Promise<boolean> => {
  logger.info(`initiated nft update batch processor for profile ${job.data.profileId} - index : ${job.data.index}`)
  try {
    const { userId, walletId, nfts } = job.data
    const chainId = job.data?.chainId || process.env.CHAIN_ID
    const savedNFTs = []
    await Promise.allSettled(
      nfts.map(async (nft) => {
        const savedNFT = await nftService.updateNFTOwnershipAndMetadata(
          nft,
          userId,
          walletId,
          chainId,
        )
        if (savedNFT) savedNFTs.push(savedNFT)
      }),
    )
    if (savedNFTs.length) {
      await nftService.indexNFTsOnSearchEngine(savedNFTs)
      await nftService.updateCollectionForNFTs(savedNFTs)
    }
    return Promise.resolve(true)
  } catch (err) {
    logger.error(`Error in nftUpdateBatchProcessor ${err}`)
    return Promise.resolve(false)
  }
}

const updateWalletNFTs = async (
  profileId: string,
  profile: entity.Profile,
  userId: string,
  walletId: string,
  walletAddress: string,
  chainId: string,
): Promise<void> => {
  try {
    nftService.initiateWeb3(chainId)
    await nftService.updateWalletNFTs(userId, walletId, walletAddress, chainId)
    logger.info(`updated wallet NFTs for profile ${profileId}`)
    await nftService.updateEdgesWeightForProfile(profile.id, walletId)
    logger.info(`updated edges for profile ${profile.id}`)
    await nftService.syncEdgesWithNFTs(profile.id)
    logger.info(`synced edges with NFTs for profile ${profile.id}`)
    await Promise.all([
      nftService.saveVisibleNFTsForProfile(profile.id, repositories),
      nftService.saveProfileScore(repositories, profile),
    ])
    logger.info(`saved amount of visible NFTs and score for profile ${profile.id}`)
    // refresh NFTs for associated addresses and contract
    let msg = await nftService.updateNFTsForAssociatedAddresses(
      repositories,
      profile,
      chainId,
    )
    logger.info(msg)
    msg = await nftService.updateCollectionForAssociatedContract(
      repositories,
      profile,
      chainId,
      walletAddress,
    )
    logger.info(msg)
    // if gkIconVisible is true, we check if this profile owner still owns genesis key,
    if (profile.gkIconVisible) {
      await nftService.updateGKIconVisibleStatus(repositories, chainId, profile)
      logger.info(`gkIconVisible updated for profile ${profile.id}`)
    }
    // Once we update NFTs for profile, we cache it to UPDATED_NFTS_PROFILE with expire date
    const now: Date = new Date()
    now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
    const ttl = now.getTime()
    await Promise.all([
      cache.zadd(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, ttl, profile.id),
      cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id]),
      cache.zrem(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, [profile.id]),
    ])

    logger.info(`completed updating NFTs for profile ${profile.id}`)
  } catch (err) {
    logger.error(`Error in updateWalletNFTs: ${err}`)
  }
}

export const updateNFTsForProfilesHandler = async (job: Job): Promise<any> => {
  const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
  logger.info('update nfts for profiles')
  try {
    // 1. remove expired profiles from the UPDATED_NFTS_PROFILE cache
    await removeExpiredTimestampedZsetMembers(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`)
    // 2. update NFTs for profiles cached in UPDATE_NFTS_PROFILE cache
    const cachedProfiles = await cache.zrevrangebyscore(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, '+inf', '(0')
    for (const profileId of cachedProfiles) {
      const profile = await repositories.profile.findById(profileId)
      if (!profile) {
        logger.info(`No profile found for ID ${profileId}`)
      } else {
        // check if updating NFTs for profile is in progress
        const inProgress = await cache.zscore(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, profileId)
        if (inProgress) {
          logger.info(`Updating NFTs for profile ${profileId} is in progress`)
        } else {
          // const updateBegin = Date.now()
          const wallet = await repositories.wallet.findOne({
            where: {
              id: profile.ownerWalletId,
              chainId,
            },
          })
          if (!wallet) {
            logger.info(`No wallet found for ID ${profile.ownerWalletId}`)
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
              logger.info(`checked NFT contract addresses for profile ${profile.id}`)
              await updateWalletNFTs(
                profileId,
                profile,
                profile.ownerUserId,
                wallet.id,
                wallet.address,
                chainId,
              )
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

export const generateCompositeImages = async (job: Job): Promise<any> => {
  try {
    logger.debug('generate Composite Images', job.data)

    const MAX_PROFILE_COUNTS = 200
    const profiles = await repositories.profile.find({
      where: {
        photoURL: IsNull(),
      },
    })
    const slicedProfiles = profiles.slice(0, MAX_PROFILE_COUNTS)
    await Promise.allSettled(
      slicedProfiles.map(async (profile) => {
        const imageURL = await core.generateCompositeImage(profile.url, core.DEFAULT_NFT_IMAGE)
        await repositories.profile.updateOneById(profile.id, {
          photoURL: imageURL,
        })
        logger.debug(`Composite Image for Profile ${ profile.url } was generated`)
      }),
    )
    logger.debug('generated composite images for profiles', { counts: MAX_PROFILE_COUNTS })
  } catch (err) {
    logger.error(`Error in generateCompositeImages Job: ${err}`)
  }
}

export const saveProfileExpireAt = async (job: Job): Promise<any> => {
  try {
    logger.info('Save expireAt for profiles')
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    const MAX_PROFILE_COUNTS = 100 * 2
    const profiles = await repositories.profile.find({
      where: {
        expireAt: IsNull(),
        chainId,
      },
    })
    const slicedProfiles = profiles.slice(0, MAX_PROFILE_COUNTS)
    const profileChunks = Lodash.chunk(slicedProfiles, 100)
    const calls = []
    profileChunks.map((profiles) => {
      const urls = profiles.map((profile) => profile.url)
      calls.push({
        contract: contracts.nftProfileAddress(chainId),
        name: 'getExpiryTimeline',
        params: [urls],
      })
    })
    const abi = contracts.NftProfileABI()
    const res = await core.fetchDataUsingMulticall(calls, abi, chainId)
    logger.info(`multicall: ${res}`)
    logger.info(`multicall response length: ${res.length}`)
    logger.info(`multicall response: ${res[0]}`)
    for (let i = 0; i < profileChunks.length; i++) {
      const result = res[i][0]
      for (let j = 0; j < profileChunks[i].length; j++) {
        const timestamp = BigNumber.from(result[j]).toString()
        if (Number(timestamp) !== 0) {
          const expireAt = new Date(Number(timestamp) * 1000)
          await repositories.profile.updateOneById(profileChunks[i][j].id, { expireAt })
        }
      }
    }
    logger.info(`Saved expireAt for ${slicedProfiles.length} profiles`)
  } catch (err) {
    logger.error(`Error in saveProfileExpireAt Job: ${err}`)
  }
}
