
import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry'

const ETHERSCAN_API_URL = process.env.ETHERSCAN_API_URL
const ETHERSCAN_API_URL_GOERLI = process.env.ETHERSCAN_API_URL_GOERLI
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

export const getEtherscanInterceptor = (chainId: string): AxiosInstance => {
  const baseURL: string = Number(chainId) == 1 ? ETHERSCAN_API_URL : ETHERSCAN_API_URL_GOERLI
  const authBaseURL = `${baseURL}/api`
  const etherscanInstance = axios.create({
    baseURL: authBaseURL,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  })

  //
  etherscanInstance.interceptors.request.use(config => {
    config.params = {
      apikey: ETHERSCAN_API_KEY,
      ...config.params,
    }
    return config
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
  axiosRetry(etherscanInstance,  retryOptions)
  return etherscanInstance
}