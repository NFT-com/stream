import { exec } from 'child_process'
import * as console from 'console'
import * as envfile from 'envfile'
import * as fs from 'fs'
import * as _ from 'lodash'
import * as upath from 'upath'
import * as util from 'util'

import * as pulumi from '@pulumi/pulumi'

import { SharedInfraOutput, sharedOutputFileName } from '../defs'

export const joinStrings = (sep: string, ...strs: string[]): string => strs.join(sep)

export const joinStringsByDash = (...strs: string[]): string => joinStrings('-', ...strs)

export const getEnv = (pkg: string, env='.env'): { parsedFile: envfile.Data; workDir: string } => {
  const workDir = upath.joinSafe(__dirname, '..', '..', 'packages', pkg)
  const sourceFile = upath.joinSafe(workDir, env)
  const envFileStr = fs.readFileSync(sourceFile).toString()
  return { parsedFile: envfile.parse(envFileStr), workDir }
}

export const getStage = (): string => {
  const stackName = pulumi.getStack()
  const [stage] = stackName.split('.')
  return stage
}

export const getResourceNameWithPrefix = (service: string, name: string): string => {
  return joinStringsByDash(getStage(), service, name)
}

export const getResourceName = (name: string): string => {
  return joinStringsByDash(getStage(), name)
}

export const getTags = (tags = {}): {[key: string]: string} => {
  return {
    ...tags,
    env: getStage(),
  }
}

export const pulumiOutToValue = <T>(output: pulumi.Output<T>): Promise<T> => {
  return new Promise<T>((resolve) => {
    output.apply(resolve)
  })
}

export const isProduction = (): boolean => getStage() === 'prod'

export const isFalse = (v: boolean): boolean => v === false

export const isEmpty = <T>(v: T): boolean => {
  if (_.isNumber(v)) {
    return _.isNil(v)
  }
  return _.isEmpty(v)
}

export const isNotEmpty = <T>(v: T): boolean => isFalse(isEmpty(v))

export const deployInfra = async (
  stackName: string,
  workDir: string,
  pulumiFn: pulumi.automation.PulumiFn,
  preview?: boolean,
): Promise<pulumi.automation.OutputMap> => {
  const args: pulumi.automation.InlineProgramArgs = {
    stackName,
    projectName: 'inlineNode',
    program: pulumiFn,
  }

  const stack = await pulumi.automation.LocalWorkspace.createOrSelectStack(args, { workDir })
  console.info('Successfully initialized stack')

  console.info('Installing plugins...')
  await stack.workspace.installPlugin('aws', 'v4.29.0')

  if (preview) {
    await stack.preview({ onOutput: console.info })
  }

  const result = await stack.up({ onOutput: console.info })
  // console.log('Update summary', JSON.stringify(result.summary))
  return result.outputs
}

export const getSharedInfraOutput = (): SharedInfraOutput => {
  const file = upath.joinSafe(__dirname, '..', sharedOutputFileName)
  const output = fs.readFileSync(file).toString()
  return <SharedInfraOutput>JSON.parse(output)
}

const promisifiedExec = util.promisify(exec)
export const execShellCommand = (command: string, swallowError = false): Promise<void> => {
  return promisifiedExec(command)
    .then(({ stdout, stderr }) => {
      const err = stderr.replace('\n', '').trim()
      if (isNotEmpty(err) && isFalse(swallowError)) {
        return Promise.reject(new Error(`Something went wrong with command ${command}. Error: ${err}`))
      }
      if (isNotEmpty(err) && swallowError) {
        console.error('SWALLOWING ERROR', err)
        return Promise.resolve()
      }
      console.log(stdout.replace('\n', '').trim())
      return Promise.resolve()
    })
}