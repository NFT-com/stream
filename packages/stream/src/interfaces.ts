import { EventType } from '@opensea/stream-js'

export interface DistinctContract {
  nft_contract: string
}

export interface Slug {
  contract: string
  slug: string
}

export interface Collection {
  slug: string
}

export interface Chain {
  name: string
}
export interface Item {
  chain: Chain
  metadata: any
  nft_id: string
  permalink: string
}

export interface Maker {
  address: string
}

export interface Taker {
  address: string
}

export interface PaymentToken {
  address: string
  decimals: number
  eth_price: string
  name: string
  symbol: string
  usd_price: string
}

export interface OSListingEventPayload {
  event_timestamp: string
  collection: Collection
  item: Item
  base_price: string
  expiration_date: string
  is_private: boolean
  listing_date: string
  listing_type: string
  maker: Maker
  order_hash: string
  payment_token: PaymentToken
  quantity: number
  taker: Taker | null
}

export interface OSOfferEventPayload {
  event_timestamp: string
  collection: Collection
  item: Item
  base_price: string
  created_date: string
  expiration_date: string
  maker: Maker
  order_hash: string
  payment_token: PaymentToken
  quantity: number
  taker: Taker | null
}

export type OSEventPayload = OSListingEventPayload | OSOfferEventPayload

export interface OSEvent {
  event_type: EventType
  sent_at: string
  payload: OSEventPayload
}

export enum OSChainTypes {
  ETHEREUM = 'ethereum',
  POLYGON = 'polygon',
  SOLANA = 'solana'
}

// Seaport Interfaces
export interface SeaportOffer {
  itemType: number
  token: string
  identifierOrCriteria: string
  startAmount: string
  endAmount: string
  
}

export interface SeaportConsideration extends SeaportOffer {
  recipient: string
}

export interface TxSeaportProtocolData {
  offer: SeaportOffer[]
  consideration: SeaportConsideration[]
}

export interface TxLooksrareProtocolData {
  taker: string
  maker: string
  strategy: string
  currency: string
  collection: string
}