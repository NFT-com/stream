import { Job } from 'bull'
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

const updateWalletNFTs = async (
  profile: entity.Profile,
  wallet: entity.Wallet,
  chainId: string,
): Promise<void> => {
  try {
    let start: number = new Date().getTime()
    const constantStart = start
    nftService.initiateWeb3(chainId)
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
      cache.zadd(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, ttl, profile.id),
      cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id]),
      cache.zrem(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, [profile.id]),
      cache.zrem(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, [profile.id]),
    ])

    logger.info(`[updateWalletNFTs-6] completed updating NFTs for profile ${profile.url} (${profile.id}), TOTAL: ${getTimeStamp(constantStart)}`)
  } catch (err) {
    await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
    await cache.zadd(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, 'INCR', 1, profile.id)
    logger.error(`[updateWalletNFTs-error]: ${err}`)
  }
}

export const updateNFTsForProfilesHandler = async (job: Job): Promise<any> => {
  const chainId: string =  job.data?.chainId || process.env.CHAIN_ID
  logger.info('1: [updateNFTsForProfilesHandler]')
  try {
    // 1. remove expired profiles from the UPDATED_NFTS_PROFILE cache
    await removeExpiredTimestampedZsetMembers(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`)

    // 2. update NFTs for profiles cached in UPDATE_NFTS_PROFILE cache
    const cachedProfiles = await cache.zrevrangebyscore(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, '+inf', '(0')

    for (const profileId of cachedProfiles) {
      const profile = await repositories.profile.findById(profileId)
      if (!profile) {
        logger.info(`2. [updateNFTsForProfilesHandler] No profile found for ID ${profile.url} (${profileId}}`)
      } else {
        // check if updating NFTs for profile is in progress
        const inProgress = await cache.zscore(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, profileId)
        if (inProgress) {
          const inProgressScore = Number(inProgress)
          if (inProgressScore > PROFILE_PROGRESS_THRESHOLD) {
            await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
            await cache.zadd(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, 'INCR', 1, profile.id)
          } else {
            const failScore: string =  await cache.zscore(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, profileId)
            await cache.zadd(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, 'INCR', Number(failScore), profile.id)
          }

          logger.info(`3. [updateNFTsForProfilesHandler] Updating NFTs for profile ${profile.url} (${profileId}) is in progress`)
        } else {
          // const updateBegin = Date.now()
          const wallet = await repositories.wallet.findOne({
            where: {
              id: profile.ownerWalletId,
              chainId,
            },
          })
          if (!wallet) {
            logger.info(`4. [updateNFTsForProfilesHandler] No wallet found for ID ${profile.ownerWalletId} (url = ${profile.url})`)
          } else {
            try {
              // keep profile to cache, so we won't repeat profiles in progress
              await cache.zadd(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, 'INCR', 1, profile.id)
              nftService.initiateWeb3(chainId)
              await nftService.checkNFTContractAddresses(
                profile.ownerUserId,
                wallet.id,
                wallet.address,
                chainId,
              )
              logger.info(`5. [updateNFTsForProfilesHandler] checked NFT contract addresses for profile ${profile.url} (${profile.id})`)
              await updateWalletNFTs(
                profile,
                wallet,
                chainId,
              )
            } catch (err) {
              logger.error(`[updateNFTsForProfilesHandler] Error in updateNFTsForProfilesHandler: ${err}`)
              await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
              await cache.zadd(`${CacheKeys.PROFILE_FAIL_SCORE}_${chainId}`, 'INCR', 1, profile.id)
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error(`[updateNFTsForProfilesHandler] Error in updateNFTsForProfilesHandler: ${err}`)
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
    logger.error(`Error in profile gk owners Job: ${err}`)
  }
}
