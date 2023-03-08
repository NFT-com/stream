/* eslint-disable no-use-before-define */
import { Job } from 'bullmq'
import { BigNumber } from 'ethers'
import * as Lodash from 'lodash'
import { IsNull } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  core,nftService } from '@nftcom/gql/service'
import { _logger, contracts, db, entity, helper } from '@nftcom/shared'

import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from '../service/cache'
import { getTimeStamp } from '../utils'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const PROFILE_NFTS_EXPIRE_DURATION = Number(process.env.PROFILE_NFTS_EXPIRE_DURATION)
const PROFILE_PROGRESS_THRESHOLD = Number(process.env.PROFILE_PROGRESS_THRESHOLD || 10)
const MAX_NFTS_TO_PROCESS = 1000

export const nftUpdateBatchProcessor = async (job: Job): Promise<boolean> => {
  logger.info(`initiated nft update batch processor for profile ${job.data.profileId} - index : ${job.data.index}`)
  try {
    const { userId, walletId, nfts } = job.data
    const chainId = job.data?.chainId || process.env.CHAIN_ID
    const savedNFTs = []
    const wallet = await repositories.wallet.findById(walletId)
    await Promise.allSettled(
      nfts.map(async (nft) => {
        const savedNFT = await nftService.updateNFTOwnershipAndMetadata(
          nft,
          userId,
          wallet,
          chainId,
        )
        if (savedNFT) savedNFTs.push(savedNFT)
      }),
    )
    if (savedNFTs.length) {
      await nftService.updateCollectionForNFTs(savedNFTs)
      await nftService.indexNFTsOnSearchEngine(savedNFTs)
    }
    return Promise.resolve(true)
  } catch (err) {
    logger.error(`Error in nftUpdateBatchProcessor ${err}`)
    return Promise.resolve(false)
  }
}

enum ProfileCacheEnum {
  PROFILE_OWNER = 'PROFILE_OWNER',
  WALLET_NFTS = 'WALLET_NFTS'
}

const removeProfileIdFromRelevantKeys = async (
  cacheType: ProfileCacheEnum,
  profileId: string,
  chainId: string,
): Promise<void> => {
  try {
    const cachePromise = []

    switch (cacheType) {
    case ProfileCacheEnum.PROFILE_OWNER:
      cachePromise.push(
        cache.zrem(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, [profileId]),
        cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profileId]),
        cache.zrem(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, [profileId]),
      )
      break
    case ProfileCacheEnum.WALLET_NFTS:
      cachePromise.push(
        cache.zrem(`${CacheKeys.PROFILE_WALLET_FAIL_SCORE}_${chainId}`, [profileId]),
        cache.zrem(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`, [profileId]),
        cache.zrem(`${CacheKeys.UPDATE_WALLET_NFTS_PROFILE}_${chainId}`, [profileId]),
      )
      break
    default:
      break
    }
    if (cachePromise.length) {
      await Promise.all(cachePromise)
    }
  } catch (err) {
    logger.error(err, '[removeProfileIdFromRelevantKeys]: Error in removeProfileIdFromRelevantKeys')
  }
}

const updateWalletNFTs = async (
  profileId: string,
  chainId: string,
): Promise<void> => {
  try {
    const profile = await repositories.profile.findById(profileId)
    if (!profile) {
      await removeProfileIdFromRelevantKeys(
        ProfileCacheEnum.WALLET_NFTS,
        profileId,
        chainId,
      )
      logger.info(`[updateWalletNFTs_0] No profile found for ID ${profile.url} (${profileId}}`)
    } else {
      // check if updating NFTs for profile is in progress.
      const inProgress = await cache.zscore(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`, profileId)
      if (inProgress) {
        const inProgressScore = Number(inProgress)
        const fails: string = await cache.zscore(`${CacheKeys.PROFILE_WALLET_FAIL_SCORE}_${chainId}`, profileId)
        const failScore = Number(fails)
        if (inProgressScore > PROFILE_PROGRESS_THRESHOLD) {
          if (failScore > inProgressScore) {
            logger.log({ profile }, `Profile stuck in progress longer than expected: profile ${profile.url} (${profile.id}), fail_score: ${failScore}`)
            await cache.zrem(`${CacheKeys.PROFILE_WALLET_FAIL_SCORE}_${chainId}`, [profile.id])
          } else {
            await cache.zadd(`${CacheKeys.UPDATE_WALLET_NFTS_PROFILE}_${chainId}`, 'INCR', 1, profile.id)
            await cache.zadd(`${CacheKeys.PROFILE_WALLET_FAIL_SCORE}_${chainId}`, 'INCR', 1, profile.id)
          }
          await cache.zrem(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`, [profile.id])
          logger.log(`Threshold crossed ${failScore + 1} times for profile ${profile.url} (${profile.id}) - current progress score: ${inProgressScore}`)
        } else {
          const score: number = Number(failScore) || 1
          await cache.zadd(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`, 'INCR', score, profile.id)
          logger.log(`Progress score incremented for profile ${profile.url} (${profile.id}) - increment: ${score}`)
        }

        logger.info(`[updateWalletNFTs_0_a] Updating NFTs for profile ${profile.url} (${profileId}) is in progress`)
      } else {
        let start: number = new Date().getTime()
        const constantStart = start
        
        nftService.initiateWeb3(chainId)
        logger.info(`[updateWalletNFTs-0_b] starting nftService.updateWalletNFTs ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
        start = new Date().getTime()
        if (profile.ownerWalletId) {
          const wallet = await repositories.wallet.findOne({
            where: {
              id: profile.ownerWalletId,
              chainId,
            },
          })
  
          if (!wallet) {
            await removeProfileIdFromRelevantKeys(
              ProfileCacheEnum.WALLET_NFTS,
              profileId,
              chainId,
            )
            logger.info(`[updateWallet_NFTs-1] No wallet found for ID ${profile.ownerWalletId} (url = ${profile.url})`)
          } else {
            await cache.zadd(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`, 'INCR', 1, profile.id)
            await nftService.updateWalletNFTs(profile.ownerUserId, wallet, chainId)
            logger.info(`[updateWalletNFTs-1] nftService.updateWalletNFTs ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
            start = new Date().getTime()
        
            await nftService.updateEdgesWeightForProfile(profile.id, wallet.id)
            logger.info(`[updateWalletNFTs-1a] nftService.updateEdgesWeightForProfile ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
            start = new Date().getTime()
        
            await nftService.saveVisibleNFTsForProfile(profile.id, repositories)
            logger.info(`[updateWalletNFTs-2a] saved amount of visible NFTs and score for profile ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
            start = new Date().getTime()
        
            await nftService.saveProfileScore(repositories, profile)
            logger.info(`[updateWalletNFTs-2b] saveProfileScore ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
            start = new Date().getTime()
        
            // refresh NFTs for associated addresses and contract
            let msg = await nftService.updateNFTsForAssociatedAddresses(
              repositories,
              profile,
              chainId,
            )
            logger.info(`[updateWalletNFTs-3] after updateNFTsForAssociatedAddresses ${msg}, ${getTimeStamp(start)}`)
            start = new Date().getTime()
        
            msg = await nftService.updateCollectionForAssociatedContract(
              repositories,
              profile,
              chainId,
              wallet.address,
            )
            logger.info(`[updateWalletNFTs-4] updateCollectionForAssociatedContract ${msg}, ${getTimeStamp(start)}`)
            start = new Date().getTime()
        
            // if gkIconVisible is true, we check if this profile owner still owns genesis key,
            if (profile.gkIconVisible) {
              await nftService.updateGKIconVisibleStatus(repositories, chainId, profile)
              logger.info(`[updateWalletNFTs-5] gkIconVisible updated for profile ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
              start = new Date().getTime()
            }
            
            // Once we update NFTs for profile, we cache it to UPDATED_NFTS_PROFILE with expire date
            const now: Date = new Date()
            now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
            const ttl = now.getTime()
            await Promise.all([
              cache.zadd(`${CacheKeys.UPDATED_WALLET_NFTS_PROFILE}_${chainId}`, ttl, profile.id),
              removeProfileIdFromRelevantKeys(
                ProfileCacheEnum.WALLET_NFTS,
                profileId,
                chainId,
              ),
            ])
          }
        } else {
          logger.log(`Owner wallet Id is null for profile id: ${profile.id} and url: ${profile.url}`)
        }
    
        logger.info(`[updateWalletNFTs-6] completed updating NFTs for profile ${profile.url} (${profile.id}), TOTAL: ${getTimeStamp(constantStart)}`)
      }
    }
  } catch (err) {
    await cache.zrem(`${CacheKeys.PROFILES_WALLET_IN_PROGRESS}_${chainId}`, [profileId])
    logger.error(`[updateWalletNFTs-error]: ${err} `)
  }
}

const processProfileUpdate = async (profileId: string, chainId: string): Promise<void> => {
  let start = new Date().getTime()
  const profile = await repositories.profile.findById(profileId)
  if (!profile) {
    await removeProfileIdFromRelevantKeys(
      ProfileCacheEnum.PROFILE_OWNER,
      profileId,
      chainId,
    )
    logger.info(`2. [processProfileUpdate] No profile found for ID ${profile.url} (${profileId}}, ${getTimeStamp(start)}`)
  } else {
    // check if updating NFTs for profile is in progress.
    const inProgress = await cache.zscore(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, profileId)
    if (inProgress) {
      const inProgressScore = Number(inProgress)
      const fails: string = await cache.zscore(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, profileId)
      const failScore = Number(fails)
      if (inProgressScore > PROFILE_PROGRESS_THRESHOLD) {
        if (failScore > inProgressScore) {
          logger.log({ profile }, `Profile stuck in progress longer than expected: profile ${profile.url} (${profile.id}), fail_score: ${failScore}`)
          await cache.zrem(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, [profile.id])
        } else {
          await cache.zadd(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, 'INCR', 1, profile.id)
          await cache.zadd(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, 'INCR', 1, profile.id)
        }
        await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
        logger.log(`Threshold crossed ${failScore + 1} times for profile ${profile.url} (${profile.id}) - current progress score: ${inProgressScore}`)
      } else {
        const score: number = Number(failScore) || 1
        await cache.zadd(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, 'INCR', score, profile.id)
        logger.log(`Progress score incremented for profile ${profile.url} (${profile.id}) - increment: ${score}`)
      }

      logger.info(`3. [processProfileUpdate] Updating NFTs for profile ${profile.url} (${profileId}) is in progress`)
    } else {
      if (profile.ownerWalletId) {
        const wallet = await repositories.wallet.findOne({
          where: {
            id: profile.ownerWalletId,
            chainId,
          },
        })
        if (!wallet) {
          await removeProfileIdFromRelevantKeys(
            ProfileCacheEnum.PROFILE_OWNER,
            profileId,
            chainId,
          )
          logger.info(`4. [processProfileUpdate] No wallet found for ID ${profile.ownerWalletId} (url = ${profile.url})`)
        } else {
          try {
            logger.info(`5. [processProfileUpdate] Updating NFTs for profile ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
            start = new Date().getTime()
  
            // keep profile to cache, so we won't repeat profiles in progress
            await cache.zadd(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, 'INCR', 1, profile.id)
            nftService.initiateWeb3(chainId)
            await nftService.checkNFTContractAddresses(
              profile.ownerUserId,
              wallet.id,
              wallet.address,
              chainId,
            )
            logger.info(`6. [processProfileUpdate] checked NFT contract addresses for profile ${profile.url} (${profile.id}), ${getTimeStamp(start)}`)
            const now: Date = new Date()
            now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
            const ttl = now.getTime()
            await Promise.all([
              cache.zadd(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, ttl, profile.id),
              removeProfileIdFromRelevantKeys(
                ProfileCacheEnum.PROFILE_OWNER,
                profileId,
                chainId,
              ),
            ])
          } catch (err) {
            logger.error(`[processProfileUpdate] Error in updateNFTsOwnershipForProfilesHandler: ${err}`)
            await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
          }
        }
      } else {
        logger.log(`Owner wallet Id is null for profile id: ${profile.id} and url: ${profile.url}`)
      }
    }
  }
}

export const updateNFTsOwnershipForProfilesHandler = async (job: Job): Promise<any> => {
  const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
  logger.info('1: [updateNFTsOwnershipForProfilesHandler]')
  try {
    // 1. remove expired profiles from the UPDATED_NFTS_PROFILE cache
    await removeExpiredTimestampedZsetMembers(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`)

    // 2. update NFTs for profiles cached in UPDATE_NFTS_PROFILE cache
    const cachedProfiles = await cache.zrevrangebyscore(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, '+inf', '(0')

    let nftsToProcess = 0
    for (const profileId of cachedProfiles) {
      if (nftsToProcess > MAX_NFTS_TO_PROCESS) {
        logger.info(`[updateNFTsOwnershipForProfilesHandler] Max NFTs to process reached: ${nftsToProcess} > ${MAX_NFTS_TO_PROCESS}`)
        break
      }

      const estimateNftsCount = await repositories.nft.count({
        profileId,
      })

      const profile = await repositories.profile.findOne({
        where: {
          id: profileId,
          chainId,
        },
      })

      // process profile before exiting (in case 1 profile > max nfts to process)
      await cache.zadd(`${CacheKeys.UPDATE_WALLET_NFTS_PROFILE}_${chainId}`, 1, profileId) //O(log(N))
      processProfileUpdate(profileId, chainId)
        .catch(err => logger.error(err))

      nftsToProcess += estimateNftsCount
      logger.info(`2. [updateNFTsOwnershipForProfilesHandler] Updating NFTs for profile ${profile.url} => (estimateNftsCount = ${estimateNftsCount})`)
    }
  } catch (err) {
    logger.error(`[updateNFTsOwnershipForProfilesHandler] Error in updateNFTsOwneshipForForProfilesHandler: ${err}`)
  }
}

export const updateNFTsForProfilesHandler = async (job: Job): Promise<any> => {
  const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
  logger.info('1: [updateNFTsForProfilesHandler] starting updateWalletNFTs (import new nfts) sync!')
  try {
    // 1. remove expired profiles from the UPDATED_NFTS_PROFILE cache
    await removeExpiredTimestampedZsetMembers(`${CacheKeys.UPDATED_WALLET_NFTS_PROFILE}_${chainId}`)

    // 2. update NFTs for profiles cached in UPDATE_NFTS_PROFILE cache
    const cachedProfiles = await cache.zrevrangebyscore(`${CacheKeys.UPDATE_WALLET_NFTS_PROFILE}_${chainId}`, '+inf', '(0')

    for (const profileId of cachedProfiles) {
      updateWalletNFTs(profileId, chainId)
        .catch(err => logger.error(err))
    }
  } catch (err) {
    logger.error(`[updateNFTsForProfilesHandler] Error in updateNFTsForProfilesHandler: ${err}`)
  }
}

export const generateCompositeImages = async (job: Job): Promise<any> => {
  try {
    logger.debug('generate composite images', job.data)

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
        logger.debug(`composite image for profile ${ profile.url } was generated`)
      }),
    )
    logger.debug('generated composite images for profiles', { counts: MAX_PROFILE_COUNTS })
  } catch (err) {
    logger.error(`Error in generateCompositeImages Job: ${err}`)
  }
}

export const saveProfileExpireAt = async (job: Job): Promise<any> => {
  try {
    logger.info('saveProfileExpireAt for profiles')
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    const MAX_PROFILE_COUNTS = 100 * 50
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
    logger.info(`Multicall response length: ${res.length}`)
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

export const profileGKOwnersHandler = async (job: Job): Promise<any> => {
  try {
    logger.info('Sync profile gk owners')
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    const ownersOfGK = await nftService.getOwnersOfGenesisKeys(chainId)
    let profileUpdatePromise = []
    const cacheProfiles = []
    const profiles: entity.Profile[] = await repositories.profile.findAllWithRelations()

    for (const profile of profiles) {
      const profileWallet: entity.Wallet = (profile as any)?.wallet
      const isIncludedInGKOwners: boolean = profileWallet?.address
        && ownersOfGK[helper.checkSum(profileWallet?.address)]

      if(isIncludedInGKOwners) {
        if (!profile?.gkIconVisible
          || profile.gkIconVisible === null
          || profile.gkIconVisible === undefined) {
          profileUpdatePromise.push({ id: profile.id, gkIconVisible: true })
        }

        // 1 - gkIconVisible
        const profileScore: string = await cache.zscore(`${CacheKeys.PROFILE_GK_OWNERS}_${chainId}`, profile.id)

        if (!Number(profileScore) || Number(profileScore) === 2) {
          cacheProfiles.push(1, profile.id)
        }
      } else  {
        if (profile.gkIconVisible
          || profile.gkIconVisible === null
          || profile.gkIconVisible === undefined) {
          profileUpdatePromise.push({ id: profile.id, gkIconVisible: false })
        }
        // 2 gkIconNotVisible
        const profileScore: string = await cache.zscore(`${CacheKeys.PROFILE_GK_OWNERS}_${chainId}`, profile.id)
        if (!Number(profileScore) || Number(profileScore) === 1) {
          cacheProfiles.push(2, profile.id)
        }
      }

      if (profileUpdatePromise.length > 50) {
        await repositories.profile.saveMany(profileUpdatePromise, { chunk: 50 })
        if (cacheProfiles.length) {
          logger.info(`[profileGKOwnersHandler-1] Sync profile gk owners cacheProfiles: ${JSON.stringify(cacheProfiles)}`)
          await cache.zadd(`${CacheKeys.PROFILE_GK_OWNERS}_${chainId}`, ...cacheProfiles)
        }
        profileUpdatePromise = []
      }
    }

    if (profileUpdatePromise.length) {
      await repositories.profile.saveMany(profileUpdatePromise, { chunk: 50 })
      if (cacheProfiles.length) {
        logger.info(`[profileGKOwnersHandler-2] Sync profile gk owners cacheProfiles: ${JSON.stringify(cacheProfiles)}`)
        await cache.zadd(`${CacheKeys.PROFILE_GK_OWNERS}_${chainId}`, ...cacheProfiles)
      }
    }

    logger.info('Sync profile gk owners end')
  } catch (err) {
    logger.error(`Error in profile gk owners Job: ${err}.`)
  }
}

export const updateNFTsForNonProfilesHandler = async (job: Job): Promise<any> => {
  let start: number = new Date().getTime()
  logger.info('[updateNFTsForNonProfilesHandler]: non-profile sync initiated')
  start = new Date().getTime()
  try {
    const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
    // 1. remove expired profiles from the UPDATED_NFTS_PROFILE cache
    await removeExpiredTimestampedZsetMembers(`${CacheKeys.UPDATED_NFTS_NON_PROFILE}_${chainId}`)

    // 2. update NFTs for profiles cached in UPDATE_NFTS_PROFILE cache
    const cachedWallets = await cache.zrevrangebyscore(`${CacheKeys.UPDATE_NFTS_NON_PROFILE}_${chainId}`, '+inf', '(0')
    for (const walletId of cachedWallets) {
      if (walletId) {
        const wallet: entity.Wallet = await repositories.wallet.findById(walletId)
        const profile: entity.Profile = await repositories.profile.findOne({
          where: {
            ownerWalletId: wallet.id,
            chainId: wallet.chainId,
          },
        })
        if (wallet && wallet.userId && !profile) {
          try {
            logger.log(`[updateNFTsForNonProfilesHandler]: Wallet id being processed: ${walletId}, profile: ${profile}, ${getTimeStamp(start)}}`)
            start = new Date().getTime()

            await nftService.updateWalletNFTs(wallet.userId, wallet, chainId)
            // Once NFTs for non-profile wallet are updated, cache it to UPDATED_NFTS_NON_PROFILE with expire date
            const now: Date = new Date()
            now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
            const ttl = now.getTime()
            await Promise.all([
              cache.zadd(`${CacheKeys.UPDATED_NFTS_NON_PROFILE}_${chainId}`, ttl, walletId),
              cache.zrem(`${CacheKeys.NON_PROFILES_IN_PROGRESS}_${chainId}`, [walletId]),
              cache.zrem(`${CacheKeys.UPDATE_NFTS_NON_PROFILE}_${chainId}`, [walletId]),
            ])
            logger.log(`[updateNFTsForNonProfilesHandler]: Finished processing wallet id: ${walletId}, ${getTimeStamp(start)}}`)
            start = new Date().getTime()
          } catch (err) {
            logger.error(err, `[updateNFTsForNonProfilesHandler]: Error in updateWalletNFTs while processing wallet: ${walletId}`)
          }
        } else {
          if (!wallet.userId) {
            logger.log(`[ updateNFTsForNonProfilesHandler]: Wallet Id: ${walletId} does not have an associated user!`)
          }
  
          if (profile) {
            logger.log(`[updateNFTsForNonProfilesHandler]: Wallet Id: ${walletId} has at least one profile ${profile.id} - url: ${profile.url}`)
            await Promise.all([
              cache.zrem(`${CacheKeys.UPDATE_NFTS_NON_PROFILE}_${chainId}`, [walletId]),        // remove non profile update
              cache.zadd(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, 'INCR', 1, profile.id), // add in profile update
            ])
          }
        }
      } else {
        logger.log(`[updateNFTsForNonProfilesHandler]: WalletId is incorrect: ${walletId}, ${getTimeStamp(start)}}`)
        start = new Date().getTime()
      }
    }
    
    logger.info(`[updateNFTsForNonProfilesHandler]: non-profile sync completed, ${getTimeStamp(start)}`)
    start = new Date().getTime()
  } catch (err) {
    logger.error(err, `[updateNFTsForNonProfilesHandler]: Error in non-profile sync job, ${getTimeStamp(start)}`)
  }
}