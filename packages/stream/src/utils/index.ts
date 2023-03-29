import { provider } from '@nftcom/shared'

export const ALLOWED_NETWORKS: string[] = ['ethereum', 'goerli']

export const delay = (ms: number) : Promise<any> => new Promise(resolve => setTimeout(resolve, ms))

export const getLatestBlockNumber = async (chainId = 1): Promise<number> => {
  const chainProvider = provider.provider(Number(chainId))
  const latestBlockNumber = await chainProvider.getBlockNumber()
  return latestBlockNumber
}

export const lookupEnvKeyOrThrow = (key: string): string => {
  const value = process.env[key]
  if (typeof value === 'string') {
    return value
  }
  throw new Error(`Environment variable ${key} is required`)
}

export const getTimeStamp = (start: number): string => {
  return `Total time taken : ${new Date().getTime() - start} milliseconds`
}

export const chainFromId = (chainId: string): string | undefined => {
  switch(chainId) {
  case '1':
    return 'ethereum'
  case '5':
    return 'goerli'
  case '137':
    return 'polygon'
  default:
    return undefined
  }
}