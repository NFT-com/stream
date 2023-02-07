import { BigNumber, ethers, providers, utils } from 'ethers'
import { In, LessThan } from 'typeorm'

import { _logger, contracts, db, defs, entity, helper } from '@nftcom/shared'

import { delay } from '../utils'
import { cancelEntityBuilder, txEntityBuilder, txX2Y2ProtocolDataParser } from '../utils/builder/orderBuilder'
import { updateOwnership } from './ownership'

const repositories = db.newRepositories()
const nftResolverInterface = new utils.Interface(contracts.NftResolverABI())
const looksrareExchangeInterface = new utils.Interface(contracts.looksrareExchangeABI())
const openseaSeaportInterface = new utils.Interface(contracts.openseaSeaportABI())
const x2y2Interface = new utils.Interface(contracts.x2y2ABI())
const logger = _logger.Factory(_logger.Context.WebsocketProvider)

type KeepAliveParams = {
  provider: ethers.providers.WebSocketProvider
  chainId: providers.Networkish
  onDisconnect: (err: any) => void
  expectedPongBack?: number
  checkInterval?: number
}

enum EventName {
  AssociateEvmUser = 'AssociateEvmUser',
  CancelledEvmAssociation = 'CancelledEvmAssociation',
  ClearAllAssociatedAddresses = 'ClearAllAssociatedAddresses',
  AssociateSelfWithUser = 'AssociateSelfWithUser',
  RemovedAssociateProfile = 'RemovedAssociateProfile',
}

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

const keepAlive = ({
  provider,
  chainId,
  onDisconnect,
  expectedPongBack = 15000,
  checkInterval = 7500,
}: KeepAliveParams): Promise<void> => {
  let pingTimeout: NodeJS.Timeout | null = null
  let keepAliveInterval: NodeJS.Timeout | null = null

  provider._websocket.on('open', () => {
    logger.log(`---------> 🎬 websocket started on chainId: ${Number(chainId)}`)
    keepAliveInterval = setInterval(() => {
      provider._websocket.ping()

      // Use `WebSocket#terminate()`, which immediately destroys the connection,
      // instead of `WebSocket#close()`, which waits for the close timer.
      // Delay should be equal to the interval at which your server
      // sends out pings plus a conservative assumption of the latency.
      pingTimeout = setTimeout(() => {
        provider._websocket.terminate()
      }, expectedPongBack)
    }, checkInterval)

    // logic for listening and parsing via WSS
    const topicFilter = [
      [
        helper.id('AssociateEvmUser(address,string,address)'),
        helper.id('CancelledEvmAssociation(address,string,address)'),
        helper.id('ClearAllAssociatedAddresses(address,string)'),
        helper.id('AssociateSelfWithUser(address,string,address)'),
        helper.id('RemovedAssociateProfile(address,string,address)'),
      ],
    ]

    const nftResolverAddress = helper.checkSum(
      contracts.nftResolverAddress(Number(chainId).toString()),
    )
    logger.debug(`nftResolverAddress: ${nftResolverAddress}, chainId: ${chainId}`)

    const filter = {
      address: utils.getAddress(nftResolverAddress),
      topics: topicFilter,
    }

    provider.on(filter, async (e) => {
      const evt = nftResolverInterface.parseLog(e)
      logger.debug('******** wss parsed event: ', evt)

      if (evt.name === EventName.AssociateEvmUser) {
        const [owner,profileUrl,destinationAddress] = evt.args
        try {
          const event = await repositories.event.findOne({
            where: {
              chainId: Number(chainId),
              contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
              eventName: evt.name,
              txHash: e.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(e.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(destinationAddress),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId: Number(chainId),
                contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
                eventName: evt.name,
                txHash: e.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(e.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(destinationAddress),
              },
            )
            logger.debug(`New WSS NFT Resolver ${evt.name} event found. ${ profileUrl } (owner = ${owner}) is associating ${ destinationAddress }. chainId=${chainId}`)
          }
        } catch (err) {
          logger.error(`Evt: ${EventName.AssociateEvmUser} -- Err: ${err}`)
        }
      } else if (evt.name == EventName.CancelledEvmAssociation) {
        try {
          const [owner,profileUrl,destinationAddress] = evt.args
          const event = await repositories.event.findOne({
            where: {
              chainId: Number(chainId),
              contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
              eventName: evt.name,
              txHash: e.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(e.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(destinationAddress),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId: Number(chainId),
                contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
                eventName: evt.name,
                txHash: e.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(e.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(destinationAddress),
              },
            )
            logger.debug(`New WSS NFT Resolver ${evt.name} event found. ${ profileUrl } (owner = ${owner}) is cancelling ${ destinationAddress }. chainId=${chainId}`)
          }
        } catch (err) {
          logger.error(`Evt: ${EventName.CancelledEvmAssociation} -- Err: ${err}`)
        }
      } else if (evt.name == EventName.ClearAllAssociatedAddresses) {
        const [owner,profileUrl] = evt.args
        try {
          const event = await repositories.event.findOne({
            where: {
              chainId: Number(chainId),
              contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
              eventName: evt.name,
              txHash: e.transactionHash,
              ownerAddress: owner,
              blockNumber: Number(e.blockNumber),
              profileUrl: profileUrl,
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId: Number(chainId),
                contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
                eventName: evt.name,
                txHash: e.transactionHash,
                ownerAddress: owner,
                blockNumber: Number(e.blockNumber),
                profileUrl: profileUrl,
              },
            )
            logger.debug(`New NFT Resolver ${evt.name} event found. ${ profileUrl } (owner = ${owner}) cancelled all associations. chainId=${chainId}`)
          }
        } catch (err) {
          logger.error(`Evt: ${EventName.ClearAllAssociatedAddresses} -- Err: ${err}`)
        }
      } else if (evt.name === EventName.AssociateSelfWithUser ||
        evt.name === EventName.RemovedAssociateProfile) {
        const [receiver, profileUrl, profileOwner]  = evt.args
        try {
          const event = await repositories.event.findOne({
            where: {
              chainId: Number(chainId),
              contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
              eventName: evt.name,
              txHash: e.transactionHash,
              ownerAddress: profileOwner,
              blockNumber: Number(e.blockNumber),
              profileUrl: profileUrl,
              destinationAddress: helper.checkSum(receiver),
            },
          })
          if (!event) {
            await repositories.event.save(
              {
                chainId: Number(chainId),
                contract: helper.checkSum(contracts.nftResolverAddress(Number(chainId))),
                eventName: evt.name,
                txHash: e.transactionHash,
                ownerAddress: profileOwner,
                blockNumber: Number(e.blockNumber),
                profileUrl: profileUrl,
                destinationAddress: helper.checkSum(receiver),
              },
            )
            logger.debug(`New NFT Resolver ${evt.name} event found. profileUrl = ${profileUrl} (receiver = ${receiver}) profileOwner = ${[profileOwner]}. chainId=${chainId}`)
          }
        } catch (err) {
          logger.error(`Evt: ${evt.name} -- Err: ${err}`)
        }
      } else {
        // not relevant in our search space
        logger.error('topic hash not covered: ', e.transactionHash)
      }
    })

    const looksrareExchangeAddress = helper.checkSum(
      contracts.looksrareExchangeAddress(chainId.toString()),
    )

    logger.debug(`looksrareExchangeAddress: ${looksrareExchangeAddress}, chainId: ${chainId}`)

    // logic for listening to Looksrare on-chain events and parsing via WSS
    const looksrareTopicFilter = [
      [
        helper.id('CancelAllOrders(address,uint256)'),
        helper.id('CancelMultipleOrders(address,uint256[])'),
        helper.id('TakerAsk(bytes32,uint256,address,address,address,address,address,uint256,uint256,uint256)'),
        helper.id('TakerBid(bytes32,uint256,address,address,address,address,address,uint256,uint256,uint256)'),
      ],
    ]

    const looksrareFilter = {
      address: utils.getAddress(looksrareExchangeAddress),
      topics: looksrareTopicFilter,
    }

    provider.on(looksrareFilter, async (e) => {
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
                e.blockNumber,
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
                e.blockNumber,
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
              e.blockNumber,
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

            await updateOwnership(
              checksumContract,
              tokenId,
              maker,
              taker,
              chainId.toString(),
            )

            logger.log(`
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
              e.blockNumber,
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

            await updateOwnership(
              checksumContract,
              tokenId,
              maker,
              taker,
              chainId.toString(),
            )

            logger.log(`
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
    })

    const openseaSeaportAddress = helper.checkSum(
      contracts.openseaSeaportAddress(chainId.toString()),
    )

    logger.debug(`openseaSeaportAddress: ${openseaSeaportAddress}, chainId: ${chainId}`)

    // logic for listening to Seaport on-chain events and parsing via WSS
    const openseaTopicFilter = [
      [
        helper.id('OrderCancelled(bytes32,address,address)'),
        helper.id('CounterIncremented(unint256,address)'),
        helper.id('OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])'),
      ],
    ]

    const openseaFilter = {
      address: utils.getAddress(openseaSeaportAddress),
      topics: openseaTopicFilter,
    }

    provider.on(openseaFilter, async (e) => {
      const evt = openseaSeaportInterface.parseLog(e)
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
              e.blockNumber,
              chainId.toString(),
              order.activity.nftContract,
              order.activity.nftId,
              order.makerAddress,
              defs.ExchangeType.OpenSea,
              order.orderType as defs.CancelActivityType,
              order.id,
            )

            await repositories.txCancel.save(cancelledEntity)
            logger.log(`
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
                e.blockNumber,
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
            logger.log(`
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
              e.blockNumber,
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
            
            await updateOwnership(
              contract,
              tokenId,
              offerer,
              recipient,
              chainId.toString(),
            )
            logger.log(`
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
    })

    const x2y2Address = helper.checkSum(
      contracts.x2y2Address(chainId.toString()),
    )

    logger.debug(`x2y2Address: ${x2y2Address}, chainId: ${chainId}`)
    const orderItemParamType = '(uint256,bytes)'
    const feeParamType = '(uint256,address)'
    const settleDetailParamType = `(uint8,uint256,uint256,uint256,bytes32,address,bytes,uint256,uint256,uint256,${feeParamType}[])`
    // logic for listening to Seaport on-chain events and parsing via WSS
    const x2y2TopicFilter = [
      [
        helper.id('EvCancel(bytes32)'),
        helper.id('EvProfit(bytes32,address,address,uint256)'),
        helper.id(`EvInventory(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,address,bytes,${orderItemParamType},${settleDetailParamType})`),
      ],
    ]

    const x2y2Filter = {
      address: utils.getAddress(x2y2Address),
      topics: x2y2TopicFilter,
    }

    provider.on(x2y2Filter, async (e) => {
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
            logger.log(`
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
            await updateOwnership(
              contract,
              tokenId,
              order.makerAddress,
              to,
              chainId.toString(),
            )

            logger.log(`
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

            logger.log(`
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
            await updateOwnership(
              contract,
              tokenId,
              maker,
              taker,
              chainId.toString(),
            )
            logger.log(`
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

            logger.log(`
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
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider._websocket.on('close', (err: any) => {
    if (keepAliveInterval) clearInterval(keepAliveInterval)
    if (pingTimeout) clearTimeout(pingTimeout)
    onDisconnect(err)
  })

  provider._websocket.on('pong', () => {
    if (pingTimeout) clearInterval(pingTimeout)
  })

  // ws error
  provider._websocket.on('error', (err) => logger.log('Alchemy provider error', err))

  return Promise.resolve()
}

let provider: ethers.providers.WebSocketProvider
// on-chain provider
export const startProvider = (
  chainId: providers.Networkish = 1, //mainnet default
): Promise<void> => {
  if (!process.env.DISABLE_WEBSOCKET) {
    logger.log(`---------> 🎬 starting websocket on chainId: ${Number(chainId)}`)
    try {
      provider = ethers.providers.AlchemyProvider.getWebSocketProvider(
        Number(chainId),
        process.env.ALCHEMY_API_KEY,
      )
      keepAlive({
        provider,
        chainId,
        onDisconnect: (err) => {
          startProvider(chainId)
          logger.error(err, 'The ws connection was closed')
        },
      })
    } catch (err) {
      logger.error('WS Error', err)
    }
  }
  return Promise.resolve()
}

// stop on-chain provider
export const stopProvider = (): Promise<void> => {
  logger.debug('---------> 🎬 stopping websocket')

  if (!process.env.DISABLE_WEBSOCKET) {
    if (provider) {
      provider.websocket.close()
    }
  }
  return Promise.resolve()
}