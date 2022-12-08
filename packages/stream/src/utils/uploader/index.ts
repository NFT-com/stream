import { isString } from 'lodash'

import { Upload } from '@aws-sdk/lib-storage'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { core } from '@nftcom/gql/service'
import { _logger } from '@nftcom/shared'

const logger = _logger.Factory(_logger.Context.General, _logger.Context.Misc)

const lookupEnvKeyOrThrow = (key: string): string => {
  const value = process.env[key]
  if (isString(value)) {
    return value
  }
  throw new Error(`Environment variable ${key} is required`)
}

export const assetBucket = {
  name: lookupEnvKeyOrThrow('ASSET_BUCKET'),
  role: lookupEnvKeyOrThrow('ASSET_BUCKET_ROLE'),
}
/**
 * Upload buffer from external image url to our S3 and return CDN path
 * @param imageUrl
 * @param filename
 * @param chainId
 * @param contract
 * @param uploadPath
 */

export const uploadImageToS3 = async (
  imageUrl: string,
  filename: string,
  chainId: string,
  contract: string,
  uploadPath: string,
): Promise<string | undefined> => {
  try {
    let buffer
    let ext
    let imageKey
    if (!imageUrl) return undefined
    // We skip previewLink generation for SVG, GIF, MP4 and MP3
    if (imageUrl.indexOf('data:image/svg+xml') === 0) {
      return Promise.reject(new Error('File format is unacceptable'))
    } else {
      imageUrl = core.processIPFSURL(imageUrl)
      ext = core.extensionFromFilename(filename)

      if (!ext) {
        if (imageUrl.includes('https://metadata.ens.domains/')) {
          // this image is svg so we skip it
          ext = 'svg'
        } else if (imageUrl.includes('https://arweave.net/')) {
          // AR images are mp4 format, so we don't save as preview link
          ext = 'mp4'
        } else {
          ext = 'png'
        }
        imageKey = uploadPath + Date.now() + '-' + filename + `.${ext}`
      } else {
        imageKey = uploadPath + Date.now() + '-' + filename
      }

      // get buffer from imageURL, timeout is set to 60 seconds
      const res = await core.fetchWithTimeout(imageUrl, { timeout: 1000 * 60 })
      buffer = await res.buffer()
    }

    if (!buffer) return undefined

    const contentType = core.contentTypeFromExt(ext)
    if (!contentType) return undefined
    const s3config = await core.getAWSConfig()
    const upload = new Upload({
      client: s3config,
      params: {
        Bucket: assetBucket.name,
        Key: imageKey,
        Body: buffer,
        ContentType: contentType,
      },
    })
    await upload.done()

    logger.info(`finished uploading in uploadImageToS3: ${imageUrl}`)
    return core.s3ToCdn(`https://${assetBucket.name}.s3.amazonaws.com/${imageKey}`)
  } catch (err) {
    logger.error(`Error in uploadImageToS3 ${err}`)
    throw err
  }
}
