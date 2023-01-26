import { Job } from 'bull'
import { BigNumber, ethers, utils } from 'ethers'
import { defaultAbiCoder } from 'ethers/lib/utils'

import { _logger, contracts, db, defs, entity,helper } from '@nftcom/shared'

import { cache } from '../service/cache'
import { activityBuilder } from '../utils/builder/orderBuilder'
import { getCachedBlock, getPastLogs, provider } from './mint.handler'

const logger = _logger.Factory(_logger.Context.Bull)
const repositories = db.newRepositories()

const eventABI = contracts.marketplaceEventABI()
const marketplaceABI = contracts.marketplaceABIJSON()
const eventIface = new utils.Interface(eventABI)
const marketplaceIface = new utils.Interface(marketplaceABI)

export const blockNumberToTimestamp = async (
  blockNumber: number,
  chainId: string,
): Promise<number> => {
  const chainProvider = provider(Number(chainId))
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

    logger.info(`Approval logs ${logs.length}`)

    const promises = logs.map(async (log) => {
      const event = marketplaceIface.parseLog(log)
      const structHash = event.args.structHash
      const makerAddress = utils.getAddress(event.args.maker)

      logger.log(`approval struct hash: ${structHash}`)
      let txOrder = await repositories.txOrder.findOne({
        where: {
          orderHash: structHash,
          makerAddress,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Listing,
          protocol: defs.ProtocolType.NFTCOM,
        },
      })
      logger.log(`approval tx order listing: ${txOrder.id}`)
      if (txOrder) {
        const txTransaction = await repositories.txTransaction.findOne({
          where: {
            exchange: defs.ExchangeType.NFTCOM,
            transactionType: defs.ActivityType.Listing,
            protocol: defs.ProtocolType.NFTCOM,
            maker: makerAddress,
            transactionHash: log.transactionHash,
            chainId: chainId.toString(),
          },
        })
        logger.log(`approval tx listing: ${txTransaction.id, txTransaction.transactionHash}`)
        if (!txTransaction) {
          const tx = await repositories.txTransaction.save({
            activity: txOrder.activity,
            exchange: defs.ExchangeType.NFTCOM,
            transactionType: defs.ActivityType.Listing,
            protocol: defs.ProtocolType.NFTCOM,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
            nftContractAddress: '0x',
            nftContractTokenId: '',
            maker: makerAddress,
            taker: '0x',
            chainId: chainId.toString(),
          })
          logger.log(`approval tx listing saved: ${tx.id, tx.transactionHash}`)
        }
      } else {
        txOrder = await repositories.txOrder.findOne({
          where: {
            orderHash: structHash,
            makerAddress,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Bid,
            protocol: defs.ProtocolType.NFTCOM,
          },
        })
        logger.log(`approval tx order bid: ${txOrder.id}`)
        if (txOrder) {
          const txTransaction = await repositories.txTransaction.findOne({
            where: {
              exchange: defs.ExchangeType.NFTCOM,
              transactionType: defs.ActivityType.Bid,
              protocol: defs.ProtocolType.NFTCOM,
              maker: makerAddress,
              transactionHash: log.transactionHash,
              chainId: chainId.toString(),
            },
          })
          logger.log(`approval tx bid: ${txTransaction.id, txTransaction.transactionHash}`)
          if (!txTransaction) {
            await repositories.txTransaction.save({
              activity: txOrder.activity,
              exchange: defs.ExchangeType.NFTCOM,
              transactionType: defs.ActivityType.Bid,
              protocol: defs.ProtocolType.NFTCOM,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber.toString(),
              nftContractAddress: '0x',
              nftContractTokenId: '',
              maker: makerAddress,
              taker: '0x',
              chainId: chainId.toString(),
            })
            logger.log(`approval tx bid: ${txTransaction.id, txTransaction.transactionHash}`)
          }
        }
      }
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
//     logger.debug('NonceIncremented logs', logs.length)
//
//     const promises = logs.map(async (log) => {
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

    logger.info(`Cancel logs ${logs.length}`)

    const promises = logs.map(async (log) => {
      const event = marketplaceIface.parseLog(log)
      const structHash = event.args.structHash
      const makerAddress = utils.getAddress(event.args.maker)

      logger.log(`cancellation struct hash: ${structHash}`)
      let txOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          orderHash: structHash,
          makerAddress,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Listing,
          protocol: defs.ProtocolType.NFTCOM,
        },
      })
      logger.log(`cancellation listing order: ${txOrder.orderHash}`)
      if (txOrder) {
        const cancelHash = `${log.transactionHash}:${txOrder.orderHash}`
        try {
          const txCancel = await repositories.txCancel.findOne({
            where: {
              exchange: defs.ExchangeType.NFTCOM,
              foreignType: defs.CancelActivities[0],
              foreignKeyId: txOrder.orderHash,
              transactionHash: cancelHash,
              chainId: chainId.toString(),
            },
          })
          logger.log(`cancellation listing cancel: ${txCancel}`)
          if (!txCancel) {
            try {
              const timestampFromSource: number = (new Date().getTime())/1000
              const expirationFromSource = null
              const cancellationActivity: Partial<entity.TxActivity> = await activityBuilder(
                defs.ActivityType.Cancel,
                cancelHash,
                makerAddress,
                chainId.toString(),
                txOrder.activity.nftId,
                txOrder.activity.nftContract,
                timestampFromSource,
                expirationFromSource,
              )
  
              try {
                const cancel = await repositories.txCancel.save({
                  id: cancelHash,
                  activity: cancellationActivity,
                  exchange: defs.ExchangeType.NFTCOM,
                  foreignType: defs.CancelActivities[0],
                  foreignKeyId: txOrder.orderHash,
                  transactionHash: cancelHash,
                  blockNumber: log.blockNumber.toString(),
                  chainId: chainId.toString(),
                })
                logger.log(`cancellation listing cancel saved: ${cancel.id}, ${cancel.foreignKeyId}`)
              } catch (err) {
                logger.error(`cancellation error: ${err}`)
              }
            } catch (err) {
              logger.error(`cancellation activity error: ${err}`)
            }
          }
        } catch (err) {
          logger.error(`cancel find error: ${err}`)
        }
      } else {
        txOrder = await repositories.txOrder.findOne({
          relations: ['activity'],
          where: {
            orderHash: structHash,
            makerAddress,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Bid,
            protocol: defs.ProtocolType.NFTCOM,
          },
        })
        logger.log(`cancellation bid order: ${txOrder.orderHash}`)
        if (txOrder) {
          try {
            const cancelHash = `${log.transactionHash}:${txOrder.orderHash}`
            const txCancel = await repositories.txCancel.findOne({
              where: {
                exchange: defs.ExchangeType.NFTCOM,
                foreignKeyId: txOrder.orderHash,
                foreignType: defs.CancelActivities[1],
                transactionHash: cancelHash,
                chainId: chainId.toString(),
              },
            })
            logger.log(`cancellation bid cancel: ${txCancel}`)
            if (!txCancel) {
              const timestampFromSource: number = (new Date().getTime())/1000
              const expirationFromSource = null
              const cancelHash = `${log.transactionHash}:${txOrder.orderHash}`
              try {
                const cancellationActivity: Partial<entity.TxActivity> = await activityBuilder(
                  defs.ActivityType.Cancel,
                  cancelHash,
                  makerAddress,
                  chainId.toString(),
                  txOrder.activity.nftId,
                  txOrder.activity.nftContract,
                  timestampFromSource,
                  expirationFromSource,
                )
                try {
                  const cancel = await repositories.txCancel.save({
                    id: cancelHash,
                    activity: cancellationActivity,
                    exchange: defs.ExchangeType.NFTCOM,
                    foreignType: defs.CancelActivities[1],
                    foreignKeyId: txOrder.orderHash,
                    transactionHash: cancelHash,
                    blockNumber: log.blockNumber.toString(),
                    chainId: chainId.toString(),
                  })
                  logger.log(`cancellation bid cancel saved: ${cancel.id}, ${cancel.foreignKeyId}`)
                } catch (err) {
                  logger.error(`cancellation err: ${err}`)
                }
              } catch(err) {
                logger.error(`cancellation activity err: ${err}`)
              }
            }
          } catch (err) {
            logger.error(`cancel find error: ${err}`)
          }
        }
      }
    })

    await Promise.allSettled(promises)
  } catch (e) {
    logger.error(`Error in listenCancelEvents: ${e}`)
  }
  return
}

const parseAsset = async (
  assetData: string[],
  assetClass: string[],
  assetType: string[],
): Promise<defs.MarketplaceAsset[]> => {
  const asset: defs.MarketplaceAsset[] = []
  const promises = assetData.map(async (data, index) => {
    const parsedAssetData = defaultAbiCoder.decode(['uint256','uint256'], data)
    let assetClassData
    let assetTypeData
    switch (assetClass[index]) {
    case helper.ETH_ASSET_CLASS:
      assetClassData = defs.AssetClass.ETH
      assetTypeData = [helper.AddressZero()]
      break
    case helper.ERC20_ASSET_CLASS:
      assetClassData = defs.AssetClass.ERC20
      assetTypeData = defaultAbiCoder.decode(['address'], assetType[index])
      break
    case helper.ERC721_ASSET_CLASS:
      assetClassData = defs.AssetClass.ERC721
      assetTypeData = defaultAbiCoder.decode(['address', 'uint256', 'bool'], assetType[index])
      break
    case helper.ERC1155_ASSET_CLASS:
      assetClassData = defs.AssetClass.ERC1155
      assetTypeData = defaultAbiCoder.decode(['address', 'uint256', 'bool'], assetType[index])
      break
    default:
      break
    }

    // fetch ID from nft table...
    const nfts = await repositories.nft.find({
      where: {
        contract: utils.getAddress(assetTypeData[0]),
      },
    })
    const nft = nfts.find((nft) => BigNumber.from(nft.tokenId).toHexString()
      === (assetTypeData[1] as BigNumber).toHexString())

    asset.push({
      nftId: nft ? nft.id : '',
      bytes: data,
      value: (parsedAssetData[0] as BigNumber).toString(),
      minimumBid: (parsedAssetData[1] as BigNumber).toString(),
      standard: {
        assetClass: assetClassData,
        bytes: assetType[index],
        contractAddress: utils.getAddress(assetTypeData[0]),
        tokenId: assetTypeData[1] ? (assetTypeData[1] as BigNumber).toHexString() : '',
        allowAll: assetTypeData[2] ? assetTypeData[2] : true,
      },
    })
  })

  await Promise.allSettled(promises)
  return asset
}

const parseNFTIdsFromNativeAsset = (
  assets: Array<defs.MarketplaceAsset>,
): string[] => {
  const nftIds: string[] = []
  for (const asset of assets) {
    nftIds.push(`ethereum/${ethers.utils.getAddress(asset.standard.contractAddress)}/${helper.bigNumberToHex(asset.standard.tokenId)}`)
  }
  return nftIds
}

const parseContractsFromNativeAsset = (
  assets: Array<defs.MarketplaceAsset>,
): string[] => {
  const contracts: string[] = []
  const seen = {}
  for (const asset of assets) {
    const contract = ethers.utils.getAddress(asset.standard.contractAddress)
    if (!seen[contract]) {
      contracts.push(contract)
      seen[contract] = true
    }
  }
  return contracts
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

    logger.info(`Match logs ${logs.length}`)

    const promises = logs.map(async (log) => {
      try {
        const event = eventIface.parseLog(log)
        const makerHash = log.topics[1]
        const takerHash = log.topics[2]
        const privateSale = event.args.privateSale
        const auctionType = event.args.auctionType == 0 ?
          defs.AuctionType.FixedPrice :
          event.args.auctionType == 1 ?
            defs.AuctionType.English :
            defs.AuctionType.Decreasing
        const makerSig = event.args.makerSig
        const takerSig = event.args.takerSig

        let txListingOrder, txBidOrder
        txListingOrder = await repositories.txOrder.findOne({
          where: {
            orderHash: makerHash,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Listing,
            protocol: defs.ProtocolType.NFTCOM,
            chainId: chainId.toString(),
          },
        })
        txBidOrder = await repositories.txOrder.findOne({
          where: {
            orderHash: takerHash,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Bid,
            protocol: defs.ProtocolType.NFTCOM,
            chainId: chainId.toString(),
          },
        })

        if (!txListingOrder) {
          const activity = await activityBuilder(
            defs.ActivityType.Listing,
            makerHash,
            '0x',
            chainId.toString(),
            [],
            '0x',
            0,
            null,
          )
          txListingOrder = await repositories.txOrder.save({
            activity,
            orderHash: makerHash,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Listing,
            protocol: defs.ProtocolType.NFTCOM,
            makerAddress: '0x',
            takerAddress: '0x',
            nonce: -1,
            protocolData: {
              signature: {
                v: makerSig.v,
                r: makerSig.r,
                s: makerSig.s,
              },
              auctionType,
              salt: -1,
              start: 0,
              end: -1,
              makeAsset: [],
              takeAsset: [],
            },
            chainId: chainId.toString(),
            createdInternally: true,
          })
        }

        if (!txBidOrder && takerHash != '0x0000000000000000000000000000000000000000000000000000000000000000') {
          const activity = await activityBuilder(
            defs.ActivityType.Bid,
            takerHash,
            '0x',
            chainId.toString(),
            [],
            '0x',
            0,
            null,
          )
          txBidOrder = await repositories.txOrder.save({
            activity,
            orderHash: takerHash,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Bid,
            protocol: defs.ProtocolType.NFTCOM,
            makerAddress: '0x',
            takerAddress: '0x',
            nonce: -1,
            protocolData: {
              signature: {
                v: takerSig.v,
                r: takerSig.r,
                s: takerSig.s,
              },
              auctionType,
              salt: -1,
              start: 0,
              end: -1,
              makeAsset: [],
              takeAsset: [],
            },
            chainId: chainId.toString(),
            createdInternally: true,
          })

          logger.info(`created new bid order ${txBidOrder.id}`)
        }

        let txSwapTransaction = await repositories.txTransaction.findOne({
          where: {
            exchange: defs.ExchangeType.NFTCOM,
            transactionType: defs.ActivityType.Swap,
            protocol: defs.ProtocolType.NFTCOM,
            transactionHash: log.transactionHash,
            chainId: chainId.toString(),
          },
        })
        const timestamp = await blockNumberToTimestamp(log.blockNumber, chainId.toString())
        if (!txSwapTransaction) {
          const listingActivity = await repositories.txActivity.findOne({
            where: {
              activityTypeId: txListingOrder.orderHash,
            },
          })
          const activity = await activityBuilder(
            defs.ActivityType.Swap,
            log.transactionHash,
            txListingOrder.makerAddress,
            chainId.toString(),
            listingActivity.nftId,
            listingActivity.nftContract,
            0,
            null,
          )
          txSwapTransaction = await repositories.txTransaction.save({
            activity: activity,
            exchange: defs.ExchangeType.NFTCOM,
            transactionType: defs.ActivityType.Swap,
            protocol: defs.ProtocolType.NFTCOM,
            protocolData: {
              private: helper.parseBoolean(privateSale),
              listingOrderId: txListingOrder.id,
              bidOrderId: txBidOrder ? txBidOrder.id : null,
            },
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
            maker: txListingOrder.makerAddress,
            taker: txBidOrder.makerAddress,
            chainId: chainId.toString(),
          })

          await repositories.txOrder.updateOneById(txListingOrder.id, {
            protocolData: {
              ...txListingOrder.protocolData,
              signature: {
                v: makerSig.v,
                r: makerSig.r,
                s: makerSig.s,
              },
              auctionType,
              swapTransactionId: txSwapTransaction.id,
              acceptedAt: new Date(timestamp),
            },
          })

          if (txBidOrder) {
            await repositories.txOrder.updateOneById(txBidOrder.id, {
              protocolData: {
                ...txBidOrder.protocolData,
                signature: {
                  v: takerSig.v,
                  r: takerSig.r,
                  s: takerSig.s,
                },
                swapTransactionId: txSwapTransaction.id,
                auctionType,
                acceptedAt: new Date(timestamp),
              },
            })
          }
          logger.info(`created new swap transaction ${txSwapTransaction.id}`)
        }
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

    logger.info(`Match2A logs ${logs.length}`)

    await Promise.allSettled(
      logs.map(async (log) => {
        const event = eventIface.parseLog(log)
        const makerHash = log.topics[1]
        const makerAddress = utils.getAddress(event.args.makerAddress)
        const takerAddress = utils.getAddress(event.args.takerAddress)
        const start = Number(event.args.start)
        const end = Number(event.args.end)
        const nonce = Number(event.args.nonce)
        const salt = Number(event.args.salt)

        let txListingOrder = await repositories.txOrder.findOne({
          where: {
            orderHash: makerHash,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Listing,
            protocol: defs.ProtocolType.NFTCOM,
            chainId: chainId.toString(),
          },
        })
        if (!txListingOrder) {
          const activity = await activityBuilder(
            defs.ActivityType.Listing,
            makerHash,
            makerAddress,
            chainId.toString(),
            [],
            '0x',
            start,
            end,
          )
          txListingOrder = await repositories.txOrder.save({
            activity,
            orderHash: makerHash,
            exchange: defs.ExchangeType.NFTCOM,
            orderType: defs.ActivityType.Listing,
            protocol: defs.ProtocolType.NFTCOM,
            nonce,
            protocolData: {
              auctionType: defs.AuctionType.FixedPrice,
              signature: {
                v: -1,
                r: '',
                s: '',
              },
              salt,
              start,
              end,
              makeAsset: [],
              takeAsset: [],
            },
            makerAddress,
            takerAddress,
            chainId: chainId.toString(),
            createdInternally: true,
          })
          logger.info(`created new listing order from Match2A ${txListingOrder.id}`)
        } else {
          const activity = await repositories.txActivity.findOne({
            where: {
              activityTypeId: makerHash,
            },
          })
          if (activity) {
            await repositories.txActivity.updateOneById(activity.id, {
              timestamp: new Date(start * 1000),
              expiration: new Date(end * 1000),
            })
          }

          await repositories.txOrder.updateOneById(txListingOrder.id, {
            makerAddress,
            takerAddress,
            nonce,
            protocolData: {
              ...txListingOrder.protocolData,
              salt,
              start,
              end,
            },
          })

          logger.info(`updated existing listing order from Match2A ${txListingOrder.id}`)
        }

        const txTransaction = await repositories.txTransaction.findOne({
          where: {
            exchange: defs.ExchangeType.NFTCOM,
            transactionType: defs.ActivityType.Sale,
            protocol: defs.ProtocolType.NFTCOM,
            maker: makerAddress,
            transactionHash: log.transactionHash,
            chainId: chainId.toString(),
          },
        })

        if (!txTransaction) {
          txListingOrder.activity.status = defs.ActivityStatus.Executed
          await repositories.txOrder.save(txListingOrder)
          const txHashId = `${log.transactionHash}:${txListingOrder.orderHash}`
          try {
            const timestampFromSource: number = (new Date().getTime())/1000
            const expirationFromSource = null
            const txActivity: Partial<entity.TxActivity> = await activityBuilder(
              defs.ActivityType.Sale,
              txHashId,
              makerAddress,
              chainId.toString(),
              txListingOrder.activity.nftId,
              txListingOrder.activity.nftContract,
              timestampFromSource,
              expirationFromSource,
            )
            try {
              const tx = await repositories.txTransaction.save({
                id: txHashId,
                activity: txActivity,
                exchange: defs.ExchangeType.NFTCOM,
                transactionType: defs.ActivityType.Sale,
                protocol: defs.ProtocolType.NFTCOM,
                transactionHash: txHashId,
                blockNumber: log.blockNumber.toString(),
                nftContractAddress: txListingOrder.activity.nftContract,
                nftContractTokenId: '',
                maker: makerAddress,
                taker: '0x',
                chainId: chainId.toString(),
                protocolData: {
                  ...txListingOrder.protocolData,
                  salt,
                  start,
                  end,
                },
              })
    
              logger.log(`tx saved: ${tx.id} for order ${txListingOrder.id}`)
            } catch (err) {
              logger.error(`Tx err: ${err}`)
            }
          } catch (err) {
            logger.error(`Tx activity err: ${err}`)
          }
        }
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

    logger.info(`Match2B logs ${logs.length}`)

    const promises = logs.map(async (log) => {
      const event = eventIface.parseLog(log)

      const makerHash = log.topics[1]

      const sellerMakerOrderAssetData = event.args.sellerMakerOrderAssetData as string[]
      const sellerMakerOrderAssetTypeData = event.args.sellerMakerOrderAssetTypeData as string[]
      const sellerMakerOrderAssetClass = event.args.sellerMakerOrderAssetClass as string[]
      const sellerTakerOrderAssetData = event.args.sellerTakerOrderAssetData as string[]
      const sellerTakerOrderAssetTypeData = event.args.sellerTakerOrderAssetTypeData as string[]
      const sellerTakerOrderAssetClass = event.args.sellerTakerOrderAssetClass as string[]

      const makeAsset = await parseAsset(
        sellerMakerOrderAssetData,
        sellerMakerOrderAssetClass,
        sellerMakerOrderAssetTypeData,
      )
      const takeAsset = await parseAsset(
        sellerTakerOrderAssetData,
        sellerTakerOrderAssetClass,
        sellerTakerOrderAssetTypeData,
      )

      let txListingOrder = await repositories.txOrder.findOne({
        where: {
          orderHash: makerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Listing,
          protocol: defs.ProtocolType.NFTCOM,
          chainId: chainId.toString(),
        },
      })
      const nftIds = parseNFTIdsFromNativeAsset(makeAsset)
      const contracts = parseContractsFromNativeAsset(makeAsset)
      const contract = contracts.length === 1 ? contracts[0] : '0x'
      if (!txListingOrder) {
        const activity = await activityBuilder(
          defs.ActivityType.Listing,
          makerHash,
          '0x',
          chainId.toString(),
          nftIds,
          contract,
          0,
          null,
        )
        txListingOrder = await repositories.txOrder.save({
          activity,
          orderHash: makerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Listing,
          protocol: defs.ProtocolType.NFTCOM,
          nonce: -1,
          protocolData: {
            auctionType: defs.AuctionType.FixedPrice,
            signature: {
              v: -1,
              r: '',
              s: '',
            },
            salt: -1,
            start: 0,
            end: -1,
            makeAsset,
            takeAsset,
          },
          makerAddress: '0x',
          takerAddress: '0x',
          chainId: chainId.toString(),
          createdInternally: true,
        })

        logger.info(`created new listing order from Match2B ${txListingOrder.id}`)
      } else {
        const activity = await repositories.txActivity.findOne({
          where: {
            activityTypeId: txListingOrder.orderHash,
          },
        })
        if (activity) {
          await repositories.txActivity.updateOneById(activity.id, {
            nftId: [...nftIds],
            nftContract: contract === '0x' ? '0x' : helper.checkSum(contract),
          })
        }
        await repositories.txOrder.updateOneById(txListingOrder.id, {
          protocolData: {
            ...txListingOrder.protocolData,
            makeAsset,
            takeAsset,
          },
        })
        logger.info(`updated existing listing order from Match2B ${txListingOrder.id}`)
      }
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

    logger.info(`Match3A logs ${logs.length}`)

    const promises = logs.map(async (log) => {
      const event = eventIface.parseLog(log)
      const takerHash = log.topics[1]
      const makerAddress = utils.getAddress(event.args.makerAddress)
      const takerAddress = utils.getAddress(event.args.takerAddress)
      const start = Number(event.args.start)
      const end = Number(event.args.end)
      const nonce = Number(event.args.nonce)
      const salt = Number(event.args.salt)

      let txBidOrder = await repositories.txOrder.findOne({
        where: {
          orderHash: takerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Bid,
          protocol: defs.ProtocolType.NFTCOM,
          chainId: chainId.toString(),
        },
      })
      if (!txBidOrder) {
        const activity = await activityBuilder(
          defs.ActivityType.Bid,
          takerHash,
          makerAddress,
          chainId.toString(),
          [],
          '0x',
          start,
          end,
        )
        txBidOrder = await repositories.txOrder.save({
          activity,
          orderHash: takerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Bid,
          protocol: defs.ProtocolType.NFTCOM,
          nonce,
          protocolData: {
            auctionType: defs.AuctionType.FixedPrice,
            signature: {
              v: -1,
              r: '',
              s: '',
            },
            salt,
            start,
            end,
            makeAsset: [],
            takeAsset: [],
          },
          makerAddress,
          takerAddress,
          chainId: chainId.toString(),
          createdInternally: true,
        })
        logger.info(`created new bid order from Match3A ${txBidOrder.id}`)
      } else {
        const activity = await repositories.txActivity.findOne({
          where: {
            activityTypeId: takerHash,
          },
        })
        if (activity) {
          await repositories.txActivity.updateOneById(activity.id, {
            timestamp: new Date(start * 1000),
            expiration: new Date(end * 1000),
          })
        }

        await repositories.txOrder.updateOneById(txBidOrder.id, {
          makerAddress,
          takerAddress,
          nonce,
          protocolData: {
            ...txBidOrder.protocolData,
            salt,
            start,
            end,
          },
        })

        logger.info(`updated existing bid order from Match3A ${txBidOrder.id}`)
      }
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

    logger.info(`Match3B logs ${logs.length}`)

    const promises = logs.map(async (log) => {
      const event = eventIface.parseLog(log)
      const takerHash = log.topics[1]

      const buyerMakerOrderAssetData = event.args.buyerMakerOrderAssetData as string[]
      const buyerMakerOrderAssetTypeData = event.args.buyerMakerOrderAssetTypeData as string[]
      const buyerMakerOrderAssetClass = event.args.buyerMakerOrderAssetClass as string[]
      const buyerTakerOrderAssetData = event.args.buyerTakerOrderAssetData as string[]
      const buyerTakerOrderAssetTypeData = event.args.buyerTakerOrderAssetTypeData as string[]
      const buyerTakerOrderAssetClass = event.args.buyerTakerOrderAssetClass as string[]

      const makeAsset = await parseAsset(
        buyerMakerOrderAssetData,
        buyerMakerOrderAssetClass,
        buyerMakerOrderAssetTypeData,
      )
      const takeAsset = await parseAsset(
        buyerTakerOrderAssetData,
        buyerTakerOrderAssetClass,
        buyerTakerOrderAssetTypeData,
      )

      const nftIds = parseNFTIdsFromNativeAsset(takeAsset)
      const contracts = parseContractsFromNativeAsset(takeAsset)
      const contract = contracts.length === 1 ? contracts[0] : '0x'
      let txBidOrder = await repositories.txOrder.findOne({
        where: {
          orderHash: takerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Bid,
          protocol: defs.ProtocolType.NFTCOM,
          chainId: chainId.toString(),
        },
      })
      if (!txBidOrder) {
        const activity = await activityBuilder(
          defs.ActivityType.Bid,
          takerHash,
          '0x',
          chainId.toString(),
          nftIds,
          contract,
          0,
          null,
        )
        txBidOrder = await repositories.txOrder.save({
          activity,
          orderHash: takerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Bid,
          protocol: defs.ProtocolType.NFTCOM,
          nonce: -1,
          protocolData: {
            auctionType: defs.AuctionType.FixedPrice,
            signature: {
              v: -1,
              r: '',
              s: '',
            },
            salt: -1,
            start: 0,
            end: -1,
            makeAsset,
            takeAsset,
          },
          makerAddress: '0x',
          takerAddress: '0x',
          chainId: chainId.toString(),
          createdInternally: true,
        })

        logger.info(`created new bid order from Match3B ${txBidOrder.id}`)
      } else {
        const activity = await repositories.txActivity.findOne({
          where: {
            activityTypeId: txBidOrder.orderHash,
          },
        })
        if (activity) {
          await repositories.txActivity.updateOneById(activity.id, {
            nftId: [...nftIds],
            nftContract: contract === '0x' ? '0x' : helper.checkSum(contract),
          })
        }
        await repositories.txOrder.updateOneById(txBidOrder.id, {
          protocolData: {
            ...txBidOrder.protocolData,
            makeAsset,
            takeAsset,
          },
        })
        logger.info(`updated existing bid order from Match3B ${txBidOrder.id}`)
      }
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

    logger.info(`BuyNowInfo logs : ${logs.length}`)

    const promises = logs.map(async (log) => {
      const event = eventIface.parseLog(log)

      const makerHash = log.topics[1]
      const takerAddress = event.args.takerAddress

      const txOrder = await repositories.txOrder.findOne({
        where: {
          orderHash: makerHash,
          exchange: defs.ExchangeType.NFTCOM,
          orderType: defs.ActivityType.Listing,
          protocol: defs.ProtocolType.NFTCOM,
        },
      })
      if (txOrder) {
        await repositories.txOrder.updateOneById(txOrder.id, {
          protocolData: {
            ...txOrder.protocolData,
            buyNowTaker: utils.getAddress(takerAddress),
          },
        })

        logger.info(`updated existing listing order from BuyNowInfo: ${txOrder.id}`)
      }
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
    const chainProvider = provider(chainId)
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
