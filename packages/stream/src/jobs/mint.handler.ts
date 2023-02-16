import { Job } from 'bull'
import { BigNumber, ethers, providers, utils } from 'ethers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {  core, HederaConsensusService, nftService } from '@nftcom/gql/service'
import { _logger, contracts, db, defs, helper } from '@nftcom/shared'

import { cache } from '../service/cache'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const MAX_BLOCKS = 100000 // we use this constant to split blocks to avoid any issues to get logs for event...

export const provider = (
  chainId: providers.Networkish = 1, //mainnet default
): ethers.providers.BaseProvider => {
  return new ethers.providers.AlchemyProvider(chainId, process.env.ALCHEMY_API_KEY)
}

/**
 * recursive method to split blocks for getting event logs
 * @param provider
 * @param fromBlock
 * @param toBlock
 * @param address
 * @param topics
 * @param maxBlocks
 * @param currentStackLv
 */
const splitGetLogs = async (
  provider: ethers.providers.BaseProvider,
  fromBlock: number,
  toBlock: number,
  address: string,
  topics: any[],
  maxBlocks: number,
  currentStackLv: number,
): Promise<ethers.providers.Log[]> => {
  // split block range in half...
  const midBlock =  (fromBlock.valueOf() + toBlock.valueOf()) >> 1
  // eslint-disable-next-line no-use-before-define
  const first = await getPastLogs(provider, address, topics,
    fromBlock, midBlock, maxBlocks, currentStackLv + 1)
  // eslint-disable-next-line no-use-before-define
  const last = await getPastLogs(provider, address, topics,
    midBlock + 1, toBlock, maxBlocks,currentStackLv + 1)
  return [...first, ...last]
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
): Promise<ethers.providers.Log[]> => {
  // if there are too many recursive calls, we just return empty array...
  if (currentStackLv > 400) {
    return []
  }
  if (fromBlock > toBlock) {
    return []
  }

  const max_Blocks = maxBlocks ? maxBlocks : MAX_BLOCKS
  try {
    // if there are too many blocks, we will split it up...
    if ((toBlock - fromBlock) > max_Blocks) {
      logger.info(`recursive getting logs from ${fromBlock} to ${toBlock}`)
      // eslint-disable-next-line no-use-before-define
      return await splitGetLogs(
        provider,
        fromBlock,
        toBlock,
        address,
        topics,
        max_Blocks,
        currentStackLv,
      )
    } else {
      // we just get logs using provider...
      logger.info(`getting logs from ${fromBlock} to ${toBlock}`)
      const filter = {
        address: utils.getAddress(address),
        fromBlock: fromBlock,
        toBlock: toBlock,
        topics: topics,
      }
      return await provider.getLogs(filter)
    }
  } catch (e) {
    logger.error('error while getting past logs: ', e)
    return []
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
      logs: logs,
      latestBlockNumber: latestBlock.number,
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
    const logs = await getPastLogs(
      provider,
      address,
      topics,
      cachedBlock,
      latestBlock.number,
      Number(maxBlocks),
    )
    return {
      logs: logs,
      latestBlockNumber: latestBlock.number,
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
      logs: logs,
      latestBlockNumber: latestBlock.number,
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

export const getEthereumEvents = async (job: Job): Promise<any> => {
  try {
    const { chainId } = job.data

    const topics = [
      helper.id('MintedProfile(address,string,uint256,uint256,uint256)'),
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

    const chainProvider = provider(Number(chainId))
    const address = helper.checkSum(contracts.profileAuctionAddress(chainId))
    const nftResolverAddress = helper.checkSum(contracts.nftResolverAddress(chainId))
    const profileAddress = helper.checkSum(contracts.nftProfileAddress(chainId))

    logger.info(`👾 getting Ethereum Events chainId=${chainId}`)

    const log = await getMintedProfileEvents(topics, Number(chainId), chainProvider, address)
    const log2 = await getResolverEvents(
      topics2,
      Number(chainId),
      chainProvider,
      nftResolverAddress,
    )
    const log3 = await getProfileEvents(
      topics3,
      Number(chainId),
      chainProvider,
      profileAddress,
    )

    logger.info(`profile extend expiry events chainId=${chainId} length=${log3.logs.length}`)
    log3.logs.map(async (unparsedEvent) => {
      try {
        const evt = profileParseLog(unparsedEvent)
        logger.info(evt.args, `Found event ${evt.name} with chainId: ${chainId}`)
        if (evt.name === EventName.ExtendExpiry) {
          const [profileUrl,extendExpiry] = evt.args
          const profile = await repositories.profile.findByURL(profileUrl, chainId)
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
                chainId,
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
                chainId,
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
        await cache.set(chainIdToCacheKeyProfile(chainId), log3.latestBlockNumber)
      } catch (err) {
        logger.error(err, 'error parsing profile event')
      }
    })
    logger.info(`nft resolver outgoing associate events chainId=${chainId} length=${log2.logs.length}`)
    log2.logs.map(async (unparsedEvent) => {
      let evt
      try {
        evt = nftResolverParseLog(unparsedEvent)
        logger.info(evt.args, `Found event ${evt.name} with chainId: ${chainId}`)

        if (evt.name === EventName.AssociateEvmUser) {
          const [owner,profileUrl,destinationAddress] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(destinationAddress),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(destinationAddress),
              },
            )
            logger.info(`New NFT Resolver AssociateEvmUser event found. ${ profileUrl } (owner = ${owner}) is associating ${ destinationAddress }. chainId=${chainId}`)
          }
        } else if (evt.name == EventName.CancelledEvmAssociation) {
          const [owner,profileUrl,destinationAddress] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(destinationAddress),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(destinationAddress),
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. ${ profileUrl } (owner = ${owner}) is cancelling ${ destinationAddress }. chainId=${chainId}`)
          }
        } else if (evt.name == EventName.ClearAllAssociatedAddresses) {
          const [owner,profileUrl] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
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
                contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
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
              contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: profileOwner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(receiver),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: profileOwner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(receiver),
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. profileUrl = ${profileUrl} (receiver = ${receiver}) profileOwner = ${[profileOwner]}. chainId=${chainId}`)
          }
        } else if (evt.name === EventName.SetAssociatedContract) {
          const [owner, profileUrl, associatedContract] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId,
              contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
              eventName: evt.name,
              txHash: unparsedEvent.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(unparsedEvent.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(associatedContract),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId,
                contract: helper.checkSum(contracts.nftResolverAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(unparsedEvent.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(associatedContract),
              },
            )
            logger.info(`New NFT Resolver ${evt.name} event found. profileUrl = ${profileUrl} (owner = ${owner}) associatedContract = ${associatedContract}. chainId=${chainId}`)
          }
          const profile = await repositories.profile.findOne({
            where: {
              url: profileUrl,
              chainId,
            },
          })
          if (profile) {
            await repositories.profile.updateOneById(profile.id, { associatedContract })
          }
        }
        await cache.set(chainIdToCacheKeyResolverAssociate(chainId), log2.latestBlockNumber)
      } catch (err) {
        if (err.code != 'BUFFER_OVERRUN' && err.code != 'INVALID_ARGUMENT') { // error parsing old event on goerli, and chainId mismatch
          logger.error(err, 'error parsing resolver')
        }
      }
    })

    logger.info(`minted profile events chainId=${chainId} length=${log.logs.length}`)
    log.logs.map(async (unparsedEvent) => {
      try {
        const evt = profileAuctionParseLog(unparsedEvent)
        logger.info(`Found event MintedProfile with chainId: ${chainId}`)
        const [owner,profileUrl,tokenId,,] = evt.args

        if (evt.name === 'MintedProfile') {
          const tx = await chainProvider.getTransaction(unparsedEvent.transactionHash)
          const claimFace = new ethers.utils.Interface(['function genesisKeyClaimProfile(string,uint256,address,bytes32,bytes)'])
          const batchClaimFace = new ethers.utils.Interface(['function genesisKeyBatchClaimProfile((string,uint256,address,bytes32,bytes)[])'])
          let gkTokenId
          try {
            const res = claimFace.decodeFunctionData('genesisKeyClaimProfile', tx.data)
            gkTokenId = res[1]
          } catch (err) {
            const res = batchClaimFace.decodeFunctionData('genesisKeyBatchClaimProfile', tx.data)
            if (Array.isArray(res[0])) {
              for (const r of res[0]) {
                if (r[0] === profileUrl) {
                  gkTokenId = r[1]
                  break
                }
              }
            }
          }
          const existsBool = await repositories.event.exists({
            chainId,
            contract: helper.checkSum(contracts.profileAuctionAddress(chainId)),
            eventName: evt.name,
            txHash: unparsedEvent.transactionHash,
            ownerAddress: owner,
            profileUrl: profileUrl,
          })
          if (!existsBool) {
            await repositories.event.save(
              {
                chainId,
                contract: helper.checkSum(contracts.profileAuctionAddress(chainId)),
                eventName: evt.name,
                txHash: unparsedEvent.transactionHash,
                ownerAddress: owner,
                profileUrl: profileUrl,
                tokenId: gkTokenId ? BigNumber.from(gkTokenId).toHexString() : null,
              },
            )
            // find and mark profile status as minted
            const profile = await repositories.profile.findOne({
              where: {
                tokenId: tokenId.toString(),
                url: profileUrl,
                chainId,
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
                  true,
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
        await cache.set(chainIdToCacheKeyProfileAuction(chainId), log.latestBlockNumber)
        logger.info(`saved all minted profiles and their events counts=${log.logs.length}`)
      } catch (err) {
        logger.error(err, 'error parsing minted profiles: ')
      }
    })
  } catch (err) {
    logger.error(`Error in getEthereumEvents Job: ${err}`)
  }
}
