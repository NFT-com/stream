export enum AuthErrorType {
  Unauthenticated = 'Not Authenticated',
  Forbidden = 'FORBIDDEN'
}

export interface AuthError {
  errorType: AuthErrorType
  message: string
}

export const buildError = (
  errorType: AuthErrorType,
  message: string,
): AuthError => {
  return {
    errorType,
    message,
  }
}