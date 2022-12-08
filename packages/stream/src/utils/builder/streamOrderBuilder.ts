import { defs, entity, helper } from '@nftcom/shared'
import { EventType } from '@opensea/stream-js'

import { OSListingEventPayload, OSOfferEventPayload } from '../../interface'
import { allowedEvents } from '../../pipeline'
import { activityBuilder } from './orderBuilder'

export const streamOrderEntityBuilder = async (
  eventType: EventType,
  seaportEventPayload: OSListingEventPayload | OSOfferEventPayload,
  chainId: string,
):  Promise<Partial<entity.TxOrder>> => {
  if (!allowedEvents.includes(eventType)) {
    return {}
  }
  
  let orderType: defs.ActivityType
    
  const orderHash: string = seaportEventPayload.order_hash
  const walletAddress: string = helper.checkSum(seaportEventPayload.maker.address)
  const nftIdSplit: string[] = seaportEventPayload.item.nft_id.split('/')
  const checksumContract: string = helper.checkSum(nftIdSplit?.[1])
  const nftIds: string[] = [
    `${nftIdSplit?.[0]}/${checksumContract}/${helper.bigNumberToHex(nftIdSplit?.[2])}`,
  ]
  const timestampFromSource = Number(seaportEventPayload.protocol_data?.parameters?.startTime)
  const expirationFromSource = Number(seaportEventPayload.protocol_data?.parameters?.endTime)
        
  if (eventType === EventType.ITEM_LISTED) {
    orderType = defs.ActivityType.Listing
  } else {
    orderType = defs.ActivityType.Bid
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
    protocol: defs.ProtocolType.Seaport,
    protocolData: seaportEventPayload.protocol_data,
    zone: seaportEventPayload.protocol_data?.parameters?.zone,
    nonce: seaportEventPayload?.protocol_data?.parameters?.counter,
    exchange: defs.ExchangeType.OpenSea,
    makerAddress: seaportEventPayload.maker?.address ?
      helper.checkSum(seaportEventPayload.maker?.address)
      : null,
    takerAddress: seaportEventPayload.taker?.address ?
      helper.checkSum(seaportEventPayload.taker?.address)
      : null,
  }
}