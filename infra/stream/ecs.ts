import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { SharedInfraOutput } from '../defs'
import { getResourceName, getStage, getTags, isProduction } from '../helper'

const tags = {
  service: 'st',
}

const attachLBListeners = (
  lb: aws.lb.LoadBalancer,
  tg: aws.lb.TargetGroup,
): void => {
  new aws.lb.Listener('listener_http_dev_st_ecs', {
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

  new aws.lb.Listener('listener_https_dev_st_ecs', {
    certificateArn:
      'arn:aws:acm:us-east-1:016437323894:certificate/44dc39c0-4231-41f6-8f27-03029bddfa8e',
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
  return new aws.lb.TargetGroup('tg_st_ecs', {
    healthCheck: {
      interval: 60,
      matcher: '200-399',
      path: '/health',
      timeout: 30,
      unhealthyThreshold: 5,
    },
    name: getResourceName('st-ecs'),
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
  return new aws.lb.LoadBalancer('lb_st_ecs', {
    ipAddressType: 'ipv4',
    name: getResourceName('st-ecs'),
    securityGroups: [infraOutput.webSGId],
    subnets: infraOutput.publicSubnets,
    tags: getTags(tags),
  })
}

const createEcsCluster = (): aws.ecs.Cluster => {
  const cluster = new aws.ecs.Cluster('cluster_st', {
    name: getResourceName('st'),
    settings: [
      {
        name: 'containerInsights',
        value: 'enabled',
      },
    ],
    tags: getTags(tags),
  })

  new aws.ecs.ClusterCapacityProviders('ccp_st', {
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
  const role = new aws.iam.Role('role_st_ecs', {
    name: getResourceName('st-ar.us-east-1'),
    description: 'Role for st ECS Task',
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

  const policy = new aws.iam.Policy('policy_st_ecs_ssm', {
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
            'logs:CreateLogst',
            'logs:PutLogEvents',
            'logs:DescribeLogsts',
          ],
          Resource: '*',
        },
      ],
    },
    tags: getTags(tags),
  })

  new aws.iam.RolePolicyAttachment('rpa_st_ecs_ssm', {
    role: role.name,
    policyArn: policy.arn,
  })

  return role
}

const createAOTCollectorSSMParameter = (): aws.ssm.Parameter => {
  return new aws.ssm.Parameter('otel-collector-config-stream', {
    name: getResourceName('otel-collector-config-stream'),
    type: 'String',
    value: `extensions:
  health_check:
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch/traces:
    timeout: 1s
    send_batch_size: 50
  probabilistic_sampler:
    hash_seed: 31
    sampling_percentage: ${isProduction() ? '20' : getStage() === 'staging' ? '10' : '0'}
  resourcedetection:
    detectors:
      - env
      - system
      - ecs

exporters:
  datadog/api:
    api:
      key: "\${DATADOG_API_KEY}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [probabilistic_sampler, resourcedetection, batch/traces]
      exporters: [datadog/api]
  extensions: [health_check]`,
  })
}

const createEcsTaskDefinition = (
  config: pulumi.Config,
  stECRRepo: string,
): aws.ecs.TaskDefinition => {
  const ecrImage = `${process.env.ECR_REGISTRY}/${stECRRepo}:${process.env.GIT_SHA || 'latest'}`
  const role = createEcsTaskRole()
  const resourceName = getResourceName('st')
  const ssmParam = createAOTCollectorSSMParameter()

  return new aws.ecs.TaskDefinition(
    'st-td',
    {
      containerDefinitions: pulumi.all([ssmParam.arn])
        .apply(([ssmParamArn]: string[]) => {
          return JSON.stringify([
            {
              essential: true,
              image: ecrImage,
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-create-group': 'True',
                  'awslogs-group': `/ecs/${resourceName}`,
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'st',
                },
              },
              memoryReservation: config.requireNumber('ecsTaskMemory'),
              name: resourceName,
              portMappings: [
                { containerPort: 8080, hostPort: 8080, protocol: 'tcp' },
              ],
              environment: [
                {
                  Name: 'STAGE',
                  Value: process.env.STAGE,
                },
                {
                  Name: 'NODE_OPTIONS',
                  Value: process.env.NODE_OPTIONS,
                },
                {
                  Name: 'NODE_ENV',
                  Value: process.env.NODE_ENV,
                },
                {
                  Name: 'PULUMI_CONFIG_PASSPHRASE',
                  Value: process.env.PULUMI_CONFIG_PASSPHRASE,
                },
                {
                  Name: 'AWS_ACCOUNT_ID',
                  Value: process.env.AWS_ACCOUNT_ID,
                },
                {
                  Name: 'ECR_REGISTRY',
                  Value: process.env.ECR_REGISTRY,
                },
                {
                  Name: 'GIT_SHA',
                  Value: process.env.GIT_SHA,
                },
                {
                  Name: 'DB_HOST',
                  Value: process.env.DB_HOST,
                },
                {
                  Name: 'DB_HOST_RO',
                  Value: process.env.DB_HOST_RO,
                },
                {
                  Name: 'DB_USE_SSL',
                  Value: process.env.DB_USE_SSL,
                },
                {
                  Name: 'DB_PASSWORD',
                  Value: process.env.DB_PASSWORD,
                },
                {
                  Name: 'DB_PORT',
                  Value: process.env.DB_PORT,
                },
                {
                  Name: 'CHAIN_ID',
                  Value: process.env.CHAIN_ID,
                },
                {
                  Name: 'AUTH_MESSAGE',
                  Value: process.env.AUTH_MESSAGE,
                },
                {
                  Name: 'AUTH_ALLOWED_LIST',
                  Value: process.env.AUTH_ALLOWED_LIST,
                },
                {
                  Name: 'SG_API_KEY',
                  Value: process.env.SG_API_KEY,
                },
                {
                  Name: 'ETH_GAS_STATION_API_KEY',
                  Value: process.env.ETH_GAS_STATION_API_KEY,
                },
                {
                  Name: 'TEAM_AUTH_TOKEN',
                  Value: process.env.TEAM_AUTH_TOKEN,
                },
                {
                  Name: 'MNEMONIC',
                  Value: process.env.MNEMONIC,
                },
                {
                  Name: 'MNEMONIC_RINKEBY',
                  Value: process.env.MNEMONIC_RINKEBY,
                },
                {
                  Name: 'HCS_TOPIC_ID',
                  Value: process.env.HCS_TOPIC_ID,
                },
                {
                  Name: 'HCS_ACCOUNT_ID',
                  Value: process.env.HCS_ACCOUNT_ID,
                },
                {
                  Name: 'HCS_PRIVATE_KEY',
                  Value: process.env.HCS_PRIVATE_KEY,
                },
                {
                  Name: 'HCS_ENABLED',
                  Value: process.env.HCS_ENABLED,
                },
                {
                  Name: 'ZMOK_API_URL',
                  Value: process.env.ZMOK_API_URL,
                },
                {
                  Name: 'INFURA_API_KEY',
                  Value: process.env.INFURA_API_KEY,
                },
                {
                  Name: 'ALCHEMY_API_KEY',
                  Value: process.env.ALCHEMY_API_KEY,
                },
                {
                  Name: 'ALCHEMY_API_URL',
                  Value: process.env.ALCHEMY_API_URL,
                },
                {
                  Name: 'ALCHEMY_API_URL_GOERLI',
                  Value: process.env.ALCHEMY_API_URL_GOERLI,
                },
                {
                  Name: 'ETHERSCAN_API_KEY',
                  Value: process.env.ETHERSCAN_API_KEY,
                },
                {
                  Name: 'ETHERSCAN_API_URL',
                  Value: process.env.ETHERSCAN_API_URL,
                },
                {
                  Name: 'ETHERSCAN_API_URL_GOERLI',
                  Value: process.env.ETHERSCAN_API_URL_GOERLI,
                },
                {
                  Name: 'SENTRY_DSN',
                  Value: process.env.SENTRY_DSN,
                },
                {
                  Name: 'PUBLIC_SALE_KEY',
                  Value: process.env.PUBLIC_SALE_KEY,
                },
                {
                  Name: 'SERVER_CONFIG',
                  Value: process.env.SERVER_CONFIG,
                },
                {
                  Name: 'SHARED_MINT_SECRET',
                  Value: process.env.SHARED_MINT_SECRET,
                },
                {
                  Name: 'SUPPORTED_NETWORKS',
                  Value: process.env.SUPPORTED_NETWORKS,
                },
                {
                  Name: 'TYPESENSE_HOST',
                  Value: process.env.TYPESENSE_HOST,
                },
                {
                  Name: 'TYPESENSE_API_KEY',
                  Value: process.env.TYPESENSE_API_KEY,
                },
                {
                  Name: 'MINTED_PROFILE_EVENTS_MAX_BLOCKS',
                  Value: process.env.MINTED_PROFILE_EVENTS_MAX_BLOCKS,
                },
                {
                  Name: 'PROFILE_NFTS_EXPIRE_DURATION',
                  Value: process.env.PROFILE_NFTS_EXPIRE_DURATION,
                },
                {
                  Name: 'BULL_MAX_REPEAT_COUNT',
                  Value: process.env.BULL_MAX_REPEAT_COUNT,
                },
                {
                  Name: 'OPENSEA_API_KEY',
                  Value: process.env.OPENSEA_API_KEY,
                },
                {
                  Name: 'OPENSEA_ORDERS_API_KEY',
                  Value: process.env.OPENSEA_ORDERS_API_KEY,
                },
                {
                  Name: 'LOOKSRARE_API_KEY',
                  Value: process.env.LOOKSRARE_API_KEY,
                },
                {
                  Name: 'X2Y2_API_KEY',
                  Value: process.env.X2Y2_API_KEY,
                },
                {
                  Name: 'PROFILE_SCORE_EXPIRE_DURATION',
                  Value: process.env.PROFILE_SCORE_EXPIRE_DURATION,
                },
                {
                  Name: 'NFT_EXTERNAL_ORDER_REFRESH_DURATION',
                  Value: process.env.NFT_EXTERNAL_ORDER_REFRESH_DURATION,
                },
                {
                  Name: 'TEST_DB_HOST',
                  Value: process.env.TEST_DB_HOST,
                },
                {
                  Name: 'TEST_DB_DATABASE',
                  Value: process.env.TEST_DB_DATABASE,
                },
                {
                  Name: 'TEST_DB_USERNAME',
                  Value: process.env.TEST_DB_USERNAME,
                },
                {
                  Name: 'TEST_DB_PORT',
                  Value: process.env.TEST_DB_PORT,
                },
                {
                  Name: 'TEST_DB_PASSWORD',
                  Value: process.env.TEST_DB_PASSWORD,
                },
                {
                  Name: 'TEST_DB_USE_SSL',
                  Value: process.env.TEST_DB_USE_SSL,
                },
                {
                  Name: 'ACTIVITY_ENDPOINTS_ENABLED',
                  Value: process.env.ACTIVITY_ENDPOINTS_ENABLED,
                },
                {
                  Name: 'NFTPORT_KEY',
                  Value: process.env.NFTPORT_KEY,
                },
                {
                  Name: 'REFRESH_NFT_DURATION',
                  Value: process.env.REFRESH_NFT_DURATION,
                },
                {
                  Name: 'IPFS_WEB_GATEWAY',
                  Value: process.env.IPFS_WEB_GATEWAY,
                },
                {
                  Name: 'DEFAULT_TTL_MINS',
                  Value: process.env.DEFAULT_TTL_MINS,
                },
                {
                  Name: 'ASSET_BUCKET',
                  Value: process.env.ASSET_BUCKET,
                },
                {
                  Name: 'ASSET_BUCKET_ROLE',
                  Value: process.env.ASSET_BUCKET_ROLE,
                },
                {
                  Name: 'REDIS_HOST',
                  Value: process.env.REDIS_HOST,
                },
                {
                  Name: 'REDIS_PORT',
                  Value: process.env.REDIS_PORT,
                },
                {
                  Name: 'PORT',
                  Value: process.env.PORT,
                },
                {
                  Name: 'CONFIRM_EMAIL_URL',
                  Value: process.env.CONFIRM_EMAIL_URL,
                },
                {
                  Name: 'MULTICALL_CONTRACT',
                  Value: process.env.MULTICALL_CONTRACT,
                },
                {
                  Name: 'ORDER_RECONCILIATION_PERIOD',
                  Value: process.env.ORDER_RECONCILIATION_PERIOD,
                },
                {
                  Name: 'USE_INFURA',
                  Value: process.env.USE_INFURA,
                },
                {
                  Name: 'USE_ZMOK',
                  Value: process.env.USE_ZMOK,
                },
                {
                  Name: 'ZMOK_API_KEY',
                  Value: process.env.ZMOK_API_KEY,
                },
                {
                  Name: 'INFURA_KEY_SET',
                  Value: process.env.INFURA_KEY_SET,
                },
                {
                  Name: 'MAX_BATCHES_NFTPORT',
                  Value: process.env.MAX_BATCHES_NFTPORT,
                },
                {
                  Name: 'MAX_PROFILE_BATCH_SIZE',
                  Value: process.env.MAX_PROFILE_BATCH_SIZE,
                },
              ],
              dependsOn: [
                {
                  containerName: getResourceName('aws-otel-collector'),
                  condition: 'START',
                },
              ],
            },
            {
              name: getResourceName('aws-otel-collector'),
              image: 'amazon/aws-otel-collector',
              essential: true,
              environment: [
                {
                  Name: 'DATADOG_API_KEY',
                  Value: process.env.DATADOG_API_KEY,
                },
              ],
              secrets: [
                {
                  Name: 'AOT_CONFIG_CONTENT',
                  ValueFrom: ssmParamArn,
                },
              ],
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/ecs-aws-otel-sidecar-collector',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                  'awslogs-create-group': 'True',
                },
              },
              healthCheck: {
                command: ['/healthcheck'],
                interval: 5,
                timeout: 6,
                retries: 5,
                startPeriod: 1,
              },
            },
          ])
        }),
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
  const target = new aws.appautoscaling.Target('target_st_ecs', {
    maxCapacity: config.requireNumber('ecsAutoScaleMax'),
    minCapacity: config.requireNumber('ecsAutoScaleMin'),
    resourceId: service.id.apply((id) => id.split(':').pop() || ''),
    scalableDimension: 'ecs:service:DesiredCount',
    serviceNamespace: 'ecs',
  })

  new aws.appautoscaling.Policy('policy_st_ecs', {
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

  const service = new aws.ecs.Service('svc_st_ecs', {
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
        containerName: getResourceName('st'),
        containerPort: 8080,
        targetGroupArn: targetGroup.arn,
      },
    ],
    name: getResourceName('st'),
    networkConfiguration: {
      assignPublicIp: true,
      securityGroups: [infraOutput.webSGId],
      subnets: infraOutput.publicSubnets,
    },
    taskDefinition: taskDefinition.arn,
    tags: getTags(tags),
  })

  applyEcsServiceAutoscaling(config, service)
}
