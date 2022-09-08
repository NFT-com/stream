import * as aws from '@pulumi/aws'

import { getResourceName } from '../helper'

export type RepositoryOut = {
  stream: aws.ecr.Repository
}

export const createStreamRepository = (): aws.ecr.Repository => {
  return new aws.ecr.Repository('ecr_st', {
    name: getResourceName('st'),
    imageScanningConfiguration: {
      scanOnPush: true,
    },
  })
}

export const createRepositories = (): RepositoryOut => {
  const streamRepo = createStreamRepository()
  return {
    stream: streamRepo,
  }
}
