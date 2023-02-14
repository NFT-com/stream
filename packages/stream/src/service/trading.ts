import { BigNumber, ethers, utils } from 'ethers'
import { defaultAbiCoder } from 'ethers/lib/utils'

import { _logger, db, defs, entity, helper } from '@nftcom/shared'

import { provider } from '../jobs/mint.handler'
import { blockNumberToTimestamp } from '../jobs/trading.handler'
import { activityBuilder } from '../utils/builder/orderBuilder'

const logger = _logger.Factory('NFTCOM')
const repositories = db.newRepositories()
const abiTransfer = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]
const eventIface = new utils.Interface(abiTransfer)
export const TOKEN_TRANSFER_TOPIC = ethers.utils.id(
  'Transfer(address,address,uint256)',
)

export const approvalEventHandler = async (
  makerAddress: string,
  structHash: string,
  transactionHash: string,
  blockNumber: string,
  chainId: string,
): Promise<void> => {
  try {
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
          transactionHash,
          chainId,
        },
      })
      logger.log(`approval tx listing: ${txTransaction.id, txTransaction.transactionHash}`)
      if (!txTransaction) {
        const tx = await repositories.txTransaction.save({
          activity: txOrder.activity,
          exchange: defs.ExchangeType.NFTCOM,
          transactionType: defs.ActivityType.Listing,
          protocol: defs.ProtocolType.NFTCOM,
          transactionHash,
          blockNumber,
          nftContractAddress: '0x',
          nftContractTokenId: '',
          maker: makerAddress,
          taker: '0x',
          chainId,
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
            transactionHash,
            chainId,
          },
        })
        logger.log(`approval tx bid: ${txTransaction.id, txTransaction.transactionHash}`)
        if (!txTransaction) {
          await repositories.txTransaction.save({
            activity: txOrder.activity,
            exchange: defs.ExchangeType.NFTCOM,
            transactionType: defs.ActivityType.Bid,
            protocol: defs.ProtocolType.NFTCOM,
            transactionHash,
            blockNumber,
            nftContractAddress: '0x',
            nftContractTokenId: '',
            maker: makerAddress,
            taker: '0x',
            chainId,
          })
          logger.log(`approval tx bid: ${txTransaction.id, txTransaction.transactionHash}`)
        }
      }
    }
  } catch (err) {
    logger.error(`err in approvalEventHandler: ${err}`)
    throw err
  }
}

export const cancelEventHandler = async (
  structHash: string,
  makerAddress: string,
  transactionHash: string,
  blockNumber: string,
  chainId: string,
): Promise<void> => {
  try {
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
      const cancelHash = `${transactionHash}:${txOrder.orderHash}`
      try {
        const txCancel = await repositories.txCancel.findOne({
          where: {
            exchange: defs.ExchangeType.NFTCOM,
            foreignType: defs.CancelActivities[0],
            foreignKeyId: txOrder.orderHash,
            transactionHash: cancelHash,
            chainId,
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
                blockNumber,
                chainId,
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
          const cancelHash = `${transactionHash}:${txOrder.orderHash}`
          const txCancel = await repositories.txCancel.findOne({
            where: {
              exchange: defs.ExchangeType.NFTCOM,
              foreignKeyId: txOrder.orderHash,
              foreignType: defs.CancelActivities[1],
              transactionHash: cancelHash,
              chainId,
            },
          })
          logger.log(`cancellation bid cancel: ${txCancel}`)
          if (!txCancel) {
            const timestampFromSource: number = (new Date().getTime())/1000
            const expirationFromSource = null
            const cancelHash = `${transactionHash}:${txOrder.orderHash}`
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
                  blockNumber,
                  chainId,
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
  } catch (err) {
    logger.error(`err in cancelEventHandler: ${err}`)
    throw err
  }
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

export const matchEventHandler = async (
  sellHash: string,
  buyHash: string,
  makerSig: any,
  takerSig: any,
  auctionType: defs.AuctionType,
  transactionHash: string,
  blockNumber: string,
  privateSale: string,
  chainId: string,
): Promise<void> => {
  try {
    let txListingOrder, txBidOrder
    txListingOrder = await repositories.txOrder.findOne({
      where: {
        orderHash: sellHash,
        exchange: defs.ExchangeType.NFTCOM,
        orderType: defs.ActivityType.Listing,
        protocol: defs.ProtocolType.NFTCOM,
        chainId,
      },
    })
    txBidOrder = await repositories.txOrder.findOne({
      where: {
        orderHash: buyHash,
        exchange: defs.ExchangeType.NFTCOM,
        orderType: defs.ActivityType.Bid,
        protocol: defs.ProtocolType.NFTCOM,
        chainId,
      },
    })

    if (!txListingOrder) {
      const activity = await activityBuilder(
        defs.ActivityType.Listing,
        sellHash,
        '0x',
        chainId,
        [],
        '0x',
        0,
        null,
      )
      txListingOrder = await repositories.txOrder.save({
        activity,
        orderHash: sellHash,
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

    if (!txBidOrder && buyHash != '0x0000000000000000000000000000000000000000000000000000000000000000') {
      const activity = await activityBuilder(
        defs.ActivityType.Bid,
        buyHash,
        '0x',
        chainId,
        [],
        '0x',
        0,
        null,
      )
      txBidOrder = await repositories.txOrder.save({
        activity,
        orderHash: buyHash,
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
        chainId,
        createdInternally: true,
      })

      logger.info(`created new bid order ${txBidOrder.id}`)
    }

    let txSwapTransaction = await repositories.txTransaction.findOne({
      where: {
        exchange: defs.ExchangeType.NFTCOM,
        transactionType: defs.ActivityType.Swap,
        protocol: defs.ProtocolType.NFTCOM,
        transactionHash,
        chainId,
      },
    })
    const timestamp = await blockNumberToTimestamp(Number(blockNumber), chainId)
    if (!txSwapTransaction) {
      const listingActivity = await repositories.txActivity.findOne({
        where: {
          activityTypeId: txListingOrder.orderHash,
        },
      })
      const activity = await activityBuilder(
        defs.ActivityType.Swap,
        transactionHash,
        '0x',
        chainId,
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
        transactionHash,
        blockNumber,
        maker: txListingOrder.makerAddress,
        taker: txBidOrder.makerAddress,
        chainId,
      })

      await repositories.txActivity.updateOneById(listingActivity.id, {
        status: defs.ActivityStatus.Executed,
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
        const bidActivity = await repositories.txActivity.findOne({
          where: {
            activityTypeId: txBidOrder.orderHash,
          },
        })
        await repositories.txActivity.updateOneById(bidActivity.id, {
          status: defs.ActivityStatus.Executed,
        })
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
  } catch (err) {
    logger.error(`err in matchEventHandler: ${err}`)
    throw err
  }
}

export const matchTwoAEventHandler = async (
  makerHash: string,
  makerAddress: string,
  takerAddress: string,
  start: number,
  end: number,
  nonce: number,
  salt: number,
  transactionHash: string,
  blockNumber: string,
  chainId: string,
): Promise<void> => {
  try {
    let txListingOrder = await repositories.txOrder.findOne({
      where: {
        orderHash: makerHash,
        exchange: defs.ExchangeType.NFTCOM,
        orderType: defs.ActivityType.Listing,
        protocol: defs.ProtocolType.NFTCOM,
        chainId,
      },
    })
    if (!txListingOrder) {
      const activity = await activityBuilder(
        defs.ActivityType.Listing,
        makerHash,
        makerAddress,
        chainId,
        [],
        '0x',
        start,
        end,
      )
      txListingOrder = await repositories.txOrder.save({
        activity: {
          ...activity,
          status: defs.ActivityStatus.Executed,
        },
        orderHash: makerHash,
        exchange: defs.ExchangeType.NFTCOM,
        orderType: defs.ActivityType.Listing,
        protocol: defs.ProtocolType.NFTCOM,
        nonce,
        protocolData: {
          auctionType: defs.AuctionType.FixedPrice,
          signature: {
            v: 0,
            r: '0x0000000000000000000000000000000000000000000000000000000000000000',
            s: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
          salt,
          start,
          end,
          makeAsset: [],
          takeAsset: [],
        },
        makerAddress,
        takerAddress,
        chainId,
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
        activity: {
          ...activity,
          status: defs.ActivityStatus.Executed,
        },
        protocolData: {
          ...txListingOrder.protocolData,
          salt,
          start,
          end,
        },
      })

      logger.info(`updated existing listing order from Match2A ${txListingOrder.id}`)
    }

    const txHashId = `${transactionHash}:${txListingOrder.orderHash}`
    try {
      let txTransaction = await repositories.txTransaction.findOne({
        where: {
          exchange: defs.ExchangeType.NFTCOM,
          transactionType: defs.ActivityType.Sale,
          protocol: defs.ProtocolType.NFTCOM,
          maker: makerAddress,
          transactionHash: txHashId,
          chainId,
        },
      })

      logger.info(`tx exists: ${txTransaction}`)

      if (!txTransaction) {
        try {
          const timestampFromSource: number = (new Date().getTime())/1000
          const expirationFromSource = null
          const txActivity: Partial<entity.TxActivity> = await activityBuilder(
            defs.ActivityType.Sale,
            txHashId,
            makerAddress,
            chainId,
            txListingOrder?.activity?.nftId || [],
            txListingOrder?.activity?.nftContract || '0x',
            timestampFromSource,
            expirationFromSource,
          )
          try {
            txTransaction = await repositories.txTransaction.save({
              id: txHashId,
              activity: txActivity,
              exchange: defs.ExchangeType.NFTCOM,
              transactionType: defs.ActivityType.Sale,
              protocol: defs.ProtocolType.NFTCOM,
              transactionHash: txHashId,
              blockNumber,
              nftContractAddress: txListingOrder?.activity?.nftContract || '0x',
              nftContractTokenId: '',
              maker: makerAddress,
              taker: takerAddress,
              chainId,
              protocolData: {
                ...txListingOrder.protocolData,
                salt,
                start,
                end,
              },
            })

            logger.log(`tx saved: ${txTransaction.id} for order ${txListingOrder.id}`)
          } catch (err) {
            logger.error(`Tx err: ${err}`)
          }
        } catch (err) {
          logger.error(`Tx activity err: ${err}`)
        }
      } else {
        const activity = await repositories.txActivity.findOne({
          where: {
            activityTypeId: txHashId,
          },
        })
        if (activity) {
          await repositories.txActivity.updateOneById(activity.id, {
            walletAddress: makerAddress,
          })
        }
        await repositories.txTransaction.updateOneById(txTransaction.id, {
          maker: makerAddress,
          taker: takerAddress,
          protocolData: {
            ...txTransaction.protocolData,
            salt,
            start,
            end,
          },
        })
      }
    } catch (err) {
      logger.error(`tx find error: ${err}`)
    }
  } catch (err) {
    logger.error(`err in matchTwoAEventHandler: ${err}`)
    throw err
  }
}

export const matchTwoBEventHandler = async (
  sellerMakerOrderAssetData: string[],
  sellerMakerOrderAssetClass: string[],
  sellerMakerOrderAssetTypeData: string[],
  sellerTakerOrderAssetData: string[],
  sellerTakerOrderAssetClass: string[],
  sellerTakerOrderAssetTypeData: string[],
  makerHash: string,
  transactionHash: string,
  blockNumber: string,
  chainId: string,
): Promise<void> => {
  try {
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
        chainId,
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
        chainId,
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
            v: 0,
            r: '0x0000000000000000000000000000000000000000000000000000000000000000',
            s: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
          salt: -1,
          start: 0,
          end: -1,
          makeAsset,
          takeAsset,
        },
        makerAddress: '0x',
        takerAddress: '0x',
        chainId,
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

    const txHashId = `${transactionHash}:${txListingOrder.orderHash}`
    try {
      let txTransaction = await repositories.txTransaction.findOne({
        where: {
          exchange: defs.ExchangeType.NFTCOM,
          transactionType: defs.ActivityType.Sale,
          protocol: defs.ProtocolType.NFTCOM,
          maker: txListingOrder.makerAddress,
          transactionHash: txHashId,
          chainId,
        },
      })

      logger.info(`tx exists: ${txTransaction}`)

      if (!txTransaction) {
        try {
          const timestampFromSource: number = (new Date().getTime())/1000
          const expirationFromSource = null
          const txActivity: Partial<entity.TxActivity> = await activityBuilder(
            defs.ActivityType.Sale,
            txHashId,
            txListingOrder.makerAddress,
            chainId,
            nftIds,
            contract,
            timestampFromSource,
            expirationFromSource,
          )
          try {
            txTransaction = await repositories.txTransaction.save({
              id: txHashId,
              activity: txActivity,
              exchange: defs.ExchangeType.NFTCOM,
              transactionType: defs.ActivityType.Sale,
              protocol: defs.ProtocolType.NFTCOM,
              transactionHash: txHashId,
              blockNumber,
              nftContractAddress: txListingOrder?.activity?.nftContract || '0x',
              nftContractTokenId: '',
              maker: txListingOrder.makerAddress,
              taker: txListingOrder.takerAddress,
              chainId,
              protocolData: {
                ...txListingOrder.protocolData,
                makeAsset,
                takeAsset,
              },
            })

            logger.log(`tx saved: ${txTransaction.id} for order ${txListingOrder.id}`)
          } catch (err) {
            logger.error(`Tx err: ${err}`)
          }
        } catch (err) {
          logger.error(`Tx activity err: ${err}`)
        }
      } else {
        const activity = await repositories.txActivity.findOne({
          where: {
            activityTypeId: txHashId,
          },
        })
        if (activity) {
          await repositories.txActivity.updateOneById(activity.id, {
            nftId: [...nftIds],
            nftContract: contract === '0x' ? '0x' : helper.checkSum(contract),
          })
        }
        await repositories.txTransaction.updateOneById(txTransaction.id, {
          protocolData: {
            ...txTransaction.protocolData,
            makeAsset,
            takeAsset,
          },
        })
      }
      if (txListingOrder.makerAddress !== '0x') {
        try {
          // find transfer event
          const chainProvider = provider(Number(chainId))
          const txResponse = await chainProvider.getTransaction(transactionHash)
          const receipt = await txResponse.wait()
          logger.info(`Logs count: ${receipt.logs.length}`)
          const seen = {}
          for (const asset of makeAsset) {
            const key = `${utils.getAddress(txListingOrder.makerAddress)}-${helper.bigNumberToHex(asset.standard.tokenId)}`
            seen[key] = true
          }
          await Promise.allSettled(
            receipt.logs.map(async (log) => {
              if (log.topics[0] === TOKEN_TRANSFER_TOPIC) {
                try {
                  const evt = eventIface.parseLog(log)
                  const [from, to, tokenId] = evt.args
                  logger.info(`from ${from} to ${to} tokenId ${BigNumber.from(tokenId).toHexString()}`)
                  const key = `${utils.getAddress(from)}-${BigNumber.from(tokenId).toHexString()}`
                  if (seen[key]) {
                    logger.info(`NFTCOM Transfer: from ${from} to ${to} tokenId ${BigNumber.from(tokenId).toHexString()}`)
                    await repositories.txTransaction.updateOneById(txTransaction.id, {
                      taker: utils.getAddress(to),
                    })
                  }
                } catch (err) {
                  logger.error(`transfer parse error: ${err}`)
                }
              }
            }),
          )
        } catch (err) {
          logger.error(`transfers find error: ${err}`)
        }
      }
    } catch (err) {
      logger.error(`tx find error: ${err}`)
    }
  } catch (err) {
    logger.error(`err in matchTwoBEventHandler: ${err}`)
    throw err
  }
}

export const matchThreeAEventHandler = async (
  takerHash: string,
  makerAddress: string,
  takerAddress: string,
  start: number,
  end: number,
  nonce: number,
  salt: number,
  chainId: string,
): Promise<void> => {
  try {
    let txBidOrder = await repositories.txOrder.findOne({
      where: {
        orderHash: takerHash,
        exchange: defs.ExchangeType.NFTCOM,
        orderType: defs.ActivityType.Bid,
        protocol: defs.ProtocolType.NFTCOM,
        chainId,
      },
    })
    if (!txBidOrder) {
      const activity = await activityBuilder(
        defs.ActivityType.Bid,
        takerHash,
        makerAddress,
        chainId,
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
            v: 0,
            r: '0x0000000000000000000000000000000000000000000000000000000000000000',
            s: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
          salt,
          start,
          end,
          makeAsset: [],
          takeAsset: [],
        },
        makerAddress,
        takerAddress,
        chainId,
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
  } catch (err) {
    logger.error(`err in matchThreeAEventHandler: ${err}`)
    throw err
  }
}

export const matchThreeBEventHandler = async (
  buyerMakerOrderAssetData: string[],
  buyerMakerOrderAssetClass: string[],
  buyerMakerOrderAssetTypeData: string[],
  buyerTakerOrderAssetData: string[],
  buyerTakerOrderAssetClass: string[],
  buyerTakerOrderAssetTypeData: string[],
  takerHash: string,
  chainId: string,
): Promise<void> => {
  try {
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
        chainId,
      },
    })
    if (!txBidOrder) {
      const activity = await activityBuilder(
        defs.ActivityType.Bid,
        takerHash,
        '0x',
        chainId,
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
            v: 0,
            r: '0x0000000000000000000000000000000000000000000000000000000000000000',
            s: '0x0000000000000000000000000000000000000000000000000000000000000000',
          },
          salt: -1,
          start: 0,
          end: -1,
          makeAsset,
          takeAsset,
        },
        makerAddress: '0x',
        takerAddress: '0x',
        chainId,
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
  } catch (err) {
    logger.error(`err in matchThreeBEventHandler: ${err}`)
    throw err
  }
}

export const buyNowInfoEventHandler = async (
  makerHash: string,
  takerAddress: string,
): Promise<void> => {
  try {
    const txOrder = await repositories.txOrder.findOne({
      where: {
        orderHash: makerHash,
        exchange: defs.ExchangeType.NFTCOM,
        orderType: defs.ActivityType.Listing,
        protocol: defs.ProtocolType.NFTCOM,
      },
    })
    if (txOrder) {
      const activity = await repositories.txActivity.findOne({
        where: {
          activityTypeId: makerHash,
          activityType: defs.ActivityType.Listing,
        },
      })
      await repositories.txActivity.updateOneById(activity.id, {
        status: defs.ActivityStatus.Executed,
      })
      await repositories.txOrder.updateOneById(txOrder.id, {
        protocolData: {
          ...txOrder.protocolData,
          buyNowTaker: utils.getAddress(takerAddress),
        },
      })

      logger.info(`updated existing listing order from BuyNowInfo: ${txOrder.id}`)
    }
  } catch (err) {
    logger.error(`err in buyNowInfoEventHandler: ${err}`)
    throw err
  }
}
