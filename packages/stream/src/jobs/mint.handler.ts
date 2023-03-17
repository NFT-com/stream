import { Job } from 'bullmq'
import { BigNumber, ethers, utils } from 'ethers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  core, HederaConsensusService, nftService } from '@nftcom/gql/service'
import { _logger, contracts, db, defs, helper, provider } from '@nftcom/shared'

import { cache } from '../service/cache'
import { checksumAddress } from '../service/ownership'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const MAX_BLOCKS = 100000 // we use this constant to split blocks to avoid any issues to get logs for event...
const MAX_LOGS = 1000

/**
 * recursive method to split blocks for getting event logs
 * @param provider
 * @param fromBlock
 * @param toBlock
 * @param address
 * @param topics
 * @param maxBlocks
 * @param currentStackLv
  * @param totalLogs
 */
const splitGetLogs = async (
  provider: ethers.providers.BaseProvider,
  fromBlock: number,
  toBlock: number,
  address: string,
  topics: any[],
  maxBlocks: number,
  currentStackLv: number,
  totalLogs: number,
): Promise<{
  logs: ethers.providers.Log[]
  lastProcessedBlock: number
}> => {
  // Check if we've exceeded the maximum number of logs
  if (totalLogs > MAX_LOGS) {
    logger.info(`[splitGetLogs] Exceeded maximum number of logs (${MAX_LOGS}), fromBlock: ${fromBlock}, toBlock: ${toBlock}, totalLogs: ${totalLogs}`)
    return { logs: [], lastProcessedBlock: toBlock }
  }

  // Split block range in half...
  const midBlock = (fromBlock + toBlock) >> 1

  // eslint-disable-next-line no-use-before-define
  const first = await getPastLogs(
    provider,
    address,
    topics,
    fromBlock,
    midBlock,
    maxBlocks,
    currentStackLv + 1,
    totalLogs, // Pass total logs to the next recursive call
  )

  // eslint-disable-next-line no-use-before-define
  const last = await getPastLogs(
    provider,
    address,
    topics,
    midBlock + 1,
    toBlock,
    maxBlocks,
    currentStackLv + 1,
    totalLogs + first.logs.length, // Update total logs with the length of the first half
  )

  return {
    logs: [...first.logs, ...last.logs],
    lastProcessedBlock: last.lastProcessedBlock || first.lastProcessedBlock,
  }
}

/**
 * get past event logs
 * @param provider
 * @param address
 * @param topics
 * @param fromBlock
 * @param toBlock
 * @param maxBlocks
 * @param currentStackLv
 */
export const getPastLogs = async (
  provider: ethers.providers.BaseProvider,
  address: string,
  topics: any[],
  fromBlock: number,
  toBlock: number,
  maxBlocks?: number,
  currentStackLv = 0,
  totalLogs = 0, // New parameter to track total logs
): Promise<{
  logs: ethers.providers.Log[]
  lastProcessedBlock: number
}> => {
  // Check if we've exceeded the maximum number of logs
  if (totalLogs > MAX_LOGS) {
    logger.info(`[getPastLogs] Exceeded maximum number of logs (${MAX_LOGS}), fromBlock: ${fromBlock}, toBlock: ${toBlock}, totalLogs: ${totalLogs}`)
    return { logs: [], lastProcessedBlock: toBlock }
  }

  if (fromBlock > toBlock) {
    logger.info(`[getPastLogs] fromBlock (${fromBlock}) is greater than toBlock (${toBlock}), returning empty logs`)
    return { logs: [], lastProcessedBlock: toBlock }
  }

  const max_Blocks = maxBlocks ??= MAX_BLOCKS

  try {
    // If there are too many blocks, we will split it up...
    if (toBlock - fromBlock > max_Blocks) {
      logger.info(`Recursive getting logs from ${fromBlock} to ${toBlock}`)

      return await splitGetLogs(
        provider,
        fromBlock,
        toBlock,
        address,
        topics,
        max_Blocks,
        currentStackLv,
        totalLogs,
      )
    } else {
      // We just get logs using provider...
      logger.info(`Getting logs from ${fromBlock} to ${toBlock}`)

      const filter = {
        address: utils.getAddress(address),
        fromBlock,
        toBlock,
        topics,
      }

      const logs = await provider.getLogs(filter)

      // Update total logs with the length of the logs retrieved
      return { logs, lastProcessedBlock: toBlock }
    }
  } catch (e) {
    logger.error('Error while getting past logs: ', e)

    return { logs: [], lastProcessedBlock: toBlock }
  }
}

enum EventName {
  AssociateEvmUser = 'AssociateEvmUser',
  CancelledEvmAssociation = 'CancelledEvmAssociation',
  ClearAllAssociatedAddresses = 'ClearAllAssociatedAddresses',
  AssociateSelfWithUser = 'AssociateSelfWithUser',
  RemovedAssociateProfile = 'RemovedAssociateProfile',
  SetAssociatedContract = 'SetAssociatedContract',
  ExtendExpiry = 'ExtendExpiry',
  Transfer = 'Transfer',
}

type Log = {
  logs: ethers.providers.Log[]
  latestBlockNumber: number
}

const profileAuctionInterface = new utils.Interface(contracts.profileAuctionABI())
const nftResolverInterface = new utils.Interface(contracts.NftResolverABI())
const profileInterface = new utils.Interface(contracts.NftProfileABI())

export const getCachedBlock = async (chainId: number, key: string): Promise<number> => {
  const startBlock = chainId == 5 ? 7128515 :
    chainId == 1 ? 14675454 :
      14675454

  try {
    const cachedBlock = await cache.get(key)

    // get 1000 blocks before incase of some blocks not being handled correctly
    if (cachedBlock) return Number(cachedBlock) > 1000
      ? Number(cachedBlock) - 1000 : Number(cachedBlock)
    else return startBlock
  } catch (e) {
    logger.error(`Error in getCachedBlock: ${e}`)
    return startBlock
  }
}

export const chainIdToCacheKeyProfileAuction = (chainId: number): string => {
  return `minted_profile_cached_block_${chainId}`
}

export const chainIdToCacheKeyResolverAssociate = (chainId: number): string => {
  return `resolver_associate_cached_block_${chainId}`
}

export const chainIdToCacheKeyProfile = (chainId: number): string => {
  return `profile_cached_block_${chainId}`
}

export const getResolverEvents = async (
  topics: any[],
  chainId: number,
  provider: ethers.providers.BaseProvider,
  address: string,
): Promise<Log> => {
  const latestBlock = await provider.getBlock('latest')
  try {
    const maxBlocks = process.env.MINTED_PROFILE_EVENTS_MAX_BLOCKS
    const key = chainIdToCacheKeyResolverAssociate(chainId)
    const cachedBlock = await getCachedBlock(chainId, key)
    const logs = await getPastLogs(
      provider,
      address,
      topics,
      cachedBlock,
      latestBlock.number,
      Number(maxBlocks),
    )
    return {
      logs: logs.logs,
      latestBlockNumber: logs.lastProcessedBlock,
    }
  } catch (e) {
    logger.error(`Error in getResolverEvents: ${e}`)
    return {
      logs: [],
      latestBlockNumber: latestBlock.number,
    }
  }
}

export const getMintedProfileEvents = async (
  topics: any[],
  chainId: number,
  provider: ethers.providers.BaseProvider,
  address: string,
): Promise<Log> => {
  const latestBlock = await provider.getBlock('latest')
  try {
    const maxBlocks = process.env.MINTED_PROFILE_EVENTS_MAX_BLOCKS
    const key = chainIdToCacheKeyProfileAuction(chainId)
    const cachedBlock = await getCachedBlock(chainId, key)
    logger.info(`minted_profile_cached_block: ${cachedBlock}`)
    const logs = await getPastLogs(
      provider,
      address,
      topics,
      cachedBlock,
      latestBlock.number,
      Number(maxBlocks),
    )
    return {
      logs: logs.logs,
      latestBlockNumber: logs.lastProcessedBlock,
    }
  } catch (e) {
    logger.error(`Error in getMintedProfileEvents: ${e}`)
    return {
      logs: [],
      latestBlockNumber: latestBlock.number,
    }
  }
}

export const getProfileEvents = async (
  topics: any[],
  chainId: number,
  provider: ethers.providers.BaseProvider,
  address: string,
): Promise<Log> => {
  const latestBlock = await provider.getBlock('latest')
  try {
    const maxBlocks = process.env.MINTED_PROFILE_EVENTS_MAX_BLOCKS
    const key = chainIdToCacheKeyProfile(chainId)
    const cachedBlock = await getCachedBlock(chainId, key)
    const logs = await getPastLogs(
      provider,
      address,
      topics,
      cachedBlock,
      latestBlock.number,
      Number(maxBlocks),
    )
    return {
      logs: logs.logs,
      latestBlockNumber: logs.lastProcessedBlock,
    }
  } catch (e) {
    logger.error(`Error in getProfileEvents: ${e}`)
    return {
      logs: [],
      latestBlockNumber: latestBlock.number,
    }
  }
}

export const nftResolverParseLog = (log: any): any => {
  return nftResolverInterface.parseLog(log)
}

export const profileAuctionParseLog = (log: any): any => {
  return profileAuctionInterface.parseLog(log)
}

export const profileParseLog = (log: any): any => {
  return profileInterface.parseLog(log)
}

const topics = [
  helper.id('MintedProfile(address,string,uint256,uint256,uint256,address)'),
]

const topics2 = [
  [
    helper.id('AssociateEvmUser(address,string,address)'),
    helper.id('CancelledEvmAssociation(address,string,address)'),
    helper.id('ClearAllAssociatedAddresses(address,string)'),
    helper.id('AssociateSelfWithUser(address,string,address)'),
    helper.id('RemovedAssociateProfile(address,string,address)'),
  ],
]

const topics3 = [
  [
    helper.id('ExtendExpiry(string,uint256)'),
    helper.id('Transfer(address,address,uint256)'),
  ],
]

const syncMintedProfileEvents = async (
  chainId: number,
  chainProvider: ethers.providers.BaseProvider,
  profileAuctionAddress: `0x${string}`,
): Promise<void> => {
  const log = await getMintedProfileEvents(
    topics,
    Number(chainId),
    chainProvider,
    profileAuctionAddress,
  )
  logger.info(`minted profile events ${log.latestBlockNumber}`)

  logger.info(`minted profile events chainId=${chainId} length=${log.logs.length}`)
  await Promise.allSettled(
    log.logs.map(async (unparsedEvent) => {
      try {
        const evt = profileAuctionParseLog(unparsedEvent)
        logger.info(`Found event MintedProfile with chainId: ${chainId}`)
        const [owner, profileUrl, tokenId] = evt.args
        logger.info(`minted profile owner=${owner} profileUrl=${profileUrl} tokenId=${BigNumber.from(tokenId).toString()}`)

        if (evt.name === 'MintedProfile') {
          const tx = await chainProvider.getTransaction(unparsedEvent.transactionHash)
          logger.info(`minted profile tx data: ${tx.data}`)
          logger.info(`minted profile tx hash: ${unparsedEvent.transactionHash}`)
          const batchClaimFace = new ethers.utils.Interface(['function genesisKeyBatchClaimProfile((string,uint256,address,bytes32,bytes)[])'])
          let gkTokenId
          try {
            const res = batchClaimFace.decodeFunctionData('genesisKeyBatchClaimProfile', tx.data)
            if (Array.isArray(res[0])) {
              for (const r of res[0]) {
                if (r[0] === profileUrl) {
                  gkTokenId = r[1]
                  break
                }
              }
            }
          } catch (err) {
            logger.error(`decodeFunctionData-genesisKeyBatchClaimProfile: ${err}`)
          }
          const existsBool = await repositories.event.exists({
            chainId,
            contract: profileAuctionAddress,
            eventName: evt.name,
            txHash: unparsedEvent.transactionHash,
            ownerAddress: owner,
            profileUrl: profileUrl,
          })
          if (!existsBool) {
            await repositories.event.save(
              {
                chainId,
                contract: profileAuctionAddress,
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                profileUrl,
                tokenId: gkTokenId ? BigNumber.from(gkTokenId).toHexString() : null,
              },
            )
            logger.info(`MintedProfile event saved for profileUrl : ${profileUrl}`)
            // find and mark profile status as minted
            const profile = await repositories.profile.findOne({
              where: {
                tokenId: BigNumber.from(tokenId).toString(),
                url: profileUrl,
                chainId: `${chainId}`,
              },
            })
            if (!profile) {
              // profile + incentive action
              try {
                await core.createProfileFromEvent(
                  chainId,
                  owner,
                  tokenId,
                  repositories,
                  profileUrl,
                )
                await core.sendSlackMessage('sub-nftdotcom-analytics', `New profile created: ${profileUrl} by ${owner} (https://www.etherscan.io/tx/${unparsedEvent.transactionHash})`)
              } catch (err) {
                logger.error(`Profile mint error: ${err}`)
              }

              logger.info(`Profile ${ profileUrl } was minted by address ${ owner }`)
              await HederaConsensusService.submitMessage(
                `Profile ${ profileUrl } was minted by address ${ owner }`,
              )
            } else {
              if (profile.status !== defs.ProfileStatus.Owned) {
                await repositories.profile.updateOneById(profile.id, {
                  status: defs.ProfileStatus.Owned,
                })
              }
            }
          }
        }
        await cache.set(chainIdToCacheKeyProfileAuction(Number(chainId)), log.latestBlockNumber)
        logger.info(`saved all minted profiles and their events counts=${log.logs.length}`)
      } catch (err) {
        logger.error(`error parsing minted profiles: ${err}`)
      }
    }),
  )
}

const syncResolverEvents = async (
  chainId: number,
  chainProvider: ethers.providers.BaseProvider,
  nftResolverAddress: `0x${string}`,
): Promise<void> => {
  const log2 = await getResolverEvents(
    topics2,
    Number(chainId),
    chainProvider,
    nftResolverAddress,
  )

  logger.info(`nft resolver outgoing associate events chainId=${chainId} length=${log2.logs.length}`)
  await Promise.allSettled(
    log2.logs.map(async (unparsedEvent) => {
      let evt
      try {
        evt = nftResolverParseLog(unparsedEvent)
        logger.info(`Found event ${evt.name} with chainId: ${chainId}`)

        if (evt.name === EventName.AssociateEvmUser) {
          const [owner,profileUrl,destinationAddress] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: checksumAddress(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: checksumAddress(destinationAddress),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: checksumAddress(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: checksumAddress(destinationAddress),
              },
            )
            logger.info(`New NFT Resolver AssociateEvmUser event found. ${ profileUrl } (owner = ${owner}) is associating ${ destinationAddress }. chainId=${chainId}`)
          }
        } else if (evt.name == EventName.CancelledEvmAssociation) {
          const [owner,profileUrl,destinationAddress] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: checksumAddress(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: checksumAddress(destinationAddress),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: checksumAddress(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: checksumAddress(destinationAddress),
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. ${ profileUrl } (owner = ${owner}) is cancelling ${ destinationAddress }. chainId=${chainId}`)
          }
        } else if (evt.name == EventName.ClearAllAssociatedAddresses) {
          const [owner,profileUrl] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: checksumAddress(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: checksumAddress(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. ${ profileUrl } (owner = ${owner}) cancelled all associations. chainId=${chainId}`)
          }
        } else if (evt.name === EventName.AssociateSelfWithUser ||
          evt.name === EventName.RemovedAssociateProfile) {
          const [receiver, profileUrl, profileOwner] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: checksumAddress(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: profileOwner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: checksumAddress(receiver),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: checksumAddress(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: profileOwner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: checksumAddress(receiver),
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. profileUrl = ${profileUrl} (receiver = ${receiver}) profileOwner = ${[profileOwner]}. chainId=${chainId}`)
          }
        } else if (evt.name === EventName.SetAssociatedContract) {
          const [owner, profileUrl, associatedContract] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: checksumAddress(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: checksumAddress(associatedContract),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: checksumAddress(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: checksumAddress(associatedContract),
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. profileUrl = ${profileUrl} (owner = ${owner}) associatedContract = ${associatedContract}. chainId=${chainId}`)
          }
          const profile = await repositories.profile.findOne({
            where: {
              url: profileUrl,
              chainId: `${chainId}`,
            },
          })
          if (profile) {
            await repositories.profile.updateOneById(profile.id, { associatedContract })
          }
        }
        await cache.set(
          chainIdToCacheKeyResolverAssociate(Number(chainId)),
          log2.latestBlockNumber,
        )
      } catch (err) {
        if (err.code != 'BUFFER_OVERRUN' && err.code != 'INVALID_ARGUMENT') { // error parsing old event on goerli, and chainId mismatch
          logger.error(`error parsing resolver: ${err}`)
        }
      }
    }),
  )
}

const syncProfileEvents = async (
  chainId: number,
  chainProvider: ethers.providers.BaseProvider,
  profileAddress: `0x${string}`,
): Promise<void> => {
  const log3 = await getProfileEvents(
    topics3,
    Number(chainId),
    chainProvider,
    profileAddress,
  )

  logger.info(`profile extend expiry events chainId=${chainId} length=${log3.logs.length}`)
  await Promise.allSettled(
    log3.logs.map(async (unparsedEvent) => {
      try {
        const evt = profileParseLog(unparsedEvent)
        logger.info(evt.args, `Found event ${evt.name} with chainId: ${chainId}`)
        if (evt.name === EventName.ExtendExpiry) {
          const [profileUrl,extendExpiry] = evt.args
          const profile = await repositories.profile.findByURL(profileUrl, `${chainId}`)
          if (profile) {
            const timestamp = BigNumber.from(extendExpiry).toString()
            if (Number(timestamp) !== 0) {
              const expireAt = new Date(Number(timestamp) * 1000)
              await repositories.profile.updateOneById(profile.id, { expireAt })
              logger.info(`New ExtendExpiry event found. profileURL=${profileUrl} expireAt=${timestamp} chainId=${chainId}`)
            }
          }
        } else if (evt.name === EventName.Transfer) {
          const [from, to, tokenIdBN] = evt.args
          const tokenId = BigNumber.from(tokenIdBN).toString()
          if (from !== helper.AddressZero() && to !== helper.AddressZero() &&
            ethers.utils.getAddress(from) !== ethers.utils.getAddress(to)
          ) {
            const profile = await repositories.profile.findOne({
              where: {
                tokenId,
                chainId: `${chainId}`,
              },
            })
            if (profile) {
              if (profile.ownerWalletId) {
                const wallet = await repositories.wallet.findById(profile.ownerWalletId)
                if (ethers.utils.getAddress(from) !== ethers.utils.getAddress(wallet.address)) {
                  logger.info(`Something's wrong with Transfer event from=${from} url=${profile.url}`)
                }
              }
              let imageUrl = profile.photoURL
              const bannerUrl = profile.bannerURL
              const description = profile.description
              if (!imageUrl) {
                imageUrl = await core.generateCompositeImage(
                  profile.url,
                  core.DEFAULT_NFT_IMAGE,
                )
              }
              const toWallet = await repositories.wallet.findByChainAddress(
                `${chainId}`,
                ethers.utils.getAddress(to),
              )
              if (!toWallet) {
                await repositories.profile.updateOneById(profile.id, {
                  ownerUserId: null,
                  ownerWalletId: null,
                  photoURL: imageUrl,
                  bannerURL: bannerUrl ?? 'https://cdn.nft.com/profile-banner-default-logo-key.png',
                  description: description ?? `NFT.com profile for ${profile.url}`,
                })
              } else {
                await repositories.profile.updateOneById(profile.id, {
                  ownerUserId: toWallet.userId,
                  ownerWalletId: toWallet.id,
                  photoURL: imageUrl,
                  bannerURL: bannerUrl ?? 'https://cdn.nft.com/profile-banner-default-logo-key.png',
                  description: description ?? `NFT.com profile for ${profile.url}`,
                })
              }
              await nftService.executeUpdateNFTsForProfile(profile.id, chainId)
              logger.info(`New profile transfer event found. profileURL=${profile.url} from=${from} to=${to} chainId=${chainId}`)
            }
          }
        }
        await cache.set(chainIdToCacheKeyProfile(Number(chainId)), log3.latestBlockNumber)
      } catch (err) {
        logger.error(`error parsing profile event: ${err}`)
      }
    }),
  )
}

export const getEthereumEvents = async (job: Job): Promise<any> => {
  try {
    const { chainId = process.env.CHAIN_ID } = job.data

    const chainProvider = provider.provider(Number(chainId))
    const profileAuctionAddress = checksumAddress(contracts.profileAuctionAddress(chainId))
    const nftResolverAddress = checksumAddress(contracts.nftResolverAddress(chainId))
    const profileAddress = checksumAddress(contracts.nftProfileAddress(chainId))

    logger.info(`👾 getEthereumEvents chainId=${chainId}`)

    await syncMintedProfileEvents(chainId, chainProvider, profileAuctionAddress as `0x${string}`)
    await syncResolverEvents(chainId, chainProvider, nftResolverAddress as `0x${string}`)
    await syncProfileEvents(chainId, chainProvider, profileAddress as `0x${string}`)
  } catch (err) {
    logger.error(`Error in getEthereumEvents Job: ${err}`)
  }
}
