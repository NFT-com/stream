import * as upath from 'upath'

import * as pulumi from '@pulumi/pulumi'

import { deployInfra, pulumiOutToValue } from '../helper'
import { createEcsService } from './ecs'

const getSharedStackOutputs = async (): Promise<any> => {
  const sharedStack = new pulumi.StackReference(`${process.env.STAGE}.shared.${process.env.AWS_REGION}`)
  const vpc = sharedStack.getOutput('vpcId') 
  const subnets =  sharedStack.getOutput('publicSubnetIds') 
  const vpcVal: string = await pulumiOutToValue(vpc) 
  const subnetVal: string[] = await pulumiOutToValue(subnets)
  return sharedStack.outputs
}

const pulumiProgram = async (): Promise<Record<string, any> | void> => {
  const config = new pulumi.Config()
  const sharedStackOutputs = await getSharedStackOutputs()
  createEcsService(config, sharedStackOutputs)
}

export const createStreamCluster = (
  preview?: boolean,
): Promise<pulumi.automation.OutputMap> => {
  const stackName = `${process.env.STAGE}.stream.${process.env.AWS_REGION}`
  const workDir = upath.joinSafe(__dirname, 'stack')
  return deployInfra(stackName, workDir, pulumiProgram, preview)
}