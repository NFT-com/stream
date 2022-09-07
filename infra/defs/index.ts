export const sharedOutputFileName = 'shared-out.json'

export type SharedInfraOutput = {
  dbHost: string
  publicSubnets: string[]
  redisHost: string
  vpcId: string
  webSGId: string
  webEcsSGId: string
  streamECRRepo: string
}
