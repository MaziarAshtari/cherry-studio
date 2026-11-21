import { application } from '@application'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { selfHostedSyncErrorCodes } from '@shared/ipc/errors/selfHostedSync'
import type { selfHostedSyncRequestSchemas } from '@shared/ipc/schemas/selfHostedSync'
import type { IpcHandlersFor } from '@shared/ipc/types'

const toSyncError = (error: unknown): IpcError =>
  new IpcError(selfHostedSyncErrorCodes.SYNC_FAILED, error instanceof Error ? error.message : String(error))

export const selfHostedSyncHandlers: IpcHandlersFor<typeof selfHostedSyncRequestSchemas> = {
  'self_hosted_sync.get_state': async () => application.get('SelfHostedSyncService').getSnapshot(),
  'self_hosted_sync.update_config': async (patch) => application.get('SelfHostedSyncService').updateConfig(patch),
  'self_hosted_sync.test_connection': async (input) => {
    try {
      return await application.get('SelfHostedSyncService').testConnection(input)
    } catch (error) {
      throw toSyncError(error)
    }
  },
  'self_hosted_sync.sync_now': async () => {
    try {
      return await application.get('SelfHostedSyncService').syncNow()
    } catch (error) {
      throw toSyncError(error)
    }
  }
}
