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
  parsedFile['DB_HOST'] = infraOutput.dbHost
  parsedFile['DB_PASSWORD'] = process.env.DB_PASSWORD || ''
  parsedFile['DB_PORT'] = process.env.DB_PORT || ''
  parsedFile['DB_USE_SSL'] = 'true'
  parsedFile['REDIS_HOST'] = infraOutput.redisHost
  parsedFile['REDIS_PORT'] = parsedFile['DB_REDIS'] = process.env.REDIS_PORT || ''
  parsedFile['OPENSEA_API_B_KEY'] = process.env.OPENSEA_B_API_KEY || parsedFile['OPENSEA_API_B_KEY']
  parsedFile['LOOKSRARE_API_KEY'] = process.env.LOOKSRARE_API_KEY || parsedFile['LOOKSRARE_API_KEY']

  console.log(JSON.stringify(parsedFile))

  const targetFile = upath.joinSafe(env.workDir, '.env')
  fs.writeFileSync(targetFile, envfile.stringify(parsedFile))
}