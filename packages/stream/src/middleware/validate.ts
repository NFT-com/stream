import { NextFunction, Request, Response } from 'express'
import { AnyZodObject, z } from 'zod'

export const collectionSyncSchema = z.object({
  body: z.object({
    collections: z.string({
      required_error: 'No collection to sync! Please send in collections',
    }).array(),
    startToken: z.string().optional(),
  }),
})

export const validate = (schema: AnyZodObject) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })
      return next()
    } catch (error) {
      return res.status(400).json(error)
    }
  }