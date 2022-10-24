import { NextFunction, Request, Response } from 'express'
import { AnyZodObject, z } from 'zod'

export type SyncCollectionInput = { address: string; startToken?: string };

export const collectionSyncSchema = z.object({
  body: z.object({
    collections: z.array(z.object({
      address: z.string(
        {
          required_error: 'address is required',
          invalid_type_error: 'address must be a string',
        },
      ),
      startToken: z.string().optional(),
    })).nonempty({
      message: 'No collection to sync! Please send in an array of collection addresses',
    }),
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