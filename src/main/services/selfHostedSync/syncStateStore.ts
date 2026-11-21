import Database from 'better-sqlite3'

import {
  DEFAULT_SELF_HOSTED_SYNC_CATEGORIES,
  SELF_HOSTED_SYNC_CATEGORIES,
  type SelfHostedSyncCategory,
  type SelfHostedSyncConfig
} from '@shared/types/selfHostedSync'

import type { RemoteRecord } from './syncHttpClient'

export interface ShadowEntry {
  entityKey: string
  table: string
  updatedAt: number
  hash: string
}

/**
 * Local sync metadata, kept in its own SQLite file so it never touches the app database:
 * config, device id, per-category revision cursors, the shadow (last synced hash per entity,
 * from which outgoing changes and deletion tombstones are derived) and remote records that
 * could not be applied yet (e.g. a missing FK parent).
 */
export class SyncStateStore {
  private readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursor (category TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shadow (
        entity_key TEXT PRIMARY KEY,
        tbl TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shadow_tbl_idx ON shadow (tbl);
      CREATE TABLE IF NOT EXISTS pending_apply (entity_key TEXT PRIMARY KEY, record TEXT NOT NULL);
    `)
  }

  close(): void {
    this.db.close()
  }

  private getKv<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  private setKv(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  getOrCreateDeviceId(create: () => string): string {
    const existing = this.getKv<string>('deviceId')
    if (existing) return existing
    const id = create()
    this.setKv('deviceId', id)
    return id
  }

  getConfig(defaultDeviceName: string): SelfHostedSyncConfig {
    const stored = this.getKv<Partial<SelfHostedSyncConfig>>('config') ?? {}
    return {
      enabled: stored.enabled ?? false,
      serverUrl: stored.serverUrl ?? '',
      authToken: stored.authToken ?? '',
      deviceName: stored.deviceName || defaultDeviceName,
      categories: { ...DEFAULT_SELF_HOSTED_SYNC_CATEGORIES, ...stored.categories }
    }
  }

  setConfig(config: SelfHostedSyncConfig): void {
    this.setKv('config', config)
  }

  getLastSyncAt(): number | null {
    return this.getKv<number>('lastSyncAt') ?? null
  }

  setLastSyncAt(value: number): void {
    this.setKv('lastSyncAt', value)
  }

  /** Server identity the cursors belong to; switching servers resets every cursor and the shadow. */
  bindServer(serverUrl: string): void {
    if (this.getKv<string>('boundServerUrl') === serverUrl) return
    this.db.transaction(() => {
      this.db.exec('DELETE FROM cursor; DELETE FROM shadow; DELETE FROM pending_apply;')
      this.setKv('boundServerUrl', serverUrl)
    })()
  }

  getCursor(category: SelfHostedSyncCategory): number {
    const row = this.db.prepare('SELECT revision FROM cursor WHERE category = ?').get(category) as
      | { revision: number }
      | undefined
    return row?.revision ?? 0
  }

  getCursors(): Record<SelfHostedSyncCategory, number> {
    return Object.fromEntries(SELF_HOSTED_SYNC_CATEGORIES.map((c) => [c, this.getCursor(c)])) as Record<
      SelfHostedSyncCategory,
      number
    >
  }

  setCursors(categories: Iterable<SelfHostedSyncCategory>, revision: number): void {
    const stmt = this.db.prepare(
      'INSERT INTO cursor (category, revision) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET revision = MAX(revision, excluded.revision)'
    )
    this.db.transaction(() => {
      for (const category of categories) stmt.run(category, revision)
    })()
  }

  /** A re-enabled category starts from scratch so it receives everything it missed while disabled. */
  resetCategory(category: SelfHostedSyncCategory, tables: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cursor WHERE category = ?').run(category)
      const stmt = this.db.prepare('DELETE FROM shadow WHERE tbl = ?')
      for (const table of tables) stmt.run(table)
    })()
  }

  getShadowForTable(table: string): Map<string, ShadowEntry> {
    const rows = this.db.prepare('SELECT entity_key, tbl, updated_at, hash FROM shadow WHERE tbl = ?').all(table) as Array<{
      entity_key: string
      tbl: string
      updated_at: number
      hash: string
    }>
    return new Map(
      rows.map((r) => [r.entity_key, { entityKey: r.entity_key, table: r.tbl, updatedAt: r.updated_at, hash: r.hash }])
    )
  }

  getShadow(entityKey: string): ShadowEntry | undefined {
    const row = this.db.prepare('SELECT entity_key, tbl, updated_at, hash FROM shadow WHERE entity_key = ?').get(entityKey) as
      | { entity_key: string; tbl: string; updated_at: number; hash: string }
      | undefined
    return row ? { entityKey: row.entity_key, table: row.tbl, updatedAt: row.updated_at, hash: row.hash } : undefined
  }

  /** `deleted` entries remove the shadow (entity is gone on both sides). */
  writeShadow(entries: Array<ShadowEntry | { entityKey: string; deleted: true }>): void {
    const upsert = this.db.prepare(
      `INSERT INTO shadow (entity_key, tbl, updated_at, hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(entity_key) DO UPDATE SET tbl = excluded.tbl, updated_at = excluded.updated_at, hash = excluded.hash`
    )
    const remove = this.db.prepare('DELETE FROM shadow WHERE entity_key = ?')
    this.db.transaction(() => {
      for (const entry of entries) {
        if ('deleted' in entry) remove.run(entry.entityKey)
        else upsert.run(entry.entityKey, entry.table, entry.updatedAt, entry.hash)
      }
    })()
  }

  getPendingApply(): RemoteRecord[] {
    const rows = this.db.prepare('SELECT record FROM pending_apply').all() as Array<{ record: string }>
    return rows.map((r) => JSON.parse(r.record) as RemoteRecord)
  }

  replacePendingApply(resolved: string[], deferred: RemoteRecord[]): void {
    const remove = this.db.prepare('DELETE FROM pending_apply WHERE entity_key = ?')
    const upsert = this.db.prepare(
      'INSERT INTO pending_apply (entity_key, record) VALUES (?, ?) ON CONFLICT(entity_key) DO UPDATE SET record = excluded.record'
    )
    this.db.transaction(() => {
      for (const key of resolved) remove.run(key)
      for (const record of deferred) upsert.run(record.entityKey, JSON.stringify(record))
    })()
  }
}
