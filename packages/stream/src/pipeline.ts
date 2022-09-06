import { BaseStreamMessage, EventType } from '@opensea/stream-js'
import { db, defs, entity, helper, _logger } from '@nftcom/shared'
import { client, retrieveSlugsForContracts } from './opensea'
import { cache, CacheKeys }from './cache'
import { Chain, DistinctContract, OSChainTypes, OSEventPayload, OSListingEventPayload, OSOfferEventPayload } from './interfaces'

const logger = _logger.Factory(_logger.Context.Opensea)
export const allowedEvents: EventType[] = [ EventType.ITEM_LISTED, EventType.ITEM_RECEIVED_OFFER, EventType.ITEM_RECEIVED_BID ]

const repositories = db.newRepositories()
// fetch all nfts
export const fetchAllNFTs = (): Promise<DistinctContract[]> => {
    logger.log('----initiating fetch----')
    return repositories.nft.findDistinctContracts()
}

// map contracts to slugs - heavy lifting
export const mapContractsToSlugs = async (contracts: DistinctContract[]): Promise<string[]> => {
    logger.log('----mapping contracts to slugs----')
    let noSlugContracts: string[] = []
    let slugQueryParams: string[] = []
    const cachedMembers: string[] = await cache.smembers(`${CacheKeys.SLUG}`)
    const checksumContracts: string[] = contracts.map((contract: DistinctContract) => helper.checkSum(contract?.nft_contract))
    // caching strategy
    for (let contract of checksumContracts) {
        let existingKey: string[] = cachedMembers.filter((cachedMember: string) => cachedMember.includes(contract))
        const keyExists: boolean = Boolean(existingKey?.length && existingKey?.[0]?.split(':')?.[0] === contract)
        if(!keyExists) {
            let isValidContractAddress: string = helper.checkSum(contract)
            noSlugContracts.push(isValidContractAddress)
        } 
    }

    const slugsToRemove: string[] = cachedMembers.filter((cachedMember: string) => !checksumContracts.includes(cachedMember.split(':')?.[0]))
    if (slugsToRemove.length) {
        await cache.srem(`${CacheKeys.SLUG}`, ...slugsToRemove)  
    }

    for (let contract of noSlugContracts) {
        slugQueryParams.push(contract)
    }
    // call opensea for slugs
    return retrieveSlugsForContracts(slugQueryParams)
}

/**
 * orderActivityBuilder 
 * @param orderType
 * @param orderHash
 * @param walletId
 * @param chainId
 * @param contract
 * @param timestampFromSource
 * @param expirationFromSource
 */
 const orderActivityBuilder = async (
    orderType: defs.ActivityType,
    orderHash: string,
    walletAddress: string,
    chainId: string,
    nftIds: string[],
    contract: string,
    timestampFromSource: Date,
    expirationFromSource: Date,
  ): Promise<entity.TxActivity> => {
    let activity: entity.TxActivity
    if (orderHash) {
      activity = await repositories.txActivity.findOne({ where: { activityTypeId: orderHash } })
      if (activity) {
        activity.updatedAt = new Date()
        // in case contract is not present for default contracts
        activity.nftContract = helper.checkSum(contract)
        return activity
      }
    }
  
    // new activity
    activity = new entity.TxActivity()
    activity.activityType = orderType
    activity.activityTypeId = orderHash
    activity.read = false
    activity.timestamp = new Date(timestampFromSource) // convert to ms
    activity.expiration = new Date(expirationFromSource) // conver to ms
    activity.walletAddress = helper.checkSum(walletAddress)
    activity.chainId = chainId
    activity.nftContract = helper.checkSum(contract)
    activity.nftId = [...nftIds]
  
    return activity
}

/**
 * seaportOrderBuilder 
 * @param order
 */
 const seaportOrderBuilder = (
    seaportEventPayload: OSListingEventPayload | OSOfferEventPayload ,
  ): Partial<entity.TxOrder> => {
    return {
      exchange: defs.ExchangeType.OpenSea,
      makerAddress: seaportEventPayload.maker?.address ? helper.checkSum(seaportEventPayload.maker?.address): null,
      takerAddress: seaportEventPayload.taker?.address ? helper.checkSum(seaportEventPayload.taker?.address): null,
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
    eventType: EventType,
    seaportEventPayload: OSListingEventPayload | OSOfferEventPayload,
    chainId: string
  ):  Promise<Partial<entity.TxOrder>> => {

    if (!allowedEvents.includes(eventType)) {
        return {}
    }
    let orderHash: string,
      walletAddress: string,
      checksumContract,
      nftIds: string[],
      nftIdSplit: string[],
      orderType: defs.ActivityType,
      timestampFromSource: Date,
      expirationFromSource: Date
  
      orderHash = seaportEventPayload.order_hash
      walletAddress = helper.checkSum(seaportEventPayload.maker.address)
      nftIdSplit = seaportEventPayload.item.nftId.split('/')
      checksumContract = helper.checkSum(nftIdSplit?.[1])
      nftIds = [ `${nftIdSplit?.[0]}/${checksumContract}/${helper.bigNumberToHex(nftIdSplit?.[2])}`]
      timestampFromSource = seaportEventPayload.event_timestamp
      expirationFromSource = seaportEventPayload.expiration_date

      
      if (eventType === EventType.ITEM_LISTED) {
          orderType = defs.ActivityType.Listing
      } else {
          orderType = defs.ActivityType.Bid
      }
    
    
  
    const activity: entity.TxActivity = await orderActivityBuilder(
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
      exchange: defs.ExchangeType.OpenSea,
      makerAddress: seaportEventPayload.maker?.address ? helper.checkSum(seaportEventPayload.maker?.address): null,
      takerAddress: seaportEventPayload.taker?.address ? helper.checkSum(seaportEventPayload.taker?.address): null,
    }
}

// initiate all sockets
const initializeStreamsForAllSlugs = () => {
    logger.log('----initiating streams----')
  
    client.onEvents('*', 
    [
        //EventType.ITEM_LISTED,
        EventType.ITEM_RECEIVED_OFFER,
        EventType.ITEM_RECEIVED_BID
    ], 
    async (event: BaseStreamMessage<unknown>) => {
        const eventType: EventType = event.event_type as EventType
        if (allowedEvents.includes(eventType)) {
            const eventPayload: OSEventPayload = event.payload as OSEventPayload
            const chain: Chain = eventPayload.item.chain
            if (chain.name === OSChainTypes.ETHEREUM) {
                const nftId: string = eventPayload.item.nftId
                if (nftId) {
                    const chainId: string = process.env.CHAIN_ID || '4'
                    const [ network, contract, token ] = nftId.split('/')
                    if (contract && token) {
                        const nft: entity.NFT = await repositories.nft.findOne({
                            where: {
                                contract: helper.checkSum(contract),
                                tokenId: helper.bigNumberToHex(token),
                                chainId
                            }
                        })

                        if (nft) {
                            const orderHash: string = eventPayload.order_hash
                            if (orderHash) {
                                const order: entity.TxOrder = await repositories.txOrder.findOne({
                                    relations: ['activity'],
                                    where: {
                                        id: orderHash
                                    }
                                })

                                if (!order) {
                                    const newOrder: Partial<entity.TxOrder> = await orderEntityBuilder(
                                        eventType,
                                        eventPayload,
                                        chainId
                                    )

                                    await repositories.txOrder.save(newOrder)
                                }
                            }
                        }
                    }
                    
                }
            }
        }
    })
}

export const initiateStreaming = async () => {
    logger.debug('initiate streaming')
    return initializeStreamsForAllSlugs()
}

