export const sharedOutputFileName = 'shared-out.json'

export type SharedInfraOutput = {
  dbHost: string
  redisHost: string
  streamECRRepo: string
  publicSubnets: string[]
  vpcId: string
  webSGId: string
  webEcsSGId: string
}
