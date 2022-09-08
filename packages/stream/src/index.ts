import { db, _logger, fp } from 'nftcom-backend/shared'
import { dbConfig } from './config'
//import { startAndListen } from './jobs/jobs'
import { onChainProvider } from './on-chain'
import { client } from './opensea'
import { initiateStreaming } from './pipeline'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)

// error handler
const handleError = (err: Error): void => {
    logger.error('App Error', err)
    throw err
}

// initialize
export const verifyConfiguration = (): void => {
    logger.debug('Loading configurations...')
}

const bootstrap = (): Promise<void> => {
    verifyConfiguration()
    return db.connect(dbConfig)
      .then(onChainProvider)
      .then(client.connect)
      .then(initiateStreaming)
      //.then(startAndListen)
      .then(fp.pause(500))
}

bootstrap().catch(handleError)