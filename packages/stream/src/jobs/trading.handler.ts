import { Job } from 'bullmq'
import { ethers, utils } from 'ethers'

import { _logger, contracts, defs, helper, provider } from '@nftcom/shared'

import { cache } from '../service/cache'
import {
  approvalEventHandler,
  buyNowInfoEventHandler,
  cancelEventHandler,
  matchEventHandler,
  matchThreeAEventHandler,
  matchThreeBEventHandler,
  matchTwoAEventHandler,
  matchTwoBEventHandler,
} from '../service/trading'
import { getCachedBlock, getPastLogs } from './mint.handler'

const logger = _logger.Factory(_logger.Context.Bull)
const eventABI = contracts.marketplaceEventABI()
const marketplaceABI = contracts.marketplaceABIJSON()
const eventIface = new utils.Interface(eventABI)
const marketplaceIface = new utils.Interface(marketplaceABI)

export const blockNumberToTimestamp = async (
  blockNumber: number,
  chainId: string,
): Promise<number> => {
  const chainProvider = provider.provider(Number(chainId))
  const block = await chainProvider.getBlock(blockNumber)
  return block.timestamp * 1000
}

/**
 * listen to Approval events
 * TODO: need to confirm again once at least one approval event happens
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenApprovalEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void> => {
  const address = contracts.nftMarketplaceAddress(chainId)
  const topics = [
    helper.id('Approval(bytes32,address,uint256)'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Approval logs ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      const event = marketplaceIface.parseLog(log)
      const structHash = event.args.structHash
      const makerAddress = utils.getAddress(event.args.maker)

      logger.log(`approval struct hash: ${structHash}`)
      await approvalEventHandler(
        makerAddress,
        structHash,
        log.transactionHash,
        log.blockNumber.toString(),
        chainId.toString(),
      )
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenApprovalEvents: ${e}`)
  }
  return
}

/**
 * listen to NonceIncremented events
 * TODO: need to confirm again once at least one nonceIncremented event happens
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
// const listenNonceIncrementedEvents = async (
//   chainId: number,
//   provider: ethers.providers.BaseProvider,
//   cachedBlock: number,
//   latestBlock: number,
// ): Promise<void[]> => {
//   const address = contracts.nftMarketplaceAddress(chainId)
//   const topics = [
//     utils.id('NonceIncremented(address,uint)'),
//   ]
//   try {
//     const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)
//
//     logger.debug('NonceIncremented logs', logs.logs.length)
//
//     const promises = logs.logs.map(async (log) => {
//       const event = marketplaceIface.parseLog(log)
//       const makerAddress = event.args.maker
//       const nonce = Number(event.args.newNonce)
//       const marketAsks = await repositories.marketAsk.find({
//         where: {
//           makerAddress: utils.getAddress(makerAddress),
//           nonce: LessThan(nonce),
//           marketSwapId: IsNull(),
//           approvalTxHash: IsNull(),
//           cancelTxHash: IsNull(),
//         },
//       })
//       const filteredAsks = marketAsks.filter((ask) => ask.nonce < nonce)
//       if (filteredAsks.length) {
//         await Promise.all(filteredAsks.map(async (marketAsk) => {
//           await repositories.marketAsk.updateOneById(marketAsk.id, {
//             cancelTxHash: log.transactionHash,
//           })
//         }))
//       } else {
//         const marketBids = await repositories.marketBid.find({
//           where: {
//             makerAddress: utils.getAddress(makerAddress),
//             nonce: LessThan(nonce),
//             marketSwapId: IsNull(),
//             approvalTxHash: IsNull(),
//             cancelTxHash: IsNull(),
//           },
//         })
//         const filteredBids = marketBids.filter((bid) => bid.nonce < nonce)
//         await Promise.all(filteredBids.map(async (marketBid) => {
//           await repositories.marketBid.updateOneById(marketBid.id, {
//             cancelTxHash: log.transactionHash,
//           })
//         }))
//       }
//     })
//
//     await Promise.allSettled(promises)
//   } catch (e) {
//     logger.error(`Error in nonceIncrementedEvents: ${e}`)
//   }
//   return
// }

/**
 * listen to Cancel events
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenCancelEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void> => {
  const address = contracts.nftMarketplaceAddress(chainId)
  const topics = [
    utils.id('Cancel(bytes32,address)'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Cancel logs ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      const event = marketplaceIface.parseLog(log)
      const structHash = event.args.structHash
      const makerAddress = utils.getAddress(event.args.maker)

      logger.log(`cancellation struct hash: ${structHash}`)
      await cancelEventHandler(
        structHash,
        makerAddress,
        log.transactionHash,
        log.blockNumber.toString(),
        chainId.toString(),
      )
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenCancelEvents: ${e}`)
  }
  return
}

/**
 * listen to Match events
 * TODO: need to confirm again once at least one match event happens
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenMatchEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void> => {
  const address = contracts.marketplaceEventAddress(chainId)
  const topics = [
    utils.id('Match(bytes32,bytes32,uint8,(uint8,bytes32,bytes32),(uint8,bytes32,bytes32),bool)'),
  ]

  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Match logs ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      try {
        const event = eventIface.parseLog(log)
        const sellHash = log.topics[1]
        const buyHash = log.topics[2]
        const privateSale = event.args.privateSale
        const auctionType = event.args.auctionType == 0 ?
          defs.AuctionType.FixedPrice :
          event.args.auctionType == 1 ?
            defs.AuctionType.English :
            defs.AuctionType.Decreasing
        const makerSig = event.args.makerSig
        const takerSig = event.args.takerSig

        await matchEventHandler(
          sellHash,
          buyHash,
          makerSig,
          takerSig,
          auctionType,
          log.transactionHash,
          log.blockNumber.toString(),
          privateSale,
          chainId.toString(),
        )
      } catch (e) {
        logger.error('Error while parsing match event: ', e)
      }
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenMatchEvents: ${e}`)
  }
  return
}

/**
 * listen to Match2A events
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenMatchTwoAEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void[]> => {
  const address = contracts.marketplaceEventAddress(chainId)
  const topics = [
    utils.id('Match2A(bytes32,address,address,uint256,uint256,uint256,uint256)'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Match2A logs ${logs.logs.length}`)

    await Promise.allSettled(
      logs.logs.map(async (log) => {
        const event = eventIface.parseLog(log)
        const makerHash = log.topics[1]
        const makerAddress = utils.getAddress(event.args.makerAddress)
        const takerAddress = utils.getAddress(event.args.takerAddress)
        const start = Number(event.args.start)
        const end = Number(event.args.end)
        const nonce = Number(event.args.nonce)
        const salt = Number(event.args.salt)

        await matchTwoAEventHandler(
          makerHash,
          makerAddress,
          takerAddress,
          start,
          end,
          nonce,
          salt,
          log.transactionHash,
          log.blockNumber.toString(),
          chainId.toString(),
        )
      }),
    )
  } catch (e) {
    logger.error(`Error in listenMatchTwoAEvents: ${e}`)
  }
  return
}

/**
 * listen to Match2B events
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenMatchTwoBEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void[]> => {
  const address = contracts.marketplaceEventAddress(chainId)
  const topics = [
    utils.id('Match2B(bytes32,bytes[],bytes[],bytes4[],bytes[],bytes[],bytes4[])'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Match2B logs ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      const event = eventIface.parseLog(log)

      const makerHash = log.topics[1]

      const sellerMakerOrderAssetData = event.args.sellerMakerOrderAssetData as string[]
      const sellerMakerOrderAssetTypeData = event.args.sellerMakerOrderAssetTypeData as string[]
      const sellerMakerOrderAssetClass = event.args.sellerMakerOrderAssetClass as string[]
      const sellerTakerOrderAssetData = event.args.sellerTakerOrderAssetData as string[]
      const sellerTakerOrderAssetTypeData = event.args.sellerTakerOrderAssetTypeData as string[]
      const sellerTakerOrderAssetClass = event.args.sellerTakerOrderAssetClass as string[]

      await matchTwoBEventHandler(
        sellerMakerOrderAssetData,
        sellerMakerOrderAssetClass,
        sellerMakerOrderAssetTypeData,
        sellerTakerOrderAssetData,
        sellerTakerOrderAssetClass,
        sellerTakerOrderAssetTypeData,
        makerHash,
        log.transactionHash,
        log.blockNumber.toString(),
        chainId.toString(),
      )
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenMatchTwoBEvents: ${e}`)
  }
  return
}

/**
 * listen to Match3A events
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenMatchThreeAEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void[]> => {
  const address = contracts.marketplaceEventAddress(chainId)
  const topics = [
    utils.id('Match3A(bytes32,address,address,uint256,uint256,uint256,uint256)'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Match3A logs ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      const event = eventIface.parseLog(log)
      const takerHash = log.topics[1]
      const makerAddress = utils.getAddress(event.args.makerAddress)
      const takerAddress = utils.getAddress(event.args.takerAddress)
      const start = Number(event.args.start)
      const end = Number(event.args.end)
      const nonce = Number(event.args.nonce)
      const salt = Number(event.args.salt)

      await matchThreeAEventHandler(
        takerHash,
        makerAddress,
        takerAddress,
        start,
        end,
        nonce,
        salt,
        chainId.toString(),
      )
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenMatchThreeAEvents: ${e}`)
  }
  return
}

/**
 * listen to Match3B events
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenMatchThreeBEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void[]> => {
  const address = contracts.marketplaceEventAddress(chainId)
  const topics = [
    utils.id('Match3B(bytes32,bytes[],bytes[],bytes4[],bytes[],bytes[],bytes4[])'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`Match3B logs ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      const event = eventIface.parseLog(log)
      const takerHash = log.topics[1]

      const buyerMakerOrderAssetData = event.args.buyerMakerOrderAssetData as string[]
      const buyerMakerOrderAssetTypeData = event.args.buyerMakerOrderAssetTypeData as string[]
      const buyerMakerOrderAssetClass = event.args.buyerMakerOrderAssetClass as string[]
      const buyerTakerOrderAssetData = event.args.buyerTakerOrderAssetData as string[]
      const buyerTakerOrderAssetTypeData = event.args.buyerTakerOrderAssetTypeData as string[]
      const buyerTakerOrderAssetClass = event.args.buyerTakerOrderAssetClass as string[]

      await matchThreeBEventHandler(
        buyerMakerOrderAssetData,
        buyerMakerOrderAssetClass,
        buyerMakerOrderAssetTypeData,
        buyerTakerOrderAssetData,
        buyerTakerOrderAssetClass,
        buyerTakerOrderAssetTypeData,
        takerHash,
        chainId.toString(),
      )
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenMatchThreeBEvents: ${e}`)
  }
  return
}

/**
 * listen to BuyNowInfo events
 * @param chainId
 * @param provider
 * @param cachedBlock
 * @param latestBlock
 */
const listenBuyNowInfoEvents = async (
  chainId: number,
  provider: ethers.providers.BaseProvider,
  cachedBlock: number,
  latestBlock: number,
): Promise<void[]> => {
  const address = contracts.marketplaceEventAddress(chainId)
  const topics = [
    utils.id('BuyNowInfo(bytes32,address)'),
  ]
  try {
    const logs = await getPastLogs(provider, address, topics, cachedBlock, latestBlock)

    logger.info(`BuyNowInfo logs : ${logs.logs.length}`)

    const promises = logs.logs.map(async (log) => {
      const event = eventIface.parseLog(log)

      const makerHash = log.topics[1]
      const takerAddress = utils.getAddress(event.args.takerAddress)

      await buyNowInfoEventHandler(makerHash, takerAddress)
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenBuyNowInfoEvents: ${e}`)
  }
  return
}

export const syncTrading = async (job: Job): Promise<any> => {
  try {
    logger.info('marketplace sync job')

    const chainId = Number(job.data.chainId)
    const chainProvider = provider.provider(chainId)
    const latestBlock = await chainProvider.getBlock('latest')
    const cachedBlock = await getCachedBlock(chainId, `marketplace_cached_block_${chainId}`)
    logger.info(`Marketplace_Cached_Block: ${cachedBlock} - LatestBlock: ${latestBlock.number}`)

    await listenApprovalEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    // await listenNonceIncrementedEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenCancelEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenMatchTwoAEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenMatchTwoBEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenMatchThreeAEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenMatchThreeBEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenMatchEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    await listenBuyNowInfoEvents(chainId, chainProvider, cachedBlock, latestBlock.number)
    // update cached block number to the latest block number
    await cache.set(`marketplace_cached_block_${chainId}`, latestBlock.number)
  } catch (err) {
    logger.error(`Error in syncTrading: ${err}`)
  }
}
