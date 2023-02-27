import { BigNumber, ethers, providers, utils } from 'ethers'
import { In, LessThan } from 'typeorm'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore:next-line
import {  nftService } from '@nftcom/gql/service'
import { _logger, contracts, db, defs, entity, helper } from '@nftcom/shared'

import { delay } from '../'
import { cancelEntityBuilder, txEntityBuilder, txX2Y2ProtocolDataParser } from '../builder/orderBuilder'

const repositories = db.newRepositories()
const logger = _logger.Factory(_logger.Context.WebsocketProvider)

enum LooksrareEventName {
  CancelAllOrders = 'CancelAllOrders',
  CancelMultipleOrders = 'CancelMultipleOrders',
  TakerAsk = 'TakerAsk',
  TakerBid = 'TakerBid'
}
  
enum OSSeaportEventName {
  OrderCancelled = 'OrderCancelled',
  CounterIncremented = 'CounterIncremented',
  OrderFulfilled = 'OrderFulfilled'
}
  
enum X2Y2EventName {
  EvProfit = 'EvProfit',
  EvInventory = 'EvInventory',
  EvCancel = 'EvCancel'
}
const looksrareExchangeInterface = new utils.Interface(contracts.looksrareExchangeABI())
const openseaSeaportInterface = new utils.Interface(contracts.openseaSeaportABI())
const x2y2Interface = new utils.Interface(contracts.x2y2ABI())

export const provider = (
  chainId: providers.Networkish = 1, // mainnet default
  infura?: boolean,
): ethers.providers.BaseProvider => {
  if (process.env.USE_ZMOK == 'true' && Number(chainId) == 1) { // zmok only supports mainnet and rinkeby (feb 2023)
    logger.info('Using zmok provider [eventLogParser]')
    return new ethers.providers.JsonRpcProvider(process.env.ZMOK_RPC_URL)
  } else if (infura) { // dedicated key
    logger.info('Using dedicated infura provider [eventLogParser]')
    return new ethers.providers.InfuraProvider(chainId, process.env.INFURA_API_KEY)
  } else if (process.env.USE_INFURA == 'true') {
    logger.info('Using infura provider [eventLogParser]')
    const items = process.env.INFURA_KEY_SET.split(',')
    const randomKey = items[Math.floor(Math.random() * items.length)]
    return new ethers.providers.InfuraProvider(chainId, randomKey)
  } else {
    logger.info('Using alchemy provider [eventLogParser]')
    return new ethers.providers.AlchemyProvider(chainId, process.env.ALCHEMY_API_KEY)
  }
}

export const txEventLogs = async (
  provider: ethers.providers.BaseProvider,
  blockHash: string,
  topics: any[],
): Promise<ethers.providers.Log[]> => {
  const filter = {
    topics,
    blockHash,
  }
  const eventLogs: ethers.providers.Log[] = await provider.getLogs(filter)

  return eventLogs
}

export const seaportParseLog = (log: any): any => {
  return openseaSeaportInterface.parseLog(log)
}

export const fulfillOrCancelSeaport = async (
  e: any,
  chainId: string,
): Promise<void> => {
  const evt = seaportParseLog(e)
  if(evt.name === OSSeaportEventName.OrderCancelled) {
    const [orderHash, offerer, zone] = evt.args
    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          makerAddress: helper.checkSum(offerer),
          zone: helper.checkSum(zone),
          exchange: defs.ExchangeType.OpenSea,
          protocol: defs.ProtocolType.Seaport,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })
  
      if (order) {
        order.activity.status = defs.ActivityStatus.Cancelled
        await repositories.txOrder.save(order)

        const cancelledEntity: Partial<entity.TxCancel> = await cancelEntityBuilder(
          defs.ActivityType.Cancel,
          `${e.transactionHash}:${orderHash}`,
          `${e.blockNumber}`,
          chainId.toString(),
          order.activity.nftContract,
          order.activity.nftId,
          order.makerAddress,
          defs.ExchangeType.OpenSea,
          order.orderType as defs.CancelActivityType,
          order.id,
        )

        await repositories.txCancel.save(cancelledEntity)
        logger.debug(`
            Evt Saved: ${OSSeaportEventName.OrderCancelled} for orderHash ${orderHash},
            offerer ${offerer},
            zone ${zone}
        `)
      }
    } catch (err) {
      logger.error(`Evt: ${OSSeaportEventName.OrderCancelled} -- Err: ${err}`)
    }
  } else if (evt.name === OSSeaportEventName.CounterIncremented) {
    const [newCounter, offerer] = evt.args
    try {
      const orders: entity.TxOrder[] = await repositories.txOrder.find({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          makerAddress: helper.checkSum(offerer),
          nonce: helper.lessThan(newCounter),
          exchange: defs.ExchangeType.OpenSea,
          protocol: defs.ProtocolType.Seaport,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })
  
      if (orders.length) {
        const cancelEntityPromises: Promise<Partial<entity.TxCancel>>[] = []
        for (const order of orders) {
          order.activity.status = defs.ActivityStatus.Cancelled
          cancelEntityPromises.push(cancelEntityBuilder(
            defs.ActivityType.Cancel,
            `${e.transactionHash}:${order.orderHash}`,
            `${e.blockNumber}`,
            chainId.toString(),
            order.activity.nftContract,
            order.activity.nftId,
            order.makerAddress,
            defs.ExchangeType.OpenSea,
            order.orderType as defs.CancelActivityType,
            order.id,
          ))
        }
        await repositories.txOrder.saveMany(orders)
        const cancelEntities = await Promise.all(cancelEntityPromises)
        await repositories.txCancel.saveMany(cancelEntities)
        logger.debug(`
              Evt Saved: ${OSSeaportEventName.CounterIncremented} for
              offerer ${offerer}
        `)
      }
    } catch (err) {
      logger.error(`Evt: ${OSSeaportEventName.CounterIncremented} -- Err: ${err}`)
    }
  } else if (evt.name === OSSeaportEventName.OrderFulfilled) {
    const [orderHash, offerer, zone, recipient, offer, consideration] = evt.args
    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          makerAddress: helper.checkSum(offerer),
          zone: helper.checkSum(zone),
          exchange: defs.ExchangeType.OpenSea,
          protocol: defs.ProtocolType.Seaport,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })
      if (order) {
        order.activity.status = defs.ActivityStatus.Executed
        order.takerAddress = helper.checkSum(recipient)
        await repositories.txOrder.save(order)
        // new transaction
        const newTx: Partial<entity.TxTransaction> = await txEntityBuilder(
          defs.ActivityType.Sale,
          `${e.transactionHash}:${orderHash}`,
          `${e.blockNumber}`,
          chainId.toString(),
          order.activity.nftContract,
          order.protocolData?.parameters?.offer?.[0]?.identifierOrCriteria,
          offerer,
          recipient,
          defs.ExchangeType.OpenSea,
          order.protocol,
          {
            offer: offer,
            consideration: consideration,
          },
          OSSeaportEventName.OrderFulfilled,
        )
        await repositories.txTransaction.save(newTx)

        // update NFT ownership
        const contract: string = helper.checkSum(order.activity.nftContract)
        const tokenId: string = helper.bigNumberToHex(
          order.protocolData?.parameters?.offer?.[0]?.identifierOrCriteria,
        )
        const obj = {
          contract: {
            address: contract,
          },
          id: {
            tokenId,
          },
        }

        const wallet = await nftService.getUserWalletFromNFT(
          contract, tokenId, chainId.toString(),
        )
        if (wallet) {
          await nftService.updateNFTOwnershipAndMetadata(
            obj, wallet.userId, wallet.id, chainId.toString(),
          )
        }
        logger.debug(`
        Evt Saved: ${OSSeaportEventName.OrderFulfilled} for orderHash ${orderHash},
        offerer ${offerer},
        zone ${zone}
    `)
      }
    } catch (err) {
      logger.error(`Evt: ${OSSeaportEventName.OrderFulfilled} -- Err: ${err}`)
    }
  } else {
    // not relevant in our search space
    logger.error('topic hash not covered: ', e.transactionHash)
  }
}
  
export const seaportEventLogs = async (
  provider: ethers.providers.BaseProvider,
  blockHash: string,
  chainId: string,
): Promise<void> => {
  // logic for listening to Seaport on-chain events and parsing via WSS
  const openseaTopicFilter = [
    [
      helper.id('OrderCancelled(bytes32,address,address)'),
      helper.id('CounterIncremented(unint256,address)'),
      helper.id('OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])'),
    ],
  ]
  const seaportEventLogs: ethers.providers.Log[] = await txEventLogs(
    provider,
    blockHash,
    openseaTopicFilter,
  )

  for (const e of seaportEventLogs) {
    await fulfillOrCancelSeaport(
      e,
      chainId,
    )
  }
}

export const looksrareParseLog = (log: any): any => {
  return looksrareExchangeInterface.parseLog(log)
}

export const fulfillOrCancelLooksrare = async (
  e: ethers.providers.Log,
  chainId: string,
): Promise<void> => {
  const evt = looksrareExchangeInterface.parseLog(e)
  if (evt.name === LooksrareEventName.CancelAllOrders) {
    const [user, newMinNonce] = evt.args
    const newMinNonceInNumber = helper.bigNumberToNumber(newMinNonce)
    
    try {
      const orders: entity.TxOrder[] = await repositories.txOrder.find({
        relations: ['activity'],
        where: {
          makerAddress: helper.checkSum(user),
          nonce: LessThan(newMinNonceInNumber),
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })

      if (orders.length) {
        const cancelEntityPromises: Promise<Partial<entity.TxCancel>>[] = []
        for (const order of orders) {
          order.activity.status = defs.ActivityStatus.Cancelled
          cancelEntityPromises.push(cancelEntityBuilder(
            defs.ActivityType.Cancel,
            `${e.transactionHash}:${order.orderHash}`,
            `${e.blockNumber}`,
            chainId.toString(),
            order.activity.nftContract,
            order.activity.nftId,
            order.makerAddress,
            defs.ExchangeType.LooksRare,
            order.orderType as defs.CancelActivityType,
            order.id,
          ))
        }

        await repositories.txOrder.saveMany(orders)
        const cancelEntities = await Promise.all(cancelEntityPromises)
        await repositories.txCancel.saveMany(cancelEntities)
        logger.debug(`Evt Saved: ${LooksrareEventName.CancelAllOrders} -- txhash: ${e.transactionHash}`)
      }
    } catch (err) {
      logger.error(`Evt: ${LooksrareEventName.CancelAllOrders} -- Err: ${err}`)
    }
  } else if (evt.name === LooksrareEventName.CancelMultipleOrders) {
    const [user, orderNonces] = evt.args
    const nonces: number[] = orderNonces?.map(
      (orderNonce: BigNumber) => helper.bigNumberToNumber(orderNonce),
    )
    try {
      const orders: entity.TxOrder[] = await repositories.txOrder.find({
        relations: ['activity'],
        where: {
          makerAddress: helper.checkSum(user),
          nonce: In([...nonces]),
          exchange: defs.ExchangeType.LooksRare,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })

      if (orders.length) {
        const cancelEntityPromises: Promise<Partial<entity.TxCancel>>[] = []
        for (const order of orders) {
          order.activity.status = defs.ActivityStatus.Cancelled
          cancelEntityPromises.push(cancelEntityBuilder(
            defs.ActivityType.Cancel,
            `${e.transactionHash}:${order.orderHash}`,
            `${e.blockNumber}`,
            chainId.toString(),
            helper.checkSum(order.activity.nftContract),
            order.activity.nftId,
            helper.checkSum(order.makerAddress),
            defs.ExchangeType.LooksRare,
            order.orderType as defs.CancelActivityType,
            order.id,
          ))
        }
        await repositories.txOrder.saveMany(orders)
        const cancelEntities = await Promise.all(cancelEntityPromises)
        await repositories.txCancel.saveMany(cancelEntities)
        logger.debug(`Evt Saved: ${LooksrareEventName.CancelMultipleOrders} -- txhash: ${e.transactionHash}`)
      }
    } catch (err) {
      logger.error(`Evt: ${LooksrareEventName.CancelMultipleOrders} -- Err: ${err}`)
    }
  } else if (evt.name === LooksrareEventName.TakerAsk) {
    const [orderHash, orderNonce, taker, maker, strategy, currency, collection] = evt.args
    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          makerAddress: helper.checkSum(maker),
          exchange: defs.ExchangeType.LooksRare,
          protocol: defs.ProtocolType.LooksRare,
          activity: {
            status: defs.ActivityStatus.Valid,
            nftContract: helper.checkSum(collection),
          },
        },
      })
      
      if (order) {
        order.activity.status = defs.ActivityStatus.Executed
        order.takerAddress = helper.checkSum(taker)
        await repositories.txOrder.save(order)

        const checksumContract: string = helper.checkSum(collection)
        
        // new transaction
        const newTx: Partial<entity.TxTransaction> = await txEntityBuilder(
          defs.ActivityType.Sale,
          `${e.transactionHash}:${order.orderHash}`,
          `${e.blockNumber}`,
          chainId.toString(),
          checksumContract,
          order.protocolData?.tokenId,
          maker,
          taker,
          defs.ExchangeType.LooksRare,
          order.protocolData?.price,
          order.protocolData?.currencyAddress,
          LooksrareEventName.TakerAsk,
        )
        await repositories.txTransaction.save(newTx)

        // update NFT ownership
        const tokenId: string = helper.bigNumberToHex(order.protocolData?.tokenId)

        const obj = {
          contract: {
            address: checksumContract,
          },
          id: {
            tokenId,
          },
        }

        const wallet = await nftService.getUserWalletFromNFT(
          checksumContract, tokenId, chainId.toString(),
        )

        if (wallet) {
          await nftService.updateNFTOwnershipAndMetadata(
            obj, wallet.userId, wallet.id, chainId.toString(),
          )
        }

        logger.debug(`
            updated ${orderHash} for collection ${collection} -- strategy:
            ${strategy}, currency:${currency} orderNonce:${orderNonce}
            `)
      }
    } catch (err) {
      logger.error(`Evt: ${LooksrareEventName.TakerAsk} -- Err: ${err}`)
    }
  } else if (evt.name === LooksrareEventName.TakerBid) {
    const [orderHash, orderNonce, taker, maker, strategy, currency, collection] = evt.args
    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          makerAddress: helper.checkSum(maker),
          exchange: defs.ExchangeType.LooksRare,
          protocol: defs.ProtocolType.LooksRare,
          activity: {
            status: defs.ActivityStatus.Valid,
            nftContract: helper.checkSum(collection),
          },
        },
      })

      if (order) {
        order.activity.status = defs.ActivityStatus.Executed
        order.takerAddress = helper.checkSum(taker)
        await repositories.txOrder.save(order)

        const checksumContract: string = helper.checkSum(collection)
    
        // new transaction
        const newTx: Partial<entity.TxTransaction> = await txEntityBuilder(
          defs.ActivityType.Sale,
          `${e.transactionHash}:${orderHash}`,
          `${e.blockNumber}`,
          chainId.toString(),
          checksumContract,
          order.protocolData?.tokenId,
          maker,
          taker,
          defs.ExchangeType.LooksRare,
          order.protocol,
          order.protocolData,
          LooksrareEventName.TakerBid,
        )
        await repositories.txTransaction.save(newTx)

        // update NFT ownership
        const tokenId: string = helper.bigNumberToHex(order.protocolData?.tokenId)

        const obj = {
          contract: {
            address: checksumContract,
          },
          id: {
            tokenId,
          },
        }

        const wallet = await nftService.getUserWalletFromNFT(
          checksumContract, tokenId, chainId.toString(),
        )

        if (wallet) {
          await nftService.updateNFTOwnershipAndMetadata(
            obj, wallet.userId, wallet.id, chainId.toString(),
          )
        }

        logger.debug(`
        updated ${orderHash} for collection ${collection} -- strategy:
        ${strategy}, currency:${currency} orderNonce:${orderNonce}
        `)
      }
    } catch (err) {
      logger.error(`Evt: ${LooksrareEventName.TakerBid} -- Err: ${err}`)
    }
  } else {
    // not relevant in our search space
    logger.error('topic hash not covered: ', e.transactionHash)
  }
}
  
export const looksrareEventLogs = async (
  provider: ethers.providers.BaseProvider,
  blockHash: string,
  chainId,
): Promise<void> => {
  // logic for listening to Looksrare on-chain events and parsing via WSS
  const looksrareTopicFilter = [
    [
      helper.id('CancelAllOrders(address,uint256)'),
      helper.id('CancelMultipleOrders(address,uint256[])'),
      helper.id('TakerAsk(bytes32,uint256,address,address,address,address,address,uint256,uint256,uint256)'),
      helper.id('TakerBid(bytes32,uint256,address,address,address,address,address,uint256,uint256,uint256)'),
    ],
  ]

  const looksrareEventLogs = await txEventLogs(
    provider,
    blockHash,
    looksrareTopicFilter,
  )

  for (const e of looksrareEventLogs) {
    try {
      await fulfillOrCancelLooksrare(
        e,
        chainId,
      )
    } catch (err) {
      logger.error('')
    }
  }
}

export const x2y2ParseLog = (log: any): any => {
  return x2y2Interface.parseLog(log)
}

export const fulfillOrCancelX2Y2 = async (
  e: any,
  chainId: string,
): Promise<void> => {
  const evt = x2y2Interface.parseLog(e)
  if(evt.name === X2Y2EventName.EvCancel) {
    const [orderHash] = evt.args
    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          exchange: defs.ExchangeType.X2Y2,
          protocol: defs.ProtocolType.X2Y2,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })
  
      if (order) {
        order.activity.status = defs.ActivityStatus.Cancelled
        await repositories.txOrder.save(order)

        const cancelledEntity: Partial<entity.TxCancel> = await cancelEntityBuilder(
          defs.ActivityType.Cancel,
          `${e.transactionHash}:${orderHash}`,
          e.blockNumber,
          chainId.toString(),
          order.activity.nftContract,
          order.activity.nftId,
          order.makerAddress,
          defs.ExchangeType.X2Y2,
          order.orderType as defs.CancelActivityType,
          order.id,
        )

        await repositories.txCancel.save(cancelledEntity)
        logger.debug(`
            Evt Saved: ${X2Y2EventName.EvCancel} for orderHash ${orderHash}
        `)
      }
    } catch (err) {
      logger.error(`Evt: ${X2Y2EventName.EvCancel} -- Err: ${err}`)
    }
  } else if (evt.name === X2Y2EventName.EvProfit) {
    const [orderHash, currency, to, amount] = evt.args

    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          exchange: defs.ExchangeType.X2Y2,
          protocol: defs.ProtocolType.X2Y2,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })

      if (order) {
        order.activity.status = defs.ActivityStatus.Executed
        order.takerAddress = helper.checkSum(to)
        await repositories.txOrder.save(order)

        // new transaction
        const newTx: Partial<entity.TxTransaction> = await txEntityBuilder(
          defs.ActivityType.Sale,
          `${e.transactionHash}:${orderHash}`,
          e.blockNumber,
          chainId.toString(),
          order.activity.nftContract,
          order.protocolData?.tokenId,
          order.makerAddress,
          to,
          defs.ExchangeType.X2Y2,
          order.protocol,
          {
            currency,
            amount,
          },
          X2Y2EventName.EvProfit,
        )
        await repositories.txTransaction.save(newTx)

        // update NFT ownership
        const contract: string = helper.checkSum(order.activity.nftContract)
        const tokenId: string = helper.bigNumberToHex(
          order.protocolData?.tokenId,
        )
        const obj = {
          contract: {
            address: contract,
          },
          id: {
            tokenId,
          },
        }

        const wallet = await nftService.getUserWalletFromNFT(
          contract, tokenId, chainId.toString(),
        )
        if (wallet) {
          await nftService.updateNFTOwnershipAndMetadata(
            obj, wallet.userId, wallet.id, chainId.toString(),
          )
        }

        logger.debug(`
              Evt Saved: ${X2Y2EventName.EvProfit} for orderHash ${orderHash}
              and ownership updated
          `)
      }

      // allow 5s for other event to propagate before updating tx
      await delay(5000)

      // check for existing tx and update protocol data
      const transactionId = `${e.transactionHash}:${orderHash}`

      const existingTx: Partial<entity.TxTransaction> = await repositories.txTransaction
        .findOne({
          relations: ['activity'],
          where: {
            chainId: String(chainId),
            id: transactionId,
            exchange: defs.ExchangeType.X2Y2,
            protocol: defs.ProtocolType.X2Y2,
          },
        })

      if (existingTx) {
        // update protocol data if tx exists
        const updatedProtocolData = { ...existingTx.protocolData, amount }
        const protocolDataFormatted = txX2Y2ProtocolDataParser(updatedProtocolData)
        await repositories.txTransaction.updateOneById(
          transactionId,
          { protocolData: { ...protocolDataFormatted },
          })

        logger.debug(`
              Evt Updated: ${X2Y2EventName.EvProfit} for orderHash ${orderHash}
          `)
      }
    } catch (err) {
      logger.error(`Evt: ${X2Y2EventName.EvProfit} -- Err: ${err}`)
    }
  } else if (evt.name === X2Y2EventName.EvInventory) {
    const [
      orderHash,
      maker,
      taker,
      orderSalt,
      settleSalt,
      intent,
      delegateType,
      deadline,
      currency,
      data] = evt.args
    try {
      const order: entity.TxOrder = await repositories.txOrder.findOne({
        relations: ['activity'],
        where: {
          chainId: String(chainId),
          id: orderHash,
          makerAddress: helper.checkSum(maker),
          exchange: defs.ExchangeType.X2Y2,
          protocol: defs.ProtocolType.X2Y2,
          activity: {
            status: defs.ActivityStatus.Valid,
          },
        },
      })

      const protocolData =  {
        orderSalt,
        settleSalt,
        intent,
        delegateType,
        deadline,
        currency,
        data,
      }

      if (order) {
        order.activity.status = defs.ActivityStatus.Executed
        order.takerAddress = helper.checkSum(taker)
        await repositories.txOrder.save(order)

        // new transaction
        const newTx: Partial<entity.TxTransaction> = await txEntityBuilder(
          defs.ActivityType.Sale,
          `${e.transactionHash}:${orderHash}`,
          e.blockNumber,
          chainId.toString(),
          order.activity.nftContract,
          order.protocolData?.tokenId,
          maker,
          taker,
          defs.ExchangeType.X2Y2,
          order.protocol,
          protocolData,
          X2Y2EventName.EvInventory,
        )
        await repositories.txTransaction.save(newTx)

        // update NFT ownership
        const contract: string = helper.checkSum(order.activity.nftContract)
        const tokenId: string = helper.bigNumberToHex(
          order.protocolData?.tokenId,
        )
        const obj = {
          contract: {
            address: contract,
          },
          id: {
            tokenId,
          },
        }

        const wallet = await nftService.getUserWalletFromNFT(
          contract, tokenId, chainId.toString(),
        )
        if (wallet) {
          await nftService.updateNFTOwnershipAndMetadata(
            obj, wallet.userId, wallet.id, chainId.toString(),
          )
        }
        logger.debug(`
          Evt Saved: ${X2Y2EventName.EvInventory} for orderHash ${orderHash}
          and ownership updated
          `)
      }

      // allow 5s for other event to propagate before updating
      await delay(5000)

      // check for existing tx and update protocol data
      const transactionId = `${e.transactionHash}:${orderHash}`

      const existingTx: Partial<entity.TxTransaction> = await repositories.txTransaction
        .findOne({
          relations: ['activity'],
          where: {
            chainId: String(chainId),
            id: transactionId,
            exchange: defs.ExchangeType.X2Y2,
            protocol: defs.ProtocolType.X2Y2,
          },
        })

      if (existingTx) {
        // update protocol data if tx exists
        const updatedProtocolData = { ...existingTx.protocolData, ...protocolData }
        const protocolDataFormatted = txX2Y2ProtocolDataParser(updatedProtocolData)
        await repositories.txTransaction.updateOneById(
          transactionId,
          { protocolData: { ...protocolDataFormatted },
          })

        logger.debug(`
              Evt Updated: ${X2Y2EventName.EvInventory} for orderHash ${orderHash}
          `)
      }
    } catch (err) {
      logger.error(`Evt: ${X2Y2EventName.EvInventory} -- Err: ${err}`)
    }
  } else {
    // not relevant in our search space
    logger.error('topic hash not covered: ', e.transactionHash)
  }
}

export const x2y2EventLogs= async (
  provider: ethers.providers.BaseProvider,
  blockHash: string,
  chainId: string,
): Promise<void> => {
  const orderItemParamType = '(uint256,bytes)'
  const feeParamType = '(uint256,address)'
  const settleDetailParamType = `(uint8,uint256,uint256,uint256,bytes32,address,bytes,uint256,uint256,uint256,${feeParamType}[])`

  // logic for listening to X2Y2 on-chain events and parsing via WSS
  const x2y2TopicFilter = [
    [
      helper.id('EvCancel(bytes32)'),
      helper.id('EvProfit(bytes32,address,address,uint256)'),
      helper.id(`EvInventory(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,address,bytes,${orderItemParamType},${settleDetailParamType})`),
    ],
  ]

  const x2y2EventLogs = await txEventLogs(
    provider,
    blockHash,
    x2y2TopicFilter,
  )

  for (const e of x2y2EventLogs) {
    try {
      await fulfillOrCancelX2Y2(
        e,
        chainId,
      )
    } catch (err) {
      logger.error(`Error while fulfilling or cancelling X2Y2: ${err}`)
      continue
    }
  }
}

export const reconcileOrders = async (
  exchange: defs.ExchangeType,
  blockHash: string,
  chainId: string,
): Promise<void> => {
  const etherProvider = provider(chainId)
  let reconcileExchangeOrders
  switch(exchange) {
  case defs.ExchangeType.OpenSea:
    reconcileExchangeOrders = seaportEventLogs
    break
  case defs.ExchangeType.LooksRare:
    reconcileExchangeOrders = looksrareEventLogs
    break
  case defs.ExchangeType.X2Y2:
    reconcileExchangeOrders = x2y2EventLogs
    break
    // future implementation for NFTCOM reconciliation
  case defs.ExchangeType.NFTCOM:
    break
  }

  await reconcileExchangeOrders(
    etherProvider,
    blockHash,
    chainId,
  )
}

