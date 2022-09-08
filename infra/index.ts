import * as console from 'console'
import * as process from 'process'
import * as upath from 'upath'
import * as fs from 'fs'
import * as pulumi from '@pulumi/pulumi'
import { SharedInfraOutput, sharedOutputFileName } from './defs'
import { createSharedInfra } from './shared'
import { createStreamCluster, updateStreamEnvFile } from './stream'

export const sharedOutToJSONFile = (outMap: pulumi.automation.OutputMap): void => {
  const streamECRRepo = outMap.streamECRRepo.value
  const publicSubnets = outMap.publicSubnetIds.value
  const vpcId = outMap.vpcId.value
  const webSGId = outMap.webSGId.value
  const sharedOutput: SharedInfraOutput = {
    streamECRRepo,
    publicSubnets,
    vpcId,
    webSGId,
  }
  const file = upath.joinSafe(__dirname, sharedOutputFileName)
  fs.writeFileSync(file, JSON.stringify(sharedOutput))
}

const main = async (): Promise<any> => {
  const args = process.argv.slice(2)
  const deployShared = args?.[0] === 'deploy:shared' || false
  const deployStream = args?.[0] === 'deploy:stream' || false
  const buildStreamEnv = args?.[0] === 'stream:env' || false

  if (deployShared) {
    return createSharedInfra(true)
      .then(sharedOutToJSONFile)
  }

  if (buildStreamEnv) {
    updateStreamEnvFile()
    return
  }

  if (deployStream) {
    return createStreamCluster()
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

