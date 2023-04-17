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
  protocol_data: {
    parameters: {
      offerer: string
      offer: SeaportOffer[]
      consideration: SeaportConsideration[]
      startTime: string
      endTime: string
      orderType: number
      zone: string
      zoneHash: string
      salt: string
      conduitKey: string
      totalOriginalConsiderationItems: number
      counter: number
    }
    signature: string
  }
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
  protocol_data: {
    parameters: {
      offerer: string
      offer: SeaportOffer[]
      consideration: SeaportConsideration[]
      startTime: string
      endTime: string
      orderType: number
      zone: string
      zoneHash: string
      salt: string
      conduitKey: string
      totalOriginalConsiderationItems: number
      counter: number
    }
    signature: string
  }
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

export interface TxLooksrareV2ProtocolData {
  taker: string
  maker: string
  strategyId: number
  currency: string
  collection: string
}

// interface TxX2Y2OrderItem {
//   price: [string]
//   data: string
// }

// interface TxX2Y2Fee {
//   percentage: string
//   to: string
// }

// interface TxX2Y2SettleDetail {
//   op: [string]
//   orderIdx: [string]
//   itemIdx: [string]
//   price: [string]
//   itemHash: string
//   executionDelegate: string
//   dataReplacement: string
//   bidIncentivePct: [string]
//   aucMinIncrementPct: [string]
//   aucIncDurationSecs: [string]
//   fees: [TxX2Y2Fee]
// }

export interface TxX2Y2ProtocolItem {
  type: string
  hex: string
}

export interface TxX2Y2ProtocolData {
  currency: string
  amount: string
  orderSalt: string
  settleSalt: string
  intent: string
  delegateType: string
  deadline: string
  data: string
}

export interface NFTAlchemyMedia {
  raw: string
  gateway: string
}

export interface NFTAlchemyMetadataAttribute {
  value: string
  trait_type: string
}

export interface NFTAlchemy {
  contract: {
    address: string
  }
  id: {
    tokenId: string
    tokenMetadata: {
      tokenType: string
    }
  }
  title: string
  description: string
  tokenUri: {
    raw: string
    gateway: string
  }
  media: NFTAlchemyMedia[]
  metadata: {
    name: string
    image: string
    attributes: NFTAlchemyMetadataAttribute[]
  }
  timeLastUpdated: string
  contractMetadata: {
    name: string
    symbol: string
    totalSupply: string
    tokenType: string
  }
}

export interface NftPortTraits {
  trait_type: string
  value: string
  display_type: string | null
  max_value: string | null
  trait_count: number
  order: string | null
}

export interface NFT_NftPort {
  chain: string
  contract_address: string
  token_id: string
  metadata_url: string | null
  metadata: {
    image_url: string
    name: string
    traits: NftPortTraits[]
  }
  file_url: string
  animation_url: string
  cached_file_url: string
  cached_animation_url: string
  creator_address: string
  updated_date: string
  owner: string
}

export interface MulticallResponse {
  success: boolean
  returnData: string
}