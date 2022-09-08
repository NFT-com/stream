import { ec2 as awsEC2 } from '@pulumi/aws'
import { ec2 } from '@pulumi/awsx'
import * as pulumi from '@pulumi/pulumi'
import { getResourceName, isNotEmpty } from '../helper'

export type SGOutput = {
  web: awsEC2.SecurityGroup
}

const buildIngressRule = (
  port: number,
  protocol = 'tcp',
  sourceSecurityGroupId?: pulumi.Output<string>[],
): any => {
  const rule = {
    protocol,
    fromPort: port,
    toPort: port,
  }
  if (isNotEmpty(sourceSecurityGroupId)) {
    return {
      ...rule,
      securityGroups: sourceSecurityGroupId,
    }
  }

  return {
    ...rule,
    cidrBlocks: new ec2.AnyIPv4Location().cidrBlocks,
    ipv6CidrBlocks: new ec2.AnyIPv6Location().ipv6CidrBlocks,
  }
}

const buildEgressRule = (
  port: number,
  protocol = 'tcp',
): any => ({
  protocol,
  fromPort: port,
  toPort: port,
  cidrBlocks: new ec2.AnyIPv4Location().cidrBlocks,
})

export const createSecurityGroups = (
  config: pulumi.Config, 
  vpc: string
  ): SGOutput => {
  const resourceName = getResourceName('st-sg')
  const web = new awsEC2.SecurityGroup(resourceName, {
    description: 'Allow traffic from/to stream api',
    name: resourceName,
    vpcId: vpc,
    ingress: [
      buildIngressRule(443),
      buildIngressRule(80),
      buildIngressRule(22),
      buildIngressRule(8083),
      buildIngressRule(8084),
      buildIngressRule(8080)
    ],
    egress: [
      buildEgressRule(0, '-1'),
    ],
  })

  return {
    web,
  }
}
