import Bull, { Job } from 'bull'
import * as Lodash from 'lodash'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  nftService } from '@nftcom/gql/service'
import { _logger, db } from '@nftcom/shared'

import { cache, CacheKeys, removeExpiredTimestampedZsetMembers } from '../cache'
import { nftUpdateSubqueue } from './jobs'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

// const PROFILE_NFTS_EXPIRE_DURATION = Number(process.env.PROFILE_NFTS_EXPIRE_DURATION)
const MAX_BATCH_SIZE = 30
const CONCURRENCY_NUMBER = 5

const subQueueBaseOptions: Bull.JobOptions = {
  attempts: 3,
  removeOnComplete: true,
  removeOnFail: true,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
}

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
  userId: string,
  walletId: string,
  walletAddress: string,
  chainId: string,
  job: Job,
): Promise<void> => {
  try {
    nftService.initiateWeb3(chainId)
    const ownedNFTs = await nftService.getNFTsFromAlchemy(walletAddress)
    logger.info(`Fetched ${ownedNFTs.length} NFTs from alchemy for wallet ${walletAddress} on chain ${chainId}`)
    if (!ownedNFTs.length) return
    if (!nftUpdateSubqueue) {
      await job.moveToFailed({ message: 'nft-update-queue is not defined!' })
    }
    const existingJobs: Bull.Job[] = await nftUpdateSubqueue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
    // clear existing jobs
    if (existingJobs.flat().length) {
      await nftUpdateSubqueue.obliterate({ force: true })
    }
    const chunks = Lodash.chunk(ownedNFTs, MAX_BATCH_SIZE)
    for (let i = 0; i< chunks.length; i++) {
      await nftUpdateSubqueue.add({
        chainId,
        userId,
        walletId,
        profileId,
        nfts: chunks[i],
        index: i,
      }, {
        ...subQueueBaseOptions,
        jobId: `nft-update-processor-|profileId:${profileId}|index:${i}-chainId:${chainId}`,
      })
    }

    let completedJobs = 0
    // process subqueues to fetch NFT info in series
    nftUpdateSubqueue.process(CONCURRENCY_NUMBER, nftUpdateBatchProcessor)
    nftUpdateSubqueue.on('global:completed', (jobId, result) => {
      // Job completed
      logger.info(`Job Id ${jobId} is completed - ${JSON.stringify(result)}`)
      completedJobs++
      if (completedJobs === chunks.length) {
        // All jobs are completed
        logger.info(`updated wallet NFTs for profile ${profileId}`)
      }
    })
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
                profile.ownerUserId,
                wallet.id,
                wallet.address,
                chainId,
                job,
              )
              logger.info(`updated wallet NFTs for profile ${profileId}`)
              // await nftService.updateEdgesWeightForProfile(profile.id, profile.ownerWalletId)
              // logger.info(`updated edges with weight for profile ${profile.id}`)
              // await nftService.syncEdgesWithNFTs(profile.id)
              // logger.info(`synced edges with NFTs for profile ${profile.id}`)
              // // save visible NFT amount of profile
              // await nftService.saveVisibleNFTsForProfile(profile.id, repositories)
              // logger.info(`saved amount of visible NFTs to profile ${profile.id}`)
              // // refresh NFTs for associated addresses
              // let msg = await nftService.updateNFTsForAssociatedAddresses(
              //   repositories,
              //   profile,
              //   chainId,
              // )
              // logger.info(msg)
              // msg = await nftService.updateCollectionForAssociatedContract(
              //   repositories,
              //   profile,
              //   chainId,
              //   wallet.address,
              // )
              // logger.info(msg)
              // // if gkIconVisible is true, we check if this profile owner still owns genesis key,
              // if (profile.gkIconVisible) {
              //   await nftService.updateGKIconVisibleStatus(repositories, chainId, profile)
              //   logger.info(`gkIconVisible updated for profile ${profile.id}`)
              // }
              // // save profile score
              // await nftService.saveProfileScore(repositories, profile)
              // logger.info(`updated score for profile ${profile.id}`)
              // 3. Once we update NFTs for profile, we cache it to UPDATED_NFTS_PROFILE with expire date
              // const now: Date = new Date()
              // now.setMilliseconds(now.getMilliseconds() + PROFILE_NFTS_EXPIRE_DURATION)
              // const ttl = now.getTime()
              // await cache.zadd(`${CacheKeys.UPDATED_NFTS_PROFILE}_${chainId}`, ttl, profile.id)
              // await cache.zrem(`${CacheKeys.UPDATE_NFTS_PROFILE}_${chainId}`, [profile.id])
              // await cache.zrem(`${CacheKeys.PROFILES_IN_PROGRESS}_${chainId}`, [profile.id])
              // const updateEnd = Date.now()
              // logger.info(`updateNFTsForProfile for profile ${profile.id} took ${(updateEnd - updateBegin) / 1000} seconds`)
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
