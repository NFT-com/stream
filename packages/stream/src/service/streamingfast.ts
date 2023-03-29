/* eslint-disable @typescript-eslint/no-unused-vars */
import { Client } from 'pg'

import { _logger } from '@nftcom/shared'

import { getLatestBlockNumber } from '../utils'
import { atomicOwnershipUpdate } from './ownership'

const connectionString = 'postgresql://app:nftcom1234@sf-substreams-instance-1.clmsk3iud7e0.us-east-1.rds.amazonaws.com:5432/app'
const blockRange = 200 // 200 blocks padding for internal of latest block numbers
const logger = _logger.Factory('STREAMINGFAST')

const client = new Client({
  connectionString,
})

let interval: NodeJS.Timeout | null = null
let latestBlockNumber: number | null = null

interface PgNotification {
  payload: string
}

const handleNotification = async (msg: PgNotification): Promise<void> => {
  // if latestBlockNumber is not set, call getLatestBlockNumber and store the result in latestBlockNumber
  if (latestBlockNumber === null) latestBlockNumber = await getLatestBlockNumber()

  const [schema, blockNumber, tokenId, contractAddress, quantity, fromAddress, toAddress, txHash, timestamp] = msg.payload.split('|')

  const blockDifference = Math.abs(latestBlockNumber - Number(blockNumber))
  if (blockDifference <= blockRange) {
    if (fromAddress == '0000000000000000000000000000000000000000') {
      console.log(`[MINTED]: ${schema}/${contractAddress}/${tokenId} to ${toAddress}, ${Number(quantity) > 1 ? `quantity=${quantity}, ` : ''}`)
    } else if (toAddress == '0000000000000000000000000000000000000000') {
      console.log(`[BURNED]: ${schema}/${contractAddress}/${tokenId} from ${fromAddress}, ${Number(quantity) > 1 ? `quantity=${quantity}, ` : ''}`)
    } else {
      console.log(`[TRANSFERRED]: ${schema}/${contractAddress}/${tokenId} from ${fromAddress} to ${toAddress}, ${Number(quantity) > 1 ? `quantity=${quantity}, ` : ''}`)
    }
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
