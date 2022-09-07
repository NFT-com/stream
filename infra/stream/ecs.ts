import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { SharedInfraOutput } from '../defs'
import { getResourceName, getTags } from '../helper'

const tags = {
  service: 'stream',
}

const attachLBListeners = (
  lb: aws.lb.LoadBalancer,
  tg: aws.lb.TargetGroup,
): void => {
  new aws.lb.Listener('listener_http_dev_stream_ecs', {
    defaultActions: [
      {
        order: 1,
        redirect: {
          port: '443',
          protocol: 'HTTPS',
          statusCode: 'HTTP_301',
        },
        type: 'redirect',
      },
    ],
    loadBalancerArn: lb.arn,
    port: 80,
    protocol: 'HTTP',
    tags: getTags(tags),
  })

  new aws.lb.Listener('listener_https_dev_stream_ecs', {
    certificateArn:
      'arn:aws:acm:us-east-1:016437323894:certificate/0c01a3a8-59c4-463a-87ec-5c487695f09e',
    defaultActions: [
      {
        targetGroupArn: tg.arn,
        type: 'forward',
      },
    ],
    loadBalancerArn: lb.arn,
    port: 443,
    protocol: 'HTTPS',
    sslPolicy: 'ELBSecurityPolicy-2016-08',
    tags: getTags(tags),
  })
}

const createEcsTargetGroup = (
  infraOutput: SharedInfraOutput,
): aws.lb.TargetGroup => {
  return new aws.lb.TargetGroup('tg_stream_ecs', {
    healthCheck: {
      interval: 15,
      matcher: '200-399',
      path: '/.well-known/apollo/server-health',
      timeout: 5,
      unhealthyThreshold: 5,
    },
    name: getResourceName('stream-ecs'),
    port: 8080,
    protocol: 'HTTP',
    protocolVersion: 'HTTP1',
    stickiness: {
      enabled: false,
      type: 'lb_cookie',
    },
    targetType: 'ip',
    vpcId: infraOutput.vpcId,
    tags: getTags(tags),
  })
}

const createEcsLoadBalancer = (
  infraOutput: SharedInfraOutput,
): aws.lb.LoadBalancer => {
  return new aws.lb.LoadBalancer('lb_stream_ecs', {
    ipAddressType: 'ipv4',
    name: getResourceName('stream-ecs'),
    securityGroups: [infraOutput.webSGId],
    subnets: infraOutput.publicSubnets,
    tags: getTags(tags),
  })
}

const createEcsCluster = (): aws.ecs.Cluster => {
  const cluster = new aws.ecs.Cluster('cluster_stream', {
    name: getResourceName('stream'),
    settings: [
      {
        name: 'containerInsights',
        value: 'enabled',
      },
    ],
    tags: getTags(tags),
  })

  new aws.ecs.ClusterCapacityProviders('ccp_stream', {
    clusterName: cluster.name,
    capacityProviders: ['FARGATE'],
    defaultCapacityProviderStrategies: [
      {
        weight: 100,
        capacityProvider: 'FARGATE',
      },
    ],
  })

  return cluster
}

const createEcsTaskRole = (): aws.iam.Role => {
  const role = new aws.iam.Role('role_stream_ecs', {
    name: getResourceName('stream-ar.us-east-1'),
    description: 'Role for Stream ECS Task',
    assumeRolePolicy: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: {
            Service: 'ecs-tasks.amazonaws.com',
          },
        },
      ],
    },
    tags: getTags(tags),
  })

  const policy = new aws.iam.Policy('policy_stream_ecs_ssm', {
    policy: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
          ],
          Resource: '*',
        },
      ],
    },
    tags: getTags(tags),
  })

  new aws.iam.RolePolicyAttachment('rpa_stream_ecs_ssm', {
    role: role.name,
    policyArn: policy.arn,
  })

  return role
}

const createEcsTaskDefinition = (
  config: pulumi.Config,
  streamECRRepo: string,
): aws.ecs.TaskDefinition => {
  const ecrImage = `${process.env.ECR_REGISTRY}/${streamECRRepo}:${process.env.GIT_SHA || 'latest'}`
  const role = createEcsTaskRole()
  const resourceName = getResourceName('stream')

  return new aws.ecs.TaskDefinition(
    'stream-td',
    {
      containerDefinitions: JSON.stringify([
        {
          essential: true,
          image: ecrImage,
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-create-group': 'True',
              'awslogs-group': `/ecs/${resourceName}`,
              'awslogs-region': 'us-east-1',
              'awslogs-stream-prefix': 'stream',
            },
          },
          memoryReservation: config.requireNumber('ecsTaskMemory'),
          name: resourceName,
          portMappings: [
            { containerPort: 8080, hostPort: 8080, protocol: 'tcp' },
          ],
        },
      ]),
      cpu: config.require('ecsTaskCpu'),
      memory: config.require('ecsTaskMemory'),
      taskRoleArn: role.arn,
      executionRoleArn: 'arn:aws:iam::016437323894:role/ECSServiceTask',
      family: resourceName,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      runtimePlatform: {
        operatingSystemFamily: 'LINUX',
      },
      tags: getTags(tags),
    },
    {
      dependsOn: [pulumi.output(role)],
    },
  )
}

const applyEcsServiceAutoscaling = (
  config: pulumi.Config,
  service: aws.ecs.Service,
): void => {
  const target = new aws.appautoscaling.Target('target_stream_ecs', {
    maxCapacity: config.requireNumber('ecsAutoScaleMax'),
    minCapacity: config.requireNumber('ecsAutoScaleMin'),
    resourceId: service.id.apply((id) => id.split(':').pop() || ''),
    scalableDimension: 'ecs:service:DesiredCount',
    serviceNamespace: 'ecs',
  })

  new aws.appautoscaling.Policy('policy_stream_ecs', {
    policyType: 'TargetTrackingScaling',
    resourceId: target.resourceId,
    scalableDimension: target.scalableDimension,
    serviceNamespace: target.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
      targetValue: 60,
      predefinedMetricSpecification: {
        predefinedMetricType: 'ECSServiceAverageCPUUtilization',
      },
      scaleInCooldown: 360,
    },
  })
}

export const createEcsService = (
  config: pulumi.Config,
  infraOutput: SharedInfraOutput,
): void => {
  const cluster = createEcsCluster()
  const taskDefinition = createEcsTaskDefinition(config, infraOutput.streamECRRepo)
  const targetGroup = createEcsTargetGroup(infraOutput)
  const loadBalancer = createEcsLoadBalancer(infraOutput)
  attachLBListeners(loadBalancer, targetGroup)

  const service = new aws.ecs.Service('svc_stream_ecs', {
    cluster: cluster.arn,
    deploymentCircuitBreaker: {
      enable: true,
      rollback: true,
    },
    desiredCount: config.requireNumber('ecsAutoScaleMin'),
    enableEcsManagedTags: true,
    enableExecuteCommand: true,
    forceNewDeployment: true,
    healthCheckGracePeriodSeconds: 20,
    launchType: 'FARGATE',
    loadBalancers: [
      {
        containerName: getResourceName('stream'),
        containerPort: 8080,
        targetGroupArn: targetGroup.arn,
      },
    ],
    name: getResourceName('stream'),
    networkConfiguration: {
      assignPublicIp: true,
      securityGroups: [infraOutput.webEcsSGId],
      subnets: infraOutput.publicSubnets,
    },
    taskDefinition: taskDefinition.arn,
    tags: getTags(tags),
  })

  applyEcsServiceAutoscaling(config, service)
}