import { utils } from 'ethers'

import { AuthErrorType, buildError } from '../error/auth'
import { lookupEnvKeyOrThrow } from '../utils'

const authAllowedList: string = process.env.AUTH_ALLOWED_LIST || ''
const authMessage = lookupEnvKeyOrThrow('AUTH_MESSAGE')
const authHeader = 'authorization'

const getAddressFromSignature = (signature: string): string =>
  utils.verifyMessage(authMessage, signature)

export const authMiddleWare =  (_req, res, next): any => {
  const authSignature = _req.headers[authHeader] || null

  if (!authSignature) {
    return res.status(401).send(buildError(
      AuthErrorType.Unauthenticated,
      'Not authenticated!',
    ))
  }
  const address = getAddressFromSignature(authSignature)
  const allowedList: string [] = authAllowedList ? authAllowedList.split(',') : []
  if(!allowedList.includes(address)) {
    return res.status(403).send(buildError(
      AuthErrorType.Forbidden,
      'Not allowed to perform this operation!',
    ))
  }

  return next()
}