import Bull from 'bull'
import { _logger } from 'nftcom-backend/shared'

import { redisConfig } from '../config'
import { deregisterStreamHandler, registerStreamHandler } from './handler'
import { nftExternalOrders } from './syncHandler'

const BULL_MAX_REPEAT_COUNT = parseInt(process.env.BULL_MAX_REPEAT_COUNT) || 250
const logger = _logger.Factory(_logger.Context.Bull)

export const redis = {
  host: redisConfig.host,
  port: redisConfig.port,
}
const queuePrefix = 'stream-queue'

export enum QUEUE_TYPES {
  SYNC_CONTRACTS = 'SYNC_CONTRACTS',
  REGISTER_OS_STREAMS = 'REGISTER_OS_STREAMS',
  DEREGISTER_OS_STREAMS = 'DEREGISTER_OS_STREAMS',
}

export const queues = new Map<string, Bull.Queue>()

// nft cron subqueue
const subqueuePrefix = 'nft-cron'
const subqueueName = 'nft-batch-processor'

export let nftCronSubqueue: Bull.Queue = null

let didPublish: boolean

const createQueues = (): Promise<void> => {
  return new Promise((resolve) => {
    queues.set(QUEUE_TYPES.REGISTER_OS_STREAMS, new Bull(
      QUEUE_TYPES.REGISTER_OS_STREAMS, {
        prefix: queuePrefix,
        redis,
      }))

    // sync external orders
    queues.set(QUEUE_TYPES.SYNC_CONTRACTS, new Bull(
      QUEUE_TYPES.SYNC_CONTRACTS, {
        prefix: queuePrefix,
        redis,
      }))

    //cron subqueue
    nftCronSubqueue = new Bull(subqueueName, {
      redis: redis,
      prefix: subqueuePrefix,
    })

    queues.set(QUEUE_TYPES.DEREGISTER_OS_STREAMS, new Bull(
      QUEUE_TYPES.DEREGISTER_OS_STREAMS, {
        prefix: queuePrefix,
        redis,
      }))

    resolve()
  })
}

const getExistingJobs = (): Promise<Bull.Job[][]> => {
  const values = [...queues.values()]
  return Promise.all(values.map((queue) => {
    return queue.getJobs(['active', 'completed', 'delayed', 'failed', 'paused', 'waiting'])
  }))
}

const jobHasNotRunRecently = (job: Bull.Job<any>): boolean  => {
  const currentMillis = Date.now()
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: @types/bull is outdated
  return currentMillis > (job.opts.repeat.every * 1.2) + job.opts.prevMillis
}

const checkJobQueues = (jobs: Bull.Job[][]): Promise<boolean> => {
  const values = [...queues.values()]
  if (jobs.flat().length < queues.size) {
    logger.info('🐮 fewer bull jobs than queues -- wiping queues for restart')
    return Promise.all(values.map((queue) => {
      return queue.obliterate({ force: true })
    })).then(() => true)
  }

  for (const key of queues.keys()) {
    const queue = queues.get(key)
    const job = jobs.flat().find(job => job.queue === queue)
    if ((job.opts.repeat
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore: @types/bull is outdated
          && (job.opts.repeat.count >= BULL_MAX_REPEAT_COUNT || jobHasNotRunRecently(job)))
        || !job.opts.repeat) {
      logger.info('🐮 bull job needs to restart -- wiping queues for restart')
      return Promise.all(values.map((queue) => {
        return queue.obliterate({ force: true })
      })).then(() => true)
    }
  }
  return new Promise(resolve => resolve(false))
}

const publishJobs = (shouldPublish: boolean): Promise<void> => {
  if (shouldPublish) {
    didPublish = true
    const chainIds = [...queues.keys()]
    return Promise.all(chainIds.map((chainId) => {
      switch (chainId) {
      // case QUEUE_TYPES.REGISTER_OS_STREAMS:
      //   return queues.get(QUEUE_TYPES.REGISTER_OS_STREAMS)
      //     .add({ REGISTER_OS_STREAMS: QUEUE_TYPES.REGISTER_OS_STREAMS }, {
      //       removeOnComplete: true,
      //       removeOnFail: true,
      //       // repeat every  2 minutes
      //       repeat: { every: 10 * 60000 },
      //       jobId: 'register_os_streams',
      //     })
      // case QUEUE_TYPES.DEREGISTER_OS_STREAMS:
      //   return queues.get(QUEUE_TYPES.DEREGISTER_OS_STREAMS)
      //     .add({ DEREGISTER_OS_STREAMS: QUEUE_TYPES.DEREGISTER_OS_STREAMS }, {
      //       removeOnComplete: true,
      //       removeOnFail: true,
      //       // repeat every  2 minutes
      //       repeat: { every: 10 * 60000 },
      //       jobId: 'deregister_os_streams',
      //     })
      default:
        return Promise.resolve()
      }
    })).then(() => undefined)
  }

  return new Promise(resolve => resolve(undefined))
}

const listenToJobs = async (): Promise<void> => {
  for (const queue of queues.values()) {
    switch (queue.name) {
    case QUEUE_TYPES.SYNC_CONTRACTS:
      queue.process(nftExternalOrders)
      break
    case QUEUE_TYPES.REGISTER_OS_STREAMS:
      queue.process(registerStreamHandler)
      break
    case QUEUE_TYPES.DEREGISTER_OS_STREAMS:
      queue.process(deregisterStreamHandler)
      break
    default:
      break
    }
  }
}

export const startAndListen = (): Promise<void> => {
  return createQueues()
    .then(() => getExistingJobs())
    .then((jobs) => checkJobQueues(jobs))
    .then((shouldPublish) => publishJobs(shouldPublish))
    .then(() => listenToJobs())
    .then(() => {
      setTimeout(() => {
        didPublish ? logger.info('🍊 queue was restarted -- listening for jobs...')
          : logger.info('🍊 queue is healthy -- listening for jobs...')
      })
    })
}

export const stopAndDisconnect = (): Promise<any> => {
  const values = [...queues.values()]
  // close cron sub-queue
  if (nftCronSubqueue) {
    values.push(nftCronSubqueue)
  }
  return Promise.all(values.map((queue) => {
    return queue.close()
  }))
}
