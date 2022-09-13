import * as upath from 'upath'

import * as pulumi from '@pulumi/pulumi'

import { deployInfra, getStage,pulumiOutToValue } from '../helper'
import { createRepositories } from './ecr'
import { createSecurityGroups } from './security-group'

const pulumiProgram = async (): Promise<Record<string, any> | void> => {
  const config = new pulumi.Config()
  const stage = getStage()
  const sharedStack = new pulumi.StackReference(`${stage}.shared.us-east-1`)
  const dbHost = sharedStack.getOutput('dbHost')
  const redisHost = sharedStack.getOutput('redisHost')
  const vpc = sharedStack.getOutput('vpcId')
  const subnets =  sharedStack.getOutput('publicSubnetIds')
  const dbHostVal: string = await pulumiOutToValue(dbHost)
  const redisHostVal: string = await pulumiOutToValue(redisHost)
  const vpcVal: string = await pulumiOutToValue(vpc)
  const subnetVal: string[] = await pulumiOutToValue(subnets)

  const sgs = createSecurityGroups(config, vpcVal) //hardcode test
  const { stream } = createRepositories()
  return {
    dbHost: dbHostVal,
    redisHost: redisHostVal,
    streamECRRepo: stream.name,
    publicSubnetIds: subnetVal,
    vpcId: vpcVal,
    webSGId: sgs.web.id,
  }
}

export const createSharedInfra = (
  preview?: boolean,
): Promise<pulumi.automation.OutputMap> => {
  const stackName = `${process.env.STAGE}.st.shared.${process.env.AWS_REGION}`
  const workDir = upath.joinSafe(__dirname, 'stack')
  return deployInfra(stackName, workDir, pulumiProgram, preview)
}
