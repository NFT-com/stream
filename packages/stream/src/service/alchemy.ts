import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'

export const getAlchemyInterceptor = (
  chainId: string,
  nft?: boolean,
): AxiosInstance => {
  const alchemyInstance = axios.create({
    baseURL: `https://eth-mainnet.alchemyapi.io/${nft? 'nft/' : ''}v2/${Number(chainId) == 1 ?
      process.env.ALCHEMY_API_KEY : process.env.ALCHEMY_TESTNET_KEY}`,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  })
  // retry logic with exponential backoff
  const retryOptions: IAxiosRetryConfig= { retries: 3,
    retryCondition: (err: AxiosError<any>) => {
      return (
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
          err.response.status === 429
      )
    },
    retryDelay: (retryCount: number, err: AxiosError<any>) => {
      if (err.response) {
        const retry_after = Number(err.response.headers['retry-after'])
        if (retry_after) {
          return retry_after
        }
      }
      return axiosRetry.exponentialDelay(retryCount)
    },
  }
  axiosRetry(alchemyInstance,  retryOptions)
  return alchemyInstance
}