import { db, helper, _logger } from '@nftcom/shared'

const logger = _logger.Factory(_logger.Context.WebsocketProvider)
// on-chain events websocket
export const onChainProvider = (): Promise<void> => {
    return Promise.resolve()
}