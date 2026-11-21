/**
 * Self-hosted multi-device sync: cross-process constants and DTOs.
 * The wire protocol with the sync server lives in `sync-server/README.md`.
 */

export const SELF_HOSTED_SYNC_CATEGORIES = [
  'chats',
  'assistants',
  'providers',
  'mcp',
  'settings',
  'files',
  'knowledge'
] as const

export type SelfHostedSyncCategory = (typeof SELF_HOSTED_SYNC_CATEGORIES)[number]

export type SelfHostedSyncCategoryToggles = Record<SelfHostedSyncCategory, boolean>

export interface SelfHostedSyncConfig {
  enabled: boolean
  serverUrl: string
  authToken: string
  deviceName: string
  categories: SelfHostedSyncCategoryToggles
}

/** `connected` = idle with a live event stream; `idle` = idle, polling fallback only. */
export type SelfHostedSyncState = 'disabled' | 'idle' | 'connected' | 'syncing' | 'error'

export interface SelfHostedSyncStatus {
  state: SelfHostedSyncState
  deviceId: string
  lastSyncAt: number | null
  lastError: string | null
}

export interface SelfHostedSyncSnapshot {
  config: SelfHostedSyncConfig
  status: SelfHostedSyncStatus
}

export interface SelfHostedSyncTestResult {
  latestRevision: number
  serverTime: number
}

export const DEFAULT_SELF_HOSTED_SYNC_CATEGORIES: SelfHostedSyncCategoryToggles = {
  chats: true,
  assistants: true,
  providers: true,
  mcp: true,
  settings: true,
  files: true,
  knowledge: true
}
