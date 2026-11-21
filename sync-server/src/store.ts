import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A change submitted by a client device. `updatedAt` is a UTC epoch in milliseconds. */
export interface IncomingChange {
  entityKey: string
  category: string
  updatedAt: number
  deleted: boolean
  data: unknown
}

/** A stored record as returned to clients. Deleted records are tombstones with `data: null`. */
export interface SyncRecord {
  revision: number
  entityKey: string
  category: string
  updatedAt: number
  deviceId: string
  deleted: boolean
  data: unknown
}

export type PushStatus = 'accepted' | 'rejected' | 'merged'

export interface PushResult {
  entityKey: string
  status: PushStatus
  revision: number
  /** The winning server record, returned when the incoming change lost LWW. */
  current?: SyncRecord
}

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  firstSeenAt: number
  lastSeenAt: number
}

interface RecordRow {
  revision: number
  entity_key: string
  category: string
  updated_at: number
  device_id: string
  deleted: number
  data: string | null
}

/**
 * Entity-level Last-Write-Wins ordering: newer UTC timestamp wins, ties are broken
 * deterministically by comparing device ids so every replica converges.
 */
export function compareVersions(
  a: { updatedAt: number; deviceId: string },
  b: { updatedAt: number; deviceId: string }
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
  if (a.deviceId === b.deviceId) return 0
  return a.deviceId < b.deviceId ? -1 : 1
}

function toRecord(row: RecordRow): SyncRecord {
  return {
    revision: row.revision,
    entityKey: row.entity_key,
    category: row.category,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    deleted: row.deleted === 1,
    data: row.deleted === 1 || row.data === null ? null : JSON.parse(row.data)
  }
}

export class SyncStore {
  private readonly db: DatabaseSync

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(dataDir, 'sync.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        entity_key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        revision INTEGER NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS records_category_revision_idx ON records (category, revision);
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', 0);
    `)
  }

  close(): void {
    this.db.close()
  }

  latestRevision(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'revision'`).get() as { value: number }
    return row.value
  }

  touchDevice(deviceId: string, deviceName: string): DeviceInfo {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO devices (device_id, device_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET device_name = excluded.device_name, last_seen_at = excluded.last_seen_at`
      )
      .run(deviceId, deviceName, now, now)
    const row = this.db
      .prepare(`SELECT device_id, device_name, first_seen_at, last_seen_at FROM devices WHERE device_id = ?`)
      .get(deviceId) as { device_id: string; device_name: string; first_seen_at: number; last_seen_at: number }
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    }
  }

  getRecord(entityKey: string): SyncRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM records WHERE entity_key = ?`).get(entityKey) as RecordRow | undefined
    return row ? toRecord(row) : undefined
  }

  /** Records with a revision greater than `since`, optionally limited to categories, in revision order. */
  changesSince(
    since: number,
    categories: string[] | null,
    limit: number
  ): { changes: SyncRecord[]; hasMore: boolean; latestRevision: number } {
    const params: Array<string | number> = [since]
    let sql = `SELECT * FROM records WHERE revision > ?`
    if (categories) {
      if (categories.length === 0) return { changes: [], hasMore: false, latestRevision: this.latestRevision() }
      sql += ` AND category IN (${categories.map(() => '?').join(', ')})`
      params.push(...categories)
    }
    sql += ` ORDER BY revision ASC LIMIT ?`
    params.push(limit + 1)
    const rows = this.db.prepare(sql).all(...params) as unknown as RecordRow[]
    const hasMore = rows.length > limit
    return {
      changes: rows.slice(0, limit).map(toRecord),
      hasMore,
      latestRevision: this.latestRevision()
    }
  }

  /** Applies a batch atomically: every change is resolved with LWW and accepted ones get a fresh revision. */
  push(deviceId: string, changes: IncomingChange[]): { results: PushResult[]; latestRevision: number } {
    const results: PushResult[] = []
    const selectStmt = this.db.prepare(`SELECT * FROM records WHERE entity_key = ?`)
    const upsertStmt = this.db.prepare(
      `INSERT INTO records (entity_key, category, revision, updated_at, device_id, deleted, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_key) DO UPDATE SET
         category = excluded.category, revision = excluded.revision, updated_at = excluded.updated_at,
         device_id = excluded.device_id, deleted = excluded.deleted, data = excluded.data`
    )
    let revision = this.latestRevision()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const change of changes) {
        const data = change.deleted ? null : JSON.stringify(change.data ?? null)
        const existingRow = selectStmt.get(change.entityKey) as RecordRow | undefined
        if (existingRow) {
          const existing = toRecord(existingRow)
          const sameContent = existingRow.deleted === (change.deleted ? 1 : 0) && existingRow.data === data
          if (sameContent) {
            results.push({ entityKey: change.entityKey, status: 'merged', revision: existing.revision })
            continue
          }
          const order = compareVersions({ updatedAt: change.updatedAt, deviceId }, existing)
          if (order < 0 || (order === 0 && existing.deviceId !== deviceId)) {
            results.push({
              entityKey: change.entityKey,
              status: 'rejected',
              revision: existing.revision,
              current: existing
            })
            continue
          }
        }
        revision += 1
        upsertStmt.run(
          change.entityKey,
          change.category,
          revision,
          change.updatedAt,
          deviceId,
          change.deleted ? 1 : 0,
          data
        )
        results.push({ entityKey: change.entityKey, status: 'accepted', revision })
      }
      this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'revision'`).run(revision)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { results, latestRevision: revision }
  }
}
