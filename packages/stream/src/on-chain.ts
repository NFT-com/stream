import { _logger } from 'nftcom-backend/shared'

const logger = _logger.Factory(_logger.Context.WebsocketProvider)
// on-chain events websocket
export const onChainProvider = (): Promise<void> => {
  logger.log('---Connecting to On-Chain---')
  return Promise.resolve()
}