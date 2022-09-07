import * as console from 'console'
import * as process from 'process'
import { createStreamCluster } from './stream'


const main = async (): Promise<any> => {
  const args = process.argv.slice(2)
  const deployStream = args?.[0] === 'deploy:stream' || false
  
  if (deployStream) {
    return createStreamCluster()
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

