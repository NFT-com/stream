/* eslint-disable @typescript-eslint/no-unused-vars */
import { BigNumber } from 'ethers'
import { Client } from 'pg'
import { EventEmitter } from 'stream'

import { _logger, db, helper } from '@nftcom/shared'

import { cache, CacheKeys } from '../service/cache'
import { getLatestBlockNumber } from '../utils'
import { atomicOwnershipUpdate } from './ownership'

const repositories = db.newRepositories()
const connectionString = 'postgresql://app:nftcom1234@sf-substreams-instance-1.clmsk3iud7e0.us-east-1.rds.amazonaws.com:5432/app'
const logger = _logger.Factory('STREAMINGFAST')
const client = new Client({ connectionString })
const nftDoesNotExist = new EventEmitter()
const blockRange = 200                    // 200 blocks padding for internal of latest block numbers
const REMOVE_SPAM_FILTER = true           // filter out spam transfers
const ONLY_OFFICIAL_FILTER = false        // only listen to official contracts
const ONLY_EXISTING_NFT_FILTER = true     // only listen to existing NFTs

let latestBlockNumber: number = null
let interval: NodeJS.Timeout = null

const handleFilter = async (contractAddress: string, tokenId: string): Promise<boolean> => {
  if (ONLY_OFFICIAL_FILTER) {
    const collection = await repositories.collection.findOne({
      where: { contract: helper.checkSum(contractAddress) },
    })
    if (!collection?.isOfficial) return false
  }

  if (REMOVE_SPAM_FILTER) {
    if (await cache.sismember(
      CacheKeys.SPAM_COLLECTIONS, helper.checkSum(contractAddress),
    )) return false
  }

  if (ONLY_EXISTING_NFT_FILTER) {
    const nftExists = await repositories.nft.exists({
      contract: helper.checkSum(contractAddress),
      tokenId,
    })
    if (!nftExists) {
      nftDoesNotExist.emit('nft', { contractAddress, tokenId })
      return nftExists
    }
  }

  return true
}

nftDoesNotExist.on('nft', ({ contractAddress, tokenId }) => {
  logger.warn({ contractAddress, tokenId }, 'NFT does not exist')
})

const ensureHexPrefix = (value: string): string => {
  return value.startsWith('0x') ? value : `0x${value}`
}

const handleNotification = async (msg: any): Promise<void> => {
  // if latestBlockNumber is not set, call getLatestBlockNumber and store the result in latestBlockNumber
  if (latestBlockNumber === null) {
    latestBlockNumber = await getLatestBlockNumber()
  }

  const [schema, blockNumber, tokenId, contractAddress, quantity, fromAddress, toAddress, txHash, timestamp] = msg.payload.split('|')
  const blockDifference = Math.abs(latestBlockNumber - Number(blockNumber))
  const hexTokenId = ensureHexPrefix(tokenId)
  const hexContractAddress = ensureHexPrefix(contractAddress)
  const hexFromAddress = ensureHexPrefix(fromAddress)
  const hexToAddress = ensureHexPrefix(toAddress)
  const hexTxHash = ensureHexPrefix(txHash)

  if (blockDifference <= blockRange &&
    await handleFilter(contractAddress, hexTokenId)
  ) {
    if (fromAddress === '0x0000000000000000000000000000000000000000') {
      logger.info(`streamingFast: [MINTED]: ${schema}/${hexContractAddress}/${hexTokenId} to ${hexToAddress}, ${Number(quantity) > 1 ? `quantity=${quantity}, ` : ''}, https://etherscan.io/tx/${hexTxHash}`)
    } else if (hexToAddress === '0x0000000000000000000000000000000000000000') {
      logger.info(`streamingFast: [BURNED]: ${schema}/${hexContractAddress}/${hexTokenId} from ${hexFromAddress}, ${Number(quantity) > 1 ? `quantity=${quantity}, ` : ''}, https://etherscan.io/tx/${hexTxHash}`)
    } else {
      const start = new Date().getTime()
      await atomicOwnershipUpdate(
        hexContractAddress,
        hexTokenId,
        hexFromAddress,
        hexToAddress,
        '1', // mainnet ETH
      )
      logger.info(`streamingFast (took ${new Date().getTime() - start} ms): [TRANSFERRED]: ${schema}/${hexContractAddress}/${hexTokenId} from ${hexFromAddress} to ${hexToAddress}, ${Number(quantity) > 1 ? `quantity=${quantity}, ` : ''}, https://etherscan.io/tx/${hexTxHash}`)
    }
  } else {
    logger.warn({ schema, blockNumber, hexTokenId, hexContractAddress, quantity, hexFromAddress, hexToAddress, txHash, timestamp }, 'Filtered Transfer')
  }
}

export function startStreamingFast(): void {
  logger.info('---------> ⚡️ starting streaming fast listener, waiting for new transfers...')
  if (interval || client.listeners('notification').length) {
    logger.warn('StreamingFast is already running')
    return
  }

  client.connect()

  client.query('LISTEN transfers')

  // Call getLatestBlockNumber every 5 minutes and store the result in latestBlockNumber
  interval = setInterval(async () => {
    latestBlockNumber = await getLatestBlockNumber()
  }, 5 * 60 * 1000)

  logger.info(`the latest block number is ${latestBlockNumber}`)

  client.on('notification', handleNotification)
}

export function stopStreamingFast(): void {
  logger.info('---------> 🛑 stopping streaming fast listener')
  if (!interval || !client.listeners('notification').length) {
    logger.warn('StreamingFast is not running')
    return
  }

  clearInterval(interval)
  interval = null

  client.off('notification', handleNotification)
  client.end()
}