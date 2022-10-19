import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'

const ALCHEMY_NFT_API_URL = process.env.ALCHEMY_NFT_API_URL
const ALCHEMY_NFT_API_URL_GOERLI = process.env.ALCHEMY_NFT_API_URL_GOERLI

export const getAlchemyInterceptor = (
  chainId: string,
): AxiosInstance => {
  const alchemyInstance = axios.create({
    baseURL: chainId === '1' ? ALCHEMY_NFT_API_URL : ALCHEMY_NFT_API_URL_GOERLI,
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