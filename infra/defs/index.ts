export const sharedOutputFileName = 'shared-out.json'

export type SharedInfraOutput = {
  streamECRRepo: string
  publicSubnets: string[]
  vpcId: string
  webSGId: string
}
