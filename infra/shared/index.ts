import * as upath from 'upath'
import { deployInfra, pulumiOutToValue, getStage } from '../helper'
import { createRepositories } from './ecr'
import { createSecurityGroups } from './security-group'
import * as pulumi from '@pulumi/pulumi';

const pulumiProgram = async (): Promise<Record<string, any> | void> => {
  const config = new pulumi.Config()
  const stage = getStage()
  const sharedStack = new pulumi.StackReference(`${stage}.indexer.shared.us-east-1`);
  const vpc = sharedStack.getOutput('vpcId') 
  const subnets =  sharedStack.getOutput('publicSubnetIds') 
  const vpcVal: string = await pulumiOutToValue(vpc) 
  const subnetVal: string[] = await pulumiOutToValue(subnets)

  const sgs = createSecurityGroups(config, vpcVal) //hardcode test
  const { stream } = createRepositories()

  return {
    streamECRRepo: stream.name,
    publicSubnetIds: subnetVal,
    vpcId: vpcVal,
    webSGId: sgs.web.id,
  }
}

export const createSharedInfra = (
  preview?: boolean,
): Promise<pulumi.automation.OutputMap> => {
  const stackName = `${process.env.STAGE}.stream.shared.${process.env.AWS_REGION}`
  const workDir = upath.joinSafe(__dirname, 'stack')
  return deployInfra(stackName, workDir, pulumiProgram, preview)
}
