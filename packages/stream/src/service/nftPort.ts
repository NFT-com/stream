import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'

const NFTPORT_API_KEY = process.env.NFTPORT_KEY

export const getNFTPortInterceptor = (
  baseURL: string,
): AxiosInstance => {
  const instance = axios.create({
    baseURL,
    headers: {
      Authorization: NFTPORT_API_KEY,
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
        const retry_after =  Number(err.response.headers['retry-after'])
        if (retry_after) {
          return retry_after
        }
      }
      return axiosRetry.exponentialDelay(retryCount)
    },
  }
  axiosRetry(instance as any,  retryOptions)

  return instance
}