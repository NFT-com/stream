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
  parsedFile['DB_PORT'] = process.env.DB_PORT || ''
  parsedFile['DB_USE_SSL'] = 'true'
  parsedFile['REDIS_HOST'] = infraOutput.redisHost
  parsedFile['REDIS_PORT'] = parsedFile['DB_REDIS'] = process.env.REDIS_PORT || ''
  parsedFile['OPENSEA_B_API_KEY'] = process.env.OPENSEA_B_API_KEY || parsedFile['OPENSEA_B_API_KEY']
  parsedFile['LOOKSRARE_API_KEY'] = process.env.LOOKSRARE_API_KEY || parsedFile['LOOKSRARE_API_KEY']
  parsedFile['ALCHEMY_API_KEY'] = process.env.ALCHEMY_API_KEY || parsedFile['ALCHEMY_API_KEY']
  parsedFile['AUTH_ALLOWED_LIST'] = process.env.AUTH_ALLOWED_LIST || parsedFile['AUTH_ALLOWED_LIST']
  parsedFile['AUTH_MESSAGE'] = process.env.AUTH_MESSAGE || parsedFile['AUTH_MESSAGE']
  parsedFile['CHAIN_ID'] = process.env.CHAIN_ID || parsedFile['CHAIN_ID']

  console.log(JSON.stringify(parsedFile))

  const targetFile = upath.joinSafe(env.workDir, '.env')
  fs.writeFileSync(targetFile, envfile.stringify(parsedFile))
}