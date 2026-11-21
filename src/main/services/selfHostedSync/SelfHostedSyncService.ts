import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { sql } from 'drizzle-orm'

import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { loggerService } from '@logger'
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { DataApiDataChangeEffect } from '@shared/data/api/types'
import { DefaultPreferences } from '@shared/data/preference/preferenceSchemas'
import type { UnifiedPreferenceType } from '@shared/data/preference/preferenceTypes'
import {
  SELF_HOSTED_SYNC_CATEGORIES,
  type SelfHostedSyncCategory,
  type SelfHostedSyncConfig,
  type SelfHostedSyncSnapshot,
  type SelfHostedSyncState,
  type SelfHostedSyncStatus,
  type SelfHostedSyncTestResult
} from '@shared/types/selfHostedSync'

import { type ApplySummary, type FileLocations, SyncEngine } from './SyncEngine'
import { normalizeServerUrl, SyncHttpClient } from './syncHttpClient'
import { SyncStateStore } from './syncStateStore'
import { SYNC_TABLES } from './syncTables'

const logger = loggerService.withContext('SelfHostedSyncService')

const CHANGE_WATCH_INTERVAL_MS = 2_000
const PUSH_DEBOUNCE_MS = 3_000
const PUSH_MAX_WAIT_MS = 30_000
const POLL_CHECK_INTERVAL_MS = 15_000
const POLL_INTERVAL_CONNECTED_MS = 5 * 60_000
const POLL_INTERVAL_DISCONNECTED_MS = 60_000
const LIVE_PULL_DEBOUNCE_MS = 500
const RECONNECT_MIN_MS = 5_000
const RECONNECT_MAX_MS = 60_000
const MAX_BLOB_BYTES = 1024 * 1024 * 1024

type CycleMode = 'pull' | 'push' | 'full'

/** Renderer read models to revalidate after remote rows land in a table. */
const TABLE_EFFECTS: Partial<Record<string, DataApiDataChangeEffect[]>> = {
  user_provider: [{ endpoint: '/providers', kind: 'membership' }],
  user_model: [{ endpoint: '/models', kind: 'membership' }],
  mcp_server: [{ endpoint: '/mcp-servers', kind: 'membership' }],
  group: [{ endpoint: '/groups', kind: 'membership' }],
  assistant: [{ endpoint: '/assistants', kind: 'membership' }],
  agent: [{ endpoint: '/agents', kind: 'membership' }],
  prompt: [{ endpoint: '/prompts', kind: 'membership' }],
  prompt_binding: [{ endpoint: '/prompt-bindings', kind: 'membership' }],
  knowledge_base: [{ endpoint: '/knowledge-bases', kind: 'membership' }],
  knowledge_item: [{ endpoint: '/knowledge-bases/:id/items', kind: 'membership' }],
  topic: [{ endpoint: '/topics', kind: 'membership' }],
  message: [{ endpoint: '/topics/:topicId/messages', kind: 'membership' }]
}

/**
 * Self-hosted multi-device sync. Owns the sync state file, the background schedule
 * (debounced push on local writes, live pull over SSE, periodic fallback polling)
 * and serializes every sync cycle.
 */
@Injectable('SelfHostedSyncService')
@ServicePhase(Phase.WhenReady)
export class SelfHostedSyncService extends BaseService {
  private store: SyncStateStore | null = null
  private deviceId = ''
  private engine: SyncEngine | null = null
  private client: SyncHttpClient | null = null
  private state: SelfHostedSyncState = 'disabled'
  private lastError: string | null = null
  private streamConnected = false
  private streamAbort: AbortController | null = null
  private activeCycle: Promise<void> | null = null
  private queuedMode: CycleMode | null = null
  private pushTimer: NodeJS.Timeout | null = null
  private pushDeadline = 0
  private livePullTimer: NodeJS.Timeout | null = null
  private lastPollAt = 0
  private lastTotalChanges = -1
  private running = false

  protected override onInit(): void {
    this.store = new SyncStateStore(application.getPath('feature.self_hosted_sync.data', 'sync-state.sqlite'))
    this.deviceId = this.store.getOrCreateDeviceId(() => randomUUID())
    this.registerInterval(() => this.watchLocalChanges(), CHANGE_WATCH_INTERVAL_MS)
    this.registerInterval(() => this.pollIfDue(), POLL_CHECK_INTERVAL_MS)
  }

  protected override onReady(): void {
    this.restart()
  }

  protected override async onStop(): Promise<void> {
    this.deactivate()
    await this.activeCycle
  }

  protected override onDestroy(): void {
    this.store?.close()
    this.store = null
  }

  // ─── Public API (IPC) ───

  getSnapshot(): SelfHostedSyncSnapshot {
    return { config: this.getConfig(), status: this.getStatus() }
  }

  updateConfig(
    patch: Partial<Omit<SelfHostedSyncConfig, 'categories'>> & {
      categories?: Partial<Record<SelfHostedSyncCategory, boolean>>
    }
  ): SelfHostedSyncSnapshot {
    const previous = this.getConfig()
    const next: SelfHostedSyncConfig = {
      ...previous,
      ...patch,
      serverUrl: patch.serverUrl !== undefined ? patch.serverUrl.trim() : previous.serverUrl,
      authToken: patch.authToken !== undefined ? patch.authToken.trim() : previous.authToken,
      categories: { ...previous.categories, ...patch.categories }
    }
    for (const category of SELF_HOSTED_SYNC_CATEGORIES) {
      if (!previous.categories[category] && next.categories[category]) {
        this.requireStore().resetCategory(
          category,
          SYNC_TABLES.filter((s) => s.category === category).map((s) => s.table)
        )
      }
    }
    this.requireStore().setConfig(next)

    const connectionChanged =
      previous.enabled !== next.enabled ||
      previous.serverUrl !== next.serverUrl ||
      previous.authToken !== next.authToken ||
      previous.deviceName !== next.deviceName
    if (connectionChanged) this.restart()
    else if (this.running) this.requestCycle('full')
    return this.getSnapshot()
  }

  async testConnection(input: {
    serverUrl: string
    authToken: string
    deviceName: string
  }): Promise<SelfHostedSyncTestResult> {
    const client = new SyncHttpClient({
      serverUrl: input.serverUrl,
      authToken: input.authToken,
      deviceId: this.deviceId,
      deviceName: input.deviceName || os.hostname(),
      timeoutMs: 15_000
    })
    return await client.verify()
  }

  async syncNow(): Promise<SelfHostedSyncStatus> {
    if (!this.running) {
      const config = this.getConfig()
      if (!config.serverUrl || !config.authToken) throw new Error('Server URL and auth token are required')
      this.activate(config)
    }
    await this.runCycle('full')
    return this.getStatus()
  }

  // ─── Lifecycle of the active connection ───

  private requireStore(): SyncStateStore {
    if (!this.store) throw new Error('Self-hosted sync is not initialized')
    return this.store
  }

  private getConfig(): SelfHostedSyncConfig {
    return this.requireStore().getConfig(os.hostname())
  }

  private getStatus(): SelfHostedSyncStatus {
    return {
      state: this.state,
      deviceId: this.deviceId,
      lastSyncAt: this.store?.getLastSyncAt() ?? null,
      lastError: this.lastError
    }
  }

  private setState(state: SelfHostedSyncState, error: string | null = this.lastError): void {
    this.state = state
    this.lastError = error
    try {
      application.get('IpcApiService').broadcast('self_hosted_sync.status_changed', this.getStatus())
    } catch (broadcastError) {
      logger.warn('Failed to broadcast sync status', broadcastError as Error)
    }
  }

  private restart(): void {
    this.deactivate()
    const config = this.getConfig()
    if (config.enabled && config.serverUrl && config.authToken) {
      try {
        this.activate(config)
      } catch (error) {
        this.setState('error', error instanceof Error ? error.message : String(error))
        return
      }
      this.requestCycle('full')
    } else {
      this.setState('disabled', null)
    }
  }

  private activate(config: SelfHostedSyncConfig): void {
    const store = this.requireStore()
    const serverUrl = normalizeServerUrl(config.serverUrl)
    store.bindServer(serverUrl)
    this.client = new SyncHttpClient({
      serverUrl,
      authToken: config.authToken,
      deviceId: this.deviceId,
      deviceName: config.deviceName || os.hostname()
    })
    this.engine = new SyncEngine({
      db: application.get('DbService').getDb(),
      state: store,
      transport: this.client,
      deviceId: this.deviceId,
      files: this.fileLocations(),
      preferences: {
        isKnownKey: (key) => key in DefaultPreferences.default,
        apply: (values) => application.get('PreferenceService').setMultiple(values as Partial<UnifiedPreferenceType>)
      }
    })
    this.running = true
    this.lastTotalChanges = this.readTotalChanges()
    if (config.enabled) this.startEventStream()
    this.setState('idle', null)
  }

  private deactivate(): void {
    this.running = false
    this.streamAbort?.abort()
    this.streamAbort = null
    this.streamConnected = false
    this.queuedMode = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.livePullTimer) clearTimeout(this.livePullTimer)
    this.pushTimer = null
    this.livePullTimer = null
    this.engine = null
    this.client = null
  }

  private fileLocations(): FileLocations {
    const filesDir = application.getPath('feature.files.data')
    const knowledgeDir = application.getPath('feature.knowledgebase.data')
    return {
      internalFile: (id, ext) => path.join(filesDir, ext ? `${id}.${ext}` : id),
      knowledgeFile: (baseId, relativePath) => resolveKnowledgeFile(knowledgeDir, baseId, relativePath),
      maxBlobBytes: MAX_BLOB_BYTES
    }
  }

  // ─── Scheduling ───

  private readTotalChanges(): number {
    try {
      return (
        application
          .get('DbService')
          .getDb()
          .get<{ n: number }>(sql`SELECT total_changes() AS n`)?.n ?? 0
      )
    } catch {
      return this.lastTotalChanges
    }
  }

  /** `total_changes()` counts every write on the app's single connection, so no data service needs a hook. */
  private watchLocalChanges(): void {
    if (!this.running || this.activeCycle) return
    const total = this.readTotalChanges()
    if (total === this.lastTotalChanges) return
    this.lastTotalChanges = total
    this.schedulePush()
  }

  private schedulePush(): void {
    const now = Date.now()
    if (!this.pushTimer) this.pushDeadline = now + PUSH_MAX_WAIT_MS
    else clearTimeout(this.pushTimer)
    const delay = Math.max(0, Math.min(PUSH_DEBOUNCE_MS, this.pushDeadline - now))
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.requestCycle('push')
    }, delay)
  }

  private pollIfDue(): void {
    if (!this.running) return
    const interval = this.streamConnected ? POLL_INTERVAL_CONNECTED_MS : POLL_INTERVAL_DISCONNECTED_MS
    if (Date.now() - this.lastPollAt >= interval) this.requestCycle('pull')
  }

  private requestCycle(mode: CycleMode): void {
    // Failures are reflected in the status; background cycles must not reject unhandled.
    this.runCycle(mode).catch(() => undefined)
  }

  private async runCycle(mode: CycleMode): Promise<void> {
    if (this.activeCycle) {
      this.queuedMode = this.queuedMode && this.queuedMode !== mode ? 'full' : mode
      await this.activeCycle
      return
    }
    const cycle = this.executeCycle(mode)
    this.activeCycle = cycle
    try {
      await cycle
    } finally {
      this.activeCycle = null
      const queued = this.queuedMode
      this.queuedMode = null
      if (queued && this.running) this.requestCycle(queued)
    }
  }

  private idleState(): SelfHostedSyncState {
    if (!this.running) return 'disabled'
    return this.streamConnected ? 'connected' : 'idle'
  }

  private async executeCycle(mode: CycleMode): Promise<void> {
    const engine = this.engine
    if (!engine || !this.running) return
    const config = this.getConfig()
    const categories = new Set(SELF_HOSTED_SYNC_CATEGORIES.filter((c) => config.categories[c]))
    this.setState('syncing')
    try {
      let summary: ApplySummary
      if (mode === 'push') summary = await engine.push(categories)
      else if (mode === 'pull') summary = await engine.pull(categories)
      else summary = await engine.sync(categories)
      if (mode !== 'push') this.lastPollAt = Date.now()
      // Our own remote applies must not look like local edits.
      this.lastTotalChanges = this.readTotalChanges()
      this.afterRemoteApply(summary)
      this.requireStore().setLastSyncAt(Date.now())
      this.setState(this.idleState(), null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Sync cycle failed', { mode, error: message })
      this.lastTotalChanges = this.readTotalChanges()
      this.setState('error', message)
      throw error
    }
  }

  private afterRemoteApply(summary: ApplySummary): void {
    const effects = [...summary.tables].flatMap((table) => TABLE_EFFECTS[table] ?? [])
    if (effects.length > 0) notifyDataApiDataChange(effects)
    for (const [baseId, itemIds] of summary.reindex) {
      application
        .get('KnowledgeService')
        .reindexItems(baseId, itemIds)
        .catch((error: unknown) => logger.warn('Re-indexing synced knowledge items failed', { baseId, error: String(error) }))
    }
  }

  // ─── Live notifications ───

  private startEventStream(): void {
    const abort = new AbortController()
    this.streamAbort = abort
    const loop = async () => {
      let backoff = RECONNECT_MIN_MS
      while (!abort.signal.aborted && this.client) {
        try {
          await this.client.listen(
            abort.signal,
            () => {
              backoff = RECONNECT_MIN_MS
              this.streamConnected = true
              if (this.state === 'idle') this.setState('connected')
            },
            () => this.scheduleLivePull()
          )
        } catch (error) {
          if (abort.signal.aborted) return
          logger.debug('Sync event stream disconnected', { error: String(error) })
        }
        if (abort.signal.aborted) return
        this.streamConnected = false
        if (this.state === 'connected') this.setState('idle')
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      }
    }
    loop().catch((error: unknown) => logger.warn('Sync event loop stopped', { error: String(error) }))
  }

  private scheduleLivePull(): void {
    if (this.livePullTimer) return
    this.livePullTimer = setTimeout(() => {
      this.livePullTimer = null
      this.requestCycle('pull')
    }, LIVE_PULL_DEBOUNCE_MS)
  }
}

/**
 * Maps a stored POSIX knowledge path onto this OS, rejecting anything that could escape the base
 * (absolute paths, `..`, backslashes that Windows would treat as separators).
 */
export function resolveKnowledgeFile(knowledgeDir: string, baseId: string, relativePath: string): string | null {
  if (!/^[\w.-]+$/.test(baseId) || baseId === '.' || baseId === '..') return null
  if (path.posix.isAbsolute(relativePath) || relativePath.includes('\\') || /^[a-zA-Z]:/.test(relativePath)) return null
  const segments = relativePath.split('/')
  if (segments.some((s) => s === '..' || s === '' || s === '.')) return null
  return path.join(knowledgeDir, baseId, 'raw', ...segments)
}
