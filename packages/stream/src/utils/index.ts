export const delay = (ms: number) : Promise<any> => new Promise(resolve => setTimeout(resolve, ms))

export const lookupEnvKeyOrThrow = (key: string): string => {
  const value = process.env[key]
  if (typeof value === 'string') {
    return value
  }
  throw new Error(`Environment variable ${key} is required`)
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