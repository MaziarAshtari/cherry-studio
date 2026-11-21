import * as z from 'zod'

import { SELF_HOSTED_SYNC_CATEGORIES, type SelfHostedSyncStatus } from '@shared/types/selfHostedSync'

import { defineRoute } from '../define'

const categoryTogglesSchema = z.record(z.enum(SELF_HOSTED_SYNC_CATEGORIES), z.boolean())

const configSchema = z.object({
  enabled: z.boolean(),
  serverUrl: z.string(),
  authToken: z.string(),
  deviceName: z.string(),
  categories: categoryTogglesSchema
})

const statusSchema = z.object({
  state: z.enum(['disabled', 'idle', 'connected', 'syncing', 'error']),
  deviceId: z.string(),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable()
})

const connectionSchema = z.object({
  serverUrl: z.string().trim().min(1),
  authToken: z.string().trim().min(1),
  deviceName: z.string()
})

export const selfHostedSyncRequestSchemas = {
  'self_hosted_sync.get_state': defineRoute({
    input: z.void(),
    output: z.object({ config: configSchema, status: statusSchema })
  }),
  'self_hosted_sync.update_config': defineRoute({
    input: configSchema
      .omit({ categories: true })
      .partial()
      .extend({ categories: z.partialRecord(z.enum(SELF_HOSTED_SYNC_CATEGORIES), z.boolean()).optional() }),
    output: z.object({ config: configSchema, status: statusSchema })
  }),
  'self_hosted_sync.test_connection': defineRoute({
    input: connectionSchema,
    output: z.object({ latestRevision: z.number(), serverTime: z.number() })
  }),
  'self_hosted_sync.sync_now': defineRoute({
    input: z.void(),
    output: statusSchema
  })
}

export type SelfHostedSyncEventSchemas = {
  'self_hosted_sync.status_changed': SelfHostedSyncStatus
}
