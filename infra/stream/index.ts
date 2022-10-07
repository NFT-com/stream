import * as console from 'console'
import * as envfile from 'envfile'
import * as fs from 'fs'
import * as jyml from 'js-yaml'
import { omit } from 'lodash'
import * as process from 'process'
import * as upath from 'upath'

import * as pulumi from '@pulumi/pulumi'

import { deployInfra, getEnv, getSharedInfraOutput } from '../helper'
import { createEcsService } from './ecs'

const pulumiProgram = async (): Promise<Record<string, any> | void> => {
  const config = new pulumi.Config()
  const sharedStackOutputs = getSharedInfraOutput()
  createEcsService(config, sharedStackOutputs)
}

export const createStreamCluster = (
  preview?: boolean,
): Promise<pulumi.automation.OutputMap> => {
  const stackName = `${process.env.STAGE}.st.${process.env.AWS_REGION}`
  const workDir = upath.joinSafe(__dirname, 'stack')
  return deployInfra(stackName, workDir, pulumiProgram, preview)
}

export const updateStreamEnvFile = (): void => {
  console.log('Read shared infra output from file...')
  const infraOutput = getSharedInfraOutput()

  console.log('Read stack yaml file...')
  const ymlFileName = `Pulumi.${process.env.STAGE}.st.${process.env.AWS_REGION}.yaml`
  const ymlFile = upath.joinSafe(__dirname, 'stack', ymlFileName)
  const ymlDoc = jyml.load(fs.readFileSync(ymlFile).toString()) as { [key: string]: any }
  const stackConfig = ymlDoc.config as { [key: string]: string }

  console.log('Update server environment file...')
  const env = getEnv('stream', '.env.example')
  let { parsedFile } = env
  parsedFile = omit(parsedFile, 'PORT', 'DB_PORT', 'REDIS_PORT')
  parsedFile['NODE_ENV'] = stackConfig['nftcom:nodeEnv']
  parsedFile['DB_HOST'] = process.env.DB_HOST || ''
  parsedFile['DB_PASSWORD'] = process.env.DB_PASSWORD || ''
  parsedFile['DB_USE_SSL'] = 'true'
  parsedFile['REDIS_HOST'] = infraOutput.redisHost
  parsedFile['SUPPORTED_NETWORKS'] = process.env.SUPPORTED_NETWORKS || parsedFile['SUPPORTED_NETWORKS']
  parsedFile['LOG_LEVEL'] = stackConfig['nftcom:logLevel'] || parsedFile['LOG_LEVEL']
  parsedFile['AUTH_MESSAGE'] = process.env.AUTH_MESSAGE || parsedFile['AUTH_MESSAGE']
  parsedFile['SG_API_KEY'] = process.env.SG_API_KEY || parsedFile['SG_API_KEY']
  parsedFile['ASSET_BUCKET'] = process.env.ASSET_BUCKET || parsedFile['ASSET_BUCKET']
  parsedFile['ASSET_BUCKET_ROLE'] = process.env.ASSET_BUCKET_ROLE || parsedFile['ASSET_BUCKET_ROLE']
  parsedFile['ETH_GAS_STATION_API_KEY'] = process.env.ETH_GAS_STATION_API_KEY || parsedFile['ETH_GAS_STATION_API_KEY']
  parsedFile['TEAM_AUTH_TOKEN'] = process.env.TEAM_AUTH_TOKEN || parsedFile['TEAM_AUTH_TOKEN']
  parsedFile['MNEMONIC'] = process.env.MNEMONIC || parsedFile['MNEMONIC']
  parsedFile['MNEMONIC_RINKEBY'] = process.env.MNEMONIC_RINKEBY || parsedFile['MNEMONIC_RINKEBY']
  parsedFile['HCS_TOPIC_ID'] = process.env.HCS_TOPIC_ID || parsedFile['HCS_TOPIC_ID']
  parsedFile['HCS_ACCOUNT_ID'] = process.env.HCS_ACCOUNT_ID || parsedFile['HCS_ACCOUNT_ID']
  parsedFile['HCS_PRIVATE_KEY'] = process.env.HCS_PRIVATE_KEY || parsedFile['HCS_PRIVATE_KEY']
  parsedFile['PUBLIC_SALE_KEY'] = process.env.PUBLIC_SALE_KEY || parsedFile['PUBLIC_SALE_KEY']
  parsedFile['SHARED_MINT_SECRET'] = process.env.SHARED_MINT_SECRET || parsedFile['SHARED_MINT_SECRET']
  parsedFile['SERVER_CONFIG'] = process.env.SERVER_CONFIG || ''
  parsedFile['SENTRY_DSN'] = process.env.SENTRY_DSN || parsedFile['SENTRY_DSN']
  parsedFile['ZMOK_API_URL'] = process.env.ZMOK_API_URL || parsedFile['ZMOK_API_URL']
  parsedFile['UBIQUITY_API_KEY'] = process.env.UBIQUITY_API_KEY || parsedFile['UBIQUITY_API_KEY']
  parsedFile['CHAIN_ID'] = process.env.CHAIN_ID || parsedFile['CHAIN_ID']
  parsedFile['ALCHEMY_API_KEY'] = process.env.ALCHEMY_API_KEY || parsedFile['ALCHEMY_API_KEY']
  parsedFile['ALCHEMY_API_KEY_PREVIEWLINK'] = process.env.ALCHEMY_API_KEY_PREVIEWLINK || parsedFile['ALCHEMY_API_KEY_PREVIEWLINK']
  parsedFile['ALCHEMY_API_KEY_PREVIEWLINK_GOERLI'] = process.env.ALCHEMY_API_KEY_PREVIEWLINK_GOERLI || parsedFile['ALCHEMY_API_KEY_PREVIEWLINK_GOERLI']
  parsedFile['ALCHEMY_API_URL'] = process.env.ALCHEMY_API_URL || parsedFile['ALCHEMY_API_URL']
  parsedFile['ALCHEMY_API_URL_RINKEBY'] = process.env.ALCHEMY_API_URL_RINKEBY || parsedFile['ALCHEMY_API_URL_RINKEBY']
  parsedFile['ALCHEMY_API_URL_GOERLI'] = process.env.ALCHEMY_API_URL_GOERLI || parsedFile['ALCHEMY_API_URL_GOERLI']
  parsedFile['INFURA_API_KEY'] = process.env.INFURA_API_KEY || parsedFile['INFURA_API_KEY']
  parsedFile['TYPESENSE_HOST'] = process.env.TYPESENSE_HOST || parsedFile['TYPESENSE_HOST']
  parsedFile['TYPESENSE_API_KEY'] = process.env.TYPESENSE_API_KEY || parsedFile['TYPESENSE_API_KEY']
  parsedFile['MINTED_PROFILE_EVENTS_MAX_BLOCKS'] = process.env.MINTED_PROFILE_EVENTS_MAX_BLOCKS || parsedFile['MINTED_PROFILE_EVENTS_MAX_BLOCKS']
  parsedFile['PROFILE_NFTS_EXPIRE_DURATION'] = process.env.PROFILE_NFTS_EXPIRE_DURATION || parsedFile['PROFILE_NFTS_EXPIRE_DURATION']
  parsedFile['BULL_MAX_REPEAT_COUNT'] = process.env.BULL_MAX_REPEAT_COUNT || parsedFile['BULL_MAX_REPEAT_COUNT']
  parsedFile['OPENSEA_API_KEY'] = process.env.OPENSEA_API_KEY || parsedFile['OPENSEA_API_KEY']
  parsedFile['OPENSEA_ORDERS_API_KEY'] = process.env.OPENSEA_API_KEY || parsedFile['OPENSEA_ORDERS_API_KEY']
  parsedFile['LOOKSRARE_API_KEY'] = process.env.LOOKSRARE_API_KEY || parsedFile['LOOKSRARE_API_KEY']
  parsedFile['PROFILE_SCORE_EXPIRE_DURATION'] = process.env.PROFILE_SCORE_EXPIRE_DURATION || parsedFile['PROFILE_SCORE_EXPIRE_DURATION']
  parsedFile['NFT_EXTERNAL_ORDER_REFRESH_DURATION'] = process.env.NFT_EXTERNAL_ORDER_REFRESH_DURATION || parsedFile['NFT_EXTERNAL_ORDER_REFRESH_DURATION']
  parsedFile['TEST_DB_HOST'] = process.env.TEST_DB_HOST || parsedFile['TEST_DB_HOST']
  parsedFile['TEST_DB_DATABASE'] = process.env.TEST_DB_DATABASE || parsedFile['TEST_DB_DATABASE']
  parsedFile['TEST_DB_USERNAME'] = process.env.TEST_DB_USERNAME || parsedFile['TEST_DB_USERNAME']
  parsedFile['TEST_DB_PORT'] = process.env.TEST_DB_PORT || parsedFile['TEST_DB_PORT']
  parsedFile['TEST_DB_PASSWORD'] = process.env.TEST_DB_PASSWORD || parsedFile['TEST_DB_PASSWORD']
  parsedFile['TEST_DB_USE_SSL'] = process.env.TEST_DB_USE_SSL || parsedFile['TEST_DB_USE_SSL']
  parsedFile['ACTIVITY_ENDPOINTS_ENABLED'] = process.env.ACTIVITY_ENDPOINTS_ENABLED || parsedFile['ACTIVITY_ENDPOINTS_ENABLED']
  parsedFile['NFTPORT_KEY'] = process.env.NFTPORT_KEY || parsedFile['NFTPORT_KEY']
  parsedFile['REFRESH_NFT_DURATION'] = process.env.REFRESH_NFT_DURATION || parsedFile['REFRESH_NFT_DURATION']
  parsedFile['IPFS_WEB_GATEWAY'] = process.env.IPFS_WEB_GATEWAY || parsedFile['IPFS_WEB_GATEWAY']
  parsedFile['DEFAULT_TTL_MINS'] = process.env.DEFAULT_TTL_MINS || parsedFile['DEFAULT_TTL_MINS']
  parsedFile['MAX_NFT_BATCH_SIZE'] = process.env.MAX_NFT_BATCH_SIZE || parsedFile['MAX_NFT_BATCH_SIZE']
  parsedFile['NFT_CONCURRENCY_NUMBER'] = process.env.NFT_CONCURRENCY_NUMBER || parsedFile['NFT_CONCURRENCY_NUMBER']
  parsedFile['STREAM_PORT'] = process.env.STREAM_PORT || parsedFile['STREAM_PORT']
  parsedFile['AUTH_ALLOWED_LIST'] = process.env.AUTH_ALLOWED_LIST || parsedFile['AUTH_ALLOWED_LIST']

  console.log(JSON.stringify(parsedFile))

  const targetFile = upath.joinSafe(env.workDir, '.env')
  fs.writeFileSync(targetFile, envfile.stringify(parsedFile))
}