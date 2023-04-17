import { BigNumber } from 'ethers'

import { db, defs, entity, helper } from '@nftcom/shared'

import { SeaportConsideration, TxLooksrareV2ProtocolData, TxSeaportProtocolData, TxX2Y2ProtocolData } from '../../interface'
import { LooksRareOrderV2 } from '../../service/looksrare'
import { SeaportOffer, SeaportOrder } from '../../service/opensea'

type Order = SeaportOrder | LooksRareOrderV2

type TxProtocolData = TxSeaportProtocolData | TxLooksrareV2ProtocolData | TxX2Y2ProtocolData

const repositories = db.newRepositories()

/**
 * activityBuilder
 * @param activityType - type of activity
 * @param activityHash - orderHash for off-chain, txHash for on-chain
 * @param walletId - maker address
 * @param chainId - chainId
 * @param contract - asset contract
 * @param timestampFromSource - event creation timestamp of activity
 * @param expirationFromSource - expiration or null for on-chain
 */
export const activityBuilder = async (
  activityType: defs.ActivityType,
  activityHash: string,
  walletAddress: string,
  chainId: string,
  nftIds: string[],
  contract: string,
  timestampFromSource: number,
  expirationFromSource: number,
): Promise<entity.TxActivity> => {
  let activity: entity.TxActivity
  if (activityHash) {
    activity = await repositories.txActivity.findOne({ where: { activityTypeId: activityHash } })
    if (activity) {
      activity.updatedAt = new Date()
      // in case contract is not present for default contracts
      activity.nftContract = contract === '0x' ? '0x' : helper.checkSum(contract)
      return activity
    }
  }

  // new activity
  activity = new entity.TxActivity()
  activity.activityType = activityType
  activity.activityTypeId = activityHash
  activity.read = false
  activity.timestamp = new Date(timestampFromSource * 1000) // convert to ms
  activity.expiration = expirationFromSource ? new Date(expirationFromSource * 1000) : null // conver to ms
  activity.walletAddress = walletAddress === '0x' ? '0x' : helper.checkSum(walletAddress)
  activity.chainId = chainId
  activity.nftContract = contract === '0x' ? '0x' : helper.checkSum(contract)
  activity.nftId = [...nftIds]
  activity.status = defs.ActivityStatus.Valid

  return activity
}

/**
 * seaportOrderBuilder
 * @param order
 */
const seaportOrderBuilder = (
  order: SeaportOrder,
): Partial<entity.TxOrder> => {
  return {
    exchange: defs.ExchangeType.OpenSea,
    makerAddress: order.maker?.address ? helper.checkSum(order.maker?.address): null,
    takerAddress: order.taker?.address ? helper.checkSum(order.taker?.address): null,
    nonce: order.protocol_data?.parameters?.counter, // counter is mapped to nonce for OS
    zone: order.protocol_data?.parameters?.zone, // only mapped for OS
    protocolData: {
      ...order.protocol_data,
    },
  }
}

/**
 * looksrareOrderBuilder
 * @param order
 */

const looksrareOrderBuilder = (
  order: LooksRareOrderV2,
): Partial<entity.TxOrder> => {
  return {
    exchange: defs.ExchangeType.LooksRare,
    makerAddress: helper.checkSum(order.signer),
    takerAddress: null,
    nonce: Number(order.orderNonce),
    hexNonce: order.globalNonce,
    protocolData: {
      ...order,
      signer: helper.checkSum(order.signer),
      collection: helper.checkSum(order.collection),
      currency: helper.checkSum(order.currency),
    },
  }
}

/**
 * orderEntityBuilder
 * @param protocol
 * @param orderType
 * @param order
 * @param chainId
 * @param contract
 */

export const orderEntityBuilder = async (
  protocol: defs.ProtocolType,
  orderType: defs.ActivityType,
  order: Order,
  chainId: string,
  contract: string,
):  Promise<Partial<entity.TxOrder>> => {
  let orderHash: string,
    walletAddress: string,
    tokenId: string,
    orderEntity: Partial<entity.TxOrder>,
    nftIds: string[],
    timestampFromSource: number,
    expirationFromSource: number

  let seaportOrder: SeaportOrder
  let looksrareOrder: LooksRareOrderV2
  const checksumContract: string = helper.checkSum(contract)
  switch (protocol) {
  case defs.ProtocolType.Seaport:
    seaportOrder = order as SeaportOrder
    orderHash = seaportOrder.order_hash
    walletAddress = helper.checkSum(seaportOrder?.protocol_data?.parameters?.offerer)
    timestampFromSource = Number(seaportOrder?.protocol_data?.parameters?.startTime)
    expirationFromSource = Number(seaportOrder?.protocol_data?.parameters?.endTime)
    nftIds = seaportOrder?.protocol_data?.parameters?.offer?.map((offer: SeaportOffer) => {
      tokenId = BigNumber.from(offer.identifierOrCriteria).toHexString()
      return `ethereum/${checksumContract}/${tokenId}`
    })
    orderEntity = seaportOrderBuilder(seaportOrder)
    break
  case defs.ProtocolType.LooksRareV2:
    looksrareOrder = order as LooksRareOrderV2
    orderHash = looksrareOrder.hash
    walletAddress = helper.checkSum(looksrareOrder.signer)
    tokenId = BigNumber.from(looksrareOrder.itemIds[0]).toHexString()
    timestampFromSource = Number(looksrareOrder.startTime)
    expirationFromSource =  Number(looksrareOrder.endTime)
    nftIds = [`ethereum/${checksumContract}/${tokenId}`]
    orderEntity = looksrareOrderBuilder(looksrareOrder)
    break
  default:
    break
  }

  const activity: entity.TxActivity = await activityBuilder(
    orderType,
    orderHash,
    walletAddress,
    chainId,
    nftIds,
    checksumContract,
    timestampFromSource,
    expirationFromSource,
  )

  return {
    id: orderHash,
    activity,
    orderType,
    orderHash,
    chainId,
    protocol,
    ...orderEntity,
  }
}

/**
 * txSeaportProcotolDataParser
 * @param protocolData
 */

export const txSeaportProcotolDataParser = (protocolData: any): TxSeaportProtocolData => {
  const { offer, consideration } = protocolData
  const txOffer: SeaportOffer[] = offer.map((offerItem: any) => {
    const [itemType, token, identifierOrCriteria, amount] = offerItem
    return {
      itemType,
      token: helper.checkSum(token),
      identifierOrCriteria: helper.bigNumberToNumber(identifierOrCriteria),
      startAmount: helper.bigNumberToNumber(amount),
      endAmount: helper.bigNumberToNumber(amount),
    }
  })

  const txConsideration: SeaportConsideration[] = consideration.map((considerationItem: any) => {
    const [itemType, token, identifierOrCriteria, amount, recipient] = considerationItem
    return {
      itemType,
      token: helper.checkSum(token),
      identifierOrCriteria: helper.bigNumberToNumber(identifierOrCriteria),
      startAmount: helper.bigNumberToNumber(amount),
      endAmount: helper.bigNumberToNumber(amount),
      recipient: helper.checkSum(recipient),
    }
  })

  return  { offer: txOffer, consideration: txConsideration }
}

export const txX2Y2ProtocolDataParser = (protocolData: any): TxX2Y2ProtocolData => {
  const {
    data,
    amount,
    intent,
    currency,
    deadline,
    orderSalt,
    settleSalt,
    delegateType } = protocolData
  return {
    data,
    currency,
    amount: amount? amount.hex ? String(helper.bigNumberToNumber(amount.hex))
      : String(helper.bigNumberToNumber(amount))
      : null,
    intent: intent && intent.hex ? String(helper.bigNumberToNumber(intent.hex))
      : null,
    delegateType: delegateType && delegateType.hex
      ? String(helper.bigNumberToNumber(delegateType.hex))
      : null,
    orderSalt:  orderSalt && orderSalt.hex ? String(helper.bigNumberToNumber(orderSalt.hex))
      : null,
    settleSalt:  settleSalt && settleSalt.hex ? String(helper.bigNumberToNumber(settleSalt.hex))
      : null,
    deadline:  deadline && deadline.hex ? String(helper.bigNumberToNumber(deadline.hex))
      : null,
  }
}

/**
 * transactionEntityBuilder
 * @param txType
 * @param txHash
 * @param chainId
 * @param contract
 * @param tokenId
 */

export const txEntityBuilder = async (
  txType: defs.ActivityType,
  txHash: string,
  blockNumber: string,
  chainId: string,
  contract: string,
  tokenId: string,
  maker: string,
  taker: string,
  exchange: defs.ExchangeType,
  protocol: defs.ProtocolType,
  protocolData: any,
  eventType: string,
):  Promise<Partial<entity.TxTransaction>> => {
  const checksumContract: string = helper.checkSum(contract)
  const tokenIdHex: string = helper.bigNumberToHex(tokenId)
  const nftIds: string[] = [`ethereum/${checksumContract}/${tokenIdHex}`]
  const timestampFromSource: number = (new Date().getTime())/1000
  const expirationFromSource = null

  const activity: entity.TxActivity = await activityBuilder(
    txType,
    txHash,
    maker,
    chainId,
    nftIds,
    checksumContract,
    timestampFromSource,
    expirationFromSource,
  )

  let txProtocolData: TxProtocolData = protocolData

  if (protocol === defs.ProtocolType.Seaport) {
    txProtocolData =  txSeaportProcotolDataParser(protocolData)
  } else if (protocol === defs.ProtocolType.X2Y2) {
    txProtocolData = txX2Y2ProtocolDataParser(protocolData)
  }
  return {
    id: txHash,
    activity,
    exchange,
    transactionType: txType,
    protocol,
    protocolData: txProtocolData,
    transactionHash: txHash,
    blockNumber,
    nftContractAddress: checksumContract,
    nftContractTokenId: tokenIdHex,
    eventType,
    maker: helper.checkSum(maker),
    taker: helper.checkSum(taker),
    chainId,
  }
}

/**
 * cancelEntityBuilder
 * @param txType
 * @param txHash
 * @param chainId
 * @param contract
 * @param nftIds
 * @param maker
 * @param exchange
 * @param orderType
 * @param orderHash
 */

export const cancelEntityBuilder = async (
  txType: defs.ActivityType,
  txHash: string,
  blockNumber: string,
  chainId: string,
  contract: string,
  nftIds: string[],
  maker: string,
  exchange: defs.ExchangeType,
  orderType: defs.CancelActivityType,
  orderHash: string,
):  Promise<Partial<entity.TxCancel>> => {
  const checksumContract: string = helper.checkSum(contract)
  const timestampFromSource: number = (new Date().getTime())/1000
  const expirationFromSource = null

  const activity: entity.TxActivity = await activityBuilder(
    txType,
    txHash,
    maker,
    chainId,
    nftIds,
    checksumContract,
    timestampFromSource,
    expirationFromSource,
  )

  return {
    id: txHash,
    activity,
    exchange,
    foreignType: orderType,
    foreignKeyId: orderHash,
    transactionHash: txHash,
    blockNumber,
    chainId,
  }
}
