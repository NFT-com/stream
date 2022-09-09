import { EventType } from "@opensea/stream-js";

export interface DistinctContract {
    nft_contract: string
}

export interface Slug {
    contract: string
    slug: string
}

export interface OSEvent {
    event_type: EventType
    sent_at: Date
    payload: OSEventPayload
}

export interface Collection {
    slug: string
}

export interface Chain {
    name: string
}

export interface Metadata {

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

export type OSEventPayload = OSListingEventPayload | OSOfferEventPayload

export interface OSListingEventPayload {
    event_timestamp: Date
    collection: Collection
    item: Item
    base_price: string
    expiration_date: Date
    is_private: Boolean
    listing_date: Date
    listing_type: string
    maker: Maker
    order_hash: string
    payment_token: PaymentToken
    quantity: number
    taker: Taker | null
}

export interface OSOfferEventPayload {
    event_timestamp: Date
    collection: Collection
    item: Item
    base_price: string
    created_date: Date
    expiration_date: Date
    maker: Maker
    order_hash: string
    payment_token: PaymentToken
    quantity: number
    taker: Taker | null
}

export enum OSChainTypes {
    ETHEREUM = 'ethereum',
    POLYGON = 'polygon',
    SOLANA = 'solana'
}