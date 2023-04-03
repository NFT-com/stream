import { _logger, db, entity, helper } from '@nftcom/shared'
import { BaseStreamMessage, EventType } from '@opensea/stream-js'

import { Chain, DistinctContract, OSChainTypes, OSEventPayload } from './interface'
import { cache, CacheKeys }from './service/cache'
import { client, retrieveSlugsForContracts } from './service/opensea'
import { streamOrderEntityBuilder } from './utils/builder/streamOrderBuilder'

const logger = _logger.Factory(_logger.Context.Opensea)
export const allowedEvents: EventType[] = [
  EventType.ITEM_LISTED,
  EventType.ITEM_RECEIVED_OFFER,
  EventType.ITEM_RECEIVED_BID,
]

const repositories = db.newRepositories()
// fetch all nfts -
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
 * orderEntityBuilder 
 * @param protocol
 * @param orderType
 * @param order
 * @param chainId
 * @param contract
 */

// initiate sockets
const initializeStreamsForAllSlugs = (): void => {
  try {
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
                    logger.error(`nft err: ${err}`)
                  }
                      
                  if (nft) {
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
                        logger.error(`order err: ${err}`)
                      }
                                                                  
                      if (!order) {
                        try {
                          logger.debug(`[seaport-streams] order with orderHash: ${orderHash} for ${nftId}: eventPayload: ${JSON.stringify(eventPayload)}`)
                          const newOrder: Partial<entity.TxOrder> = await streamOrderEntityBuilder(
                            eventType,
                            eventPayload,
                            chainId,
                          )

                          await repositories.txOrder.save(newOrder)
                          logger.debug(`order with orderHash: ${orderHash} for ${nftId} is saved successfully on ${network} network, newOrder: ${JSON.stringify(newOrder)}`)
                        } catch (err) {
                          // TODO: error handling
                        }
                      }
                    }
                  }
                }
              }  else {
                logger.error(`nftId undefined: ${nftId}`)
                logger.log(`event type: ${eventType}`)
                logger.log(`event payload: ${eventPayload}`)
              }
            }
          }
        } catch (err) {
          logger.error(`Err: ${JSON.stringify(err)}`)
        }
      })
  } catch (err) {
    logger.error(err, 'error in initializeStreamsForAllSlugs')
  }
}

export const initiateStreaming = async (): Promise<void> => {
  try {
    logger.log('initiate streaming')
    return initializeStreamsForAllSlugs()
  } catch (err) {
    logger.error(err, 'error in initiateStreaming')
  }
}
