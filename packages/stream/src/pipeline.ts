import { _logger, db, defs, entity, helper } from '@nftcom/shared'
import { BaseStreamMessage, EventType } from '@opensea/stream-js'

import { Chain, DistinctContract, OSChainTypes, OSEventPayload, OSListingEventPayload, OSOfferEventPayload } from './interface'
import { cache, CacheKeys }from './service/cache'
import { client, retrieveSlugsForContracts } from './service/opensea'

const logger = _logger.Factory(_logger.Context.Opensea)
export const allowedEvents: EventType[] = [
  EventType.ITEM_LISTED,
  EventType.ITEM_RECEIVED_OFFER,
  EventType.ITEM_RECEIVED_BID,
]

const repositories = db.newRepositories()
// fetch all nfts
export const fetchAllNFTs = (): Promise<DistinctContract[]> => {
  logger.log('----initiating fetch----')
  return repositories.nft.findDistinctContracts()
}

// map contracts to slugs - heavy lifting
export const mapContractsToSlugs = async (contracts: DistinctContract[]): Promise<string[]> => {
  logger.log('----mapping contracts to slugs----')
  const noSlugContracts: string[] = []
  const slugQueryParams: string[] = []
  const cachedMembers: string[] = await cache.smembers(`${CacheKeys.SLUG}`)
  const checksumContracts: string[] = contracts.map(
    (contract: DistinctContract) => helper.checkSum(contract?.nft_contract),
  )
  // caching strategy
  for (const contract of checksumContracts) {
    const existingKey: string[] = cachedMembers.filter(
      (cachedMember: string) => cachedMember.includes(contract),
    )
    const keyExists = Boolean(
      existingKey?.length && existingKey?.[0]?.split(':')?.[0] === contract,
    )
    if(!keyExists) {
      const isValidContractAddress: string = helper.checkSum(contract)
      noSlugContracts.push(isValidContractAddress)
    }
  }

  const slugsToRemove: string[] = cachedMembers.filter((cachedMember: string) => !checksumContracts.includes(cachedMember.split(':')?.[0]))
  if (slugsToRemove.length) {
    await cache.srem(`${CacheKeys.SLUG}`, ...slugsToRemove)
  }

  for (const contract of noSlugContracts) {
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
  const timestampFromSource = new Date(seaportEventPayload.event_timestamp)
  const expirationFromSource = new Date(seaportEventPayload.expiration_date)
      
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
    protocolData: {},
    exchange: defs.ExchangeType.OpenSea,
    makerAddress: seaportEventPayload.maker?.address ?
      helper.checkSum(seaportEventPayload.maker?.address)
      : null,
    takerAddress: seaportEventPayload.taker?.address ?
      helper.checkSum(seaportEventPayload.taker?.address)
      : null,
  }
}

// initiate all sockets
const initializeStreamsForAllSlugs = (): void => {
  logger.log('----initiating streams----')
  
  client.onEvents('*',
    [
      EventType.ITEM_LISTED,
      EventType.ITEM_RECEIVED_OFFER,
      // EventType.ITEM_RECEIVED_BID,
    ],
    async (event: BaseStreamMessage<unknown>) => {
      const eventType: EventType = event.event_type as EventType
      try {
        if (allowedEvents.includes(eventType)) {
          const eventPayload: OSEventPayload = event.payload as OSEventPayload
          const chain: Chain = eventPayload.item.chain
          if (chain.name === OSChainTypes.ETHEREUM) {
            const nftId: string = eventPayload.item.nft_id
                    
            let nft: entity.NFT
            //logger.log('nftId', nftId)
            if (nftId) {
              const chainId: string = process.env.CHAIN_ID || '4'
              const [network, contract, token] = nftId.split('/')
              if (contract && token) {
                try {
                  nft = await repositories.nft.findOne({
                    where: {
                      contract: helper.checkSum(contract),
                      tokenId: helper.bigNumberToHex(token),
                      chainId,
                    },
                  })
                } catch (err) {
                  logger.log('nft err', err)
                }
                    
                if (nft) {
                  logger.log('nftId', nft.id, network)
                  const orderHash: string = eventPayload.order_hash
                  let order: entity.TxOrder
                  if (orderHash) {
                    try {
                      order = await repositories.txOrder.findOne({
                        relations: ['activity'],
                        where: {
                          id: orderHash,
                        },
                      })
                    } catch (err) {
                      logger.log('order err', err)
                    }
                                                                
                    if (!order) {
                      try {
                        const newOrder: Partial<entity.TxOrder> = await orderEntityBuilder(
                          eventType,
                          eventPayload,
                          chainId,
                        )

                        await repositories.txOrder.save(newOrder)
                        logger.log(`order with orderHash: ${orderHash} for ${nftId} is saved successfully`)
                                            
                        // force refresh to store protocol data
                        const nftCacheId = `${helper.checkSum(contract)}:${helper.bigNumberToHex(token)}:force`
                        cache.zadd(`${CacheKeys.REFRESH_NFT_ORDERS_EXT}_${chainId}`, 'INCR', 1, nftCacheId)
                      } catch (err) {
                        logger.log('Save order', JSON.stringify(err))
                      }
                    }
                  }
                }
              }
            }  else {
              logger.log('nftId undefined', nftId)
              logger.log('event type', eventType)
              logger.log('event payload', eventPayload)
            }
          }
        }
      } catch (err) {
        logger.log('Err:', JSON.stringify(err))
      }
    })
}

export const initiateStreaming = async (): Promise<void> => {
  logger.debug('initiate streaming')
  return initializeStreamsForAllSlugs()
}
