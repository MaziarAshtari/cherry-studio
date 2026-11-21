import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { type SQL, sql } from 'drizzle-orm'

import type { DbType } from '@data/db/types'
import { loggerService } from '@logger'
import type { SelfHostedSyncCategory } from '@shared/types/selfHostedSync'

import type { OutgoingChange, RemoteRecord, SyncTransport } from './syncHttpClient'
import type { SyncStateStore } from './syncStateStore'
import {
  GLOBAL_LOCAL_COLUMNS,
  getTableSpec,
  isSyncablePreferenceKey,
  SYNC_TABLES,
  type SyncTableSpec,
  tablesForCategories
} from './syncTables'

const logger = loggerService.withContext('SelfHostedSyncEngine')

const PUSH_BATCH_MAX_CHANGES = 200
const PUSH_BATCH_MAX_BYTES = 8 * 1024 * 1024
const FULL_ROW_SCAN_THRESHOLD = 200

export type SyncDb = Pick<DbType, 'all' | 'get' | 'run' | 'transaction'>
type Row = Record<string, unknown>

/** Payload stored on the server for one entity. `blobs` maps a logical file slot to its sha256. */
export interface EntityPayload {
  table: string
  row: Row
  blobs?: Record<string, string>
}

export interface FileLocations {
  /** Absolute path of an internal file entry's content. */
  internalFile(id: string, ext: string | null): string
  /** Absolute path of a knowledge item file, or null when the relative path is unsafe on this OS. */
  knowledgeFile(baseId: string, relativePath: string): string | null
  maxBlobBytes: number
}

export interface PreferenceApplier {
  isKnownKey(key: string): boolean
  apply(values: Record<string, unknown>): Promise<void>
}

export interface SyncEngineDeps {
  db: SyncDb
  state: SyncStateStore
  transport: SyncTransport
  deviceId: string
  files: FileLocations
  preferences?: PreferenceApplier
  now?: () => number
}

export interface ApplySummary {
  tables: Set<string>
  /** Knowledge items per base that need re-indexing on this device. */
  reindex: Map<string, string[]>
}

interface ColumnInfo {
  all: string[]
  pk: string[]
  synced: string[]
  hasUpdatedAt: boolean
}

interface ForeignKeyInfo {
  from: string
  parent: string
  to: string | null
  onDelete: string
  notNull: boolean
}

interface LocalChange extends OutgoingChange {
  table: string
  hash: string | null
  localUpdatedAt: number
}

interface ApplyOp {
  record: RemoteRecord
  spec: SyncTableSpec
  pkValues: unknown[]
  payload: EntityPayload | null
}

export function entityKeyOf(table: string, pkValues: unknown[]): string {
  return `${table}:${JSON.stringify(pkValues)}`
}

export function parseEntityKey(key: string): { table: string; pkValues: unknown[] } | null {
  const index = key.indexOf(':')
  if (index <= 0) return null
  try {
    const pkValues = JSON.parse(key.slice(index + 1)) as unknown
    return Array.isArray(pkValues) ? { table: key.slice(0, index), pkValues } : null
  } catch {
    return null
  }
}

function compareVersions(a: { updatedAt: number; deviceId: string }, b: { updatedAt: number; deviceId: string }) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
  if (a.deviceId === b.deviceId) return 0
  return a.deviceId < b.deviceId ? -1 : 1
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function writeFileAtomic(filePath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.sync-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, filePath)
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

const id = (name: string) => sql.identifier(name)
const joinIds = (names: string[]) =>
  sql.join(
    names.map((n) => id(n)),
    sql`, `
  )

/**
 * Self-hosted sync engine. Local changes are derived by diffing synced tables against a shadow of
 * the last synced content hash per entity, so upstream data services need no change hooks.
 * Remote changes are resolved per entity with LWW and applied in one transaction per page.
 */
export class SyncEngine {
  private readonly columnCache = new Map<string, ColumnInfo>()
  private readonly fkCache = new Map<string, ForeignKeyInfo[]>()
  private readonly now: () => number

  constructor(private readonly deps: SyncEngineDeps) {
    this.now = deps.now ?? Date.now
  }

  // ─── Schema introspection ───

  private columns(spec: SyncTableSpec): ColumnInfo {
    const cached = this.columnCache.get(spec.table)
    if (cached) return cached
    const info = this.deps.db.all<{ name: string; pk: number; notnull: number }>(
      sql`SELECT name, pk, "notnull" FROM pragma_table_info(${spec.table})`
    )
    if (info.length === 0) throw new Error(`Synced table "${spec.table}" does not exist`)
    const local = new Set([...GLOBAL_LOCAL_COLUMNS, ...(spec.localColumns ?? [])])
    const result: ColumnInfo = {
      all: info.map((c) => c.name),
      pk: info
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
      synced: info.map((c) => c.name).filter((name) => !local.has(name)),
      hasUpdatedAt: info.some((c) => c.name === 'updated_at')
    }
    this.columnCache.set(spec.table, result)
    return result
  }

  private foreignKeys(table: string): ForeignKeyInfo[] {
    const cached = this.fkCache.get(table)
    if (cached) return cached
    const notNull = new Set(
      this.deps.db
        .all<{ name: string; notnull: number }>(sql`SELECT name, "notnull" FROM pragma_table_info(${table})`)
        .filter((c) => c.notnull === 1)
        .map((c) => c.name)
    )
    const fks = this.deps.db
      .all<{
        table: string
        from: string
        to: string | null
        on_delete: string
      }>(sql`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(${table})`)
      .map((fk) => ({ from: fk.from, parent: fk.table, to: fk.to, onDelete: fk.on_delete, notNull: notNull.has(fk.from) }))
    this.fkCache.set(table, fks)
    return fks
  }

  // ─── Row helpers ───

  private hashRow(spec: SyncTableSpec, row: Row, blobs?: Record<string, string>): string {
    const cols = this.columns(spec)
    const entries = cols.synced
      .filter((c) => c !== 'updated_at' && c in row)
      .sort()
      .map((c) => [c, row[c]])
    return sha256(JSON.stringify({ entries, blobs: blobs ? Object.entries(blobs).sort() : [] }))
  }

  private pickSynced(spec: SyncTableSpec, row: Row): Row {
    const out: Row = {}
    for (const c of this.columns(spec).synced) {
      const value = row[c]
      out[c] = Buffer.isBuffer(value) ? { __b64: value.toString('base64') } : value
    }
    return out
  }

  private pkWhere(pk: string[], values: unknown[]): SQL {
    return sql.join(
      pk.map((c, i) => sql`${id(c)} = ${values[i] as string | number | null}`),
      sql` AND `
    )
  }

  private readRow(spec: SyncTableSpec, pkValues: unknown[]): Row | undefined {
    const cols = this.columns(spec)
    return this.deps.db.get<Row>(sql`SELECT * FROM ${id(spec.table)} WHERE ${this.pkWhere(cols.pk, pkValues)}`)
  }

  private isSkippedRow(spec: SyncTableSpec, row: Row): boolean {
    return spec.kind === 'preference' && (row.scope !== 'default' || !isSyncablePreferenceKey(String(row.key)))
  }

  // ─── Blob slots (files and knowledge material) ───

  private async collectBlobs(spec: SyncTableSpec, row: Row): Promise<Map<string, string> | null> {
    const { files } = this.deps
    const slots = new Map<string, string>()
    if (spec.kind === 'file_entry') {
      const filePath =
        row.origin === 'internal'
          ? files.internalFile(String(row.id), (row.ext as string | null) ?? null)
          : String(row.external_path ?? '')
      if (filePath && (await fileExists(filePath))) slots.set('content', filePath)
      else if (row.origin === 'internal' && row.deleted_at == null) return null
    } else if (spec.kind === 'knowledge_item' && row.type === 'file') {
      const data = typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : {}
      for (const slot of ['relativePath', 'indexedRelativePath']) {
        const rel = data[slot]
        if (typeof rel !== 'string') continue
        const filePath = files.knowledgeFile(String(row.base_id), rel)
        if (filePath && (await fileExists(filePath))) slots.set(rel, filePath)
      }
    }
    return slots
  }

  private async hashBlobs(slots: Map<string, string>): Promise<{ blobs: Record<string, string>; contents: Map<string, Buffer> }> {
    const blobs: Record<string, string> = {}
    const contents = new Map<string, Buffer>()
    for (const [slot, filePath] of slots) {
      const stat = await fs.stat(filePath)
      if (stat.size > this.deps.files.maxBlobBytes) {
        logger.warn('Skipping oversized file for sync', { filePath, size: stat.size })
        continue
      }
      const content = await fs.readFile(filePath)
      const digest = sha256(content)
      blobs[slot] = digest
      contents.set(digest, content)
    }
    return { blobs, contents }
  }

  // ─── Local change detection ───

  async scanLocalChanges(
    categories: ReadonlySet<SelfHostedSyncCategory>
  ): Promise<{ changes: LocalChange[]; blobContents: Map<string, Buffer> }> {
    const changes: LocalChange[] = []
    const blobContents = new Map<string, Buffer>()
    const shadowTouches: Array<{ entityKey: string; table: string; updatedAt: number; hash: string }> = []

    for (const spec of tablesForCategories(categories)) {
      const cols = this.columns(spec)
      const shadow = this.deps.state.getShadowForTable(spec.table)
      const seen = new Set<string>()
      let fullRows: Row[]

      if (cols.hasUpdatedAt) {
        const light = this.deps.db.all<Row>(
          sql`SELECT ${joinIds([...cols.pk, 'updated_at', ...(spec.kind === 'preference' ? ['scope', 'key'] : [])])} FROM ${id(spec.table)}`
        )
        const candidates: Row[] = []
        for (const row of light) {
          if (this.isSkippedRow(spec, row)) continue
          const key = entityKeyOf(spec.table, cols.pk.map((c) => row[c]))
          seen.add(key)
          const known = shadow.get(key)
          if (!known || known.updatedAt !== toNumber(row.updated_at)) candidates.push(row)
        }
        if (candidates.length > FULL_ROW_SCAN_THRESHOLD) {
          const wanted = new Set(candidates.map((row) => entityKeyOf(spec.table, cols.pk.map((c) => row[c]))))
          fullRows = this.deps.db
            .all<Row>(sql`SELECT * FROM ${id(spec.table)}`)
            .filter((row) => wanted.has(entityKeyOf(spec.table, cols.pk.map((c) => row[c]))))
        } else {
          fullRows = candidates
            .map((row) => this.readRow(spec, cols.pk.map((c) => row[c])))
            .filter((row): row is Row => !!row)
        }
      } else {
        fullRows = this.deps.db.all<Row>(sql`SELECT * FROM ${id(spec.table)}`).filter((row) => !this.isSkippedRow(spec, row))
        for (const row of fullRows) seen.add(entityKeyOf(spec.table, cols.pk.map((c) => row[c])))
      }

      for (const row of fullRows) {
        const key = entityKeyOf(spec.table, cols.pk.map((c) => row[c]))
        const slots = await this.collectBlobs(spec, row)
        if (slots === null) continue // content not on disk yet; retry on the next scan
        const { blobs, contents } = await this.hashBlobs(slots)
        const hasBlobs = Object.keys(blobs).length > 0
        const hash = this.hashRow(spec, row, hasBlobs ? blobs : undefined)
        const known = shadow.get(key)
        const rowUpdatedAt = cols.hasUpdatedAt ? toNumber(row.updated_at) : this.now()
        if (known?.hash === hash) {
          if (known.updatedAt !== rowUpdatedAt) shadowTouches.push({ entityKey: key, table: spec.table, updatedAt: rowUpdatedAt, hash })
          continue
        }
        for (const [digest, content] of contents) blobContents.set(digest, content)
        const payload: EntityPayload = { table: spec.table, row: this.pickSynced(spec, row), ...(hasBlobs ? { blobs } : {}) }
        changes.push({
          entityKey: key,
          category: spec.category,
          table: spec.table,
          updatedAt: Math.max(rowUpdatedAt, (known?.updatedAt ?? 0) + 1),
          localUpdatedAt: rowUpdatedAt,
          deleted: false,
          data: payload,
          hash
        })
      }

      if (spec.kind === 'preference') continue // preference rows are never deleted, only reset
      for (const [key, known] of shadow) {
        if (seen.has(key)) continue
        const at = Math.max(this.now(), known.updatedAt + 1)
        changes.push({
          entityKey: key,
          category: spec.category,
          table: spec.table,
          updatedAt: at,
          localUpdatedAt: at,
          deleted: true,
          data: null,
          hash: null
        })
      }
    }

    if (shadowTouches.length > 0) this.deps.state.writeShadow(shadowTouches)
    return { changes, blobContents }
  }

  // ─── Push ───

  async push(categories: ReadonlySet<SelfHostedSyncCategory>): Promise<ApplySummary> {
    const summary: ApplySummary = { tables: new Set(), reindex: new Map() }
    const { changes, blobContents } = await this.scanLocalChanges(categories)
    if (changes.length === 0) return summary

    for (const [digest, content] of blobContents) {
      if (!(await this.deps.transport.hasBlob(digest))) await this.deps.transport.uploadBlob(digest, content)
    }

    const byKey = new Map(changes.map((c) => [c.entityKey, c]))
    for (const batch of this.batches(changes)) {
      const { results } = await this.deps.transport.push(
        batch.map(({ entityKey, category, updatedAt, deleted, data }) => ({ entityKey, category, updatedAt, deleted, data }))
      )
      const shadowWrites: Parameters<SyncStateStore['writeShadow']>[0] = []
      const rejected: RemoteRecord[] = []
      for (const result of results) {
        const change = byKey.get(result.entityKey)
        if (!change) continue
        if (result.status === 'rejected') {
          if (result.current) rejected.push(result.current)
          continue
        }
        if (change.deleted) shadowWrites.push({ entityKey: change.entityKey, deleted: true })
        else
          shadowWrites.push({
            entityKey: change.entityKey,
            table: change.table,
            updatedAt: change.localUpdatedAt,
            hash: change.hash!
          })
      }
      this.deps.state.writeShadow(shadowWrites)
      if (rejected.length > 0) this.mergeSummary(summary, await this.applyRecords(rejected, categories))
    }
    logger.info('Pushed local changes', { count: changes.length })
    return summary
  }

  private *batches(changes: LocalChange[]): Generator<LocalChange[]> {
    let batch: LocalChange[] = []
    let bytes = 0
    for (const change of changes) {
      const size = JSON.stringify(change.data ?? null).length
      if (batch.length > 0 && (batch.length >= PUSH_BATCH_MAX_CHANGES || bytes + size > PUSH_BATCH_MAX_BYTES)) {
        yield batch
        batch = []
        bytes = 0
      }
      batch.push(change)
      bytes += size
    }
    if (batch.length > 0) yield batch
  }

  // ─── Pull ───

  async pull(categories: ReadonlySet<SelfHostedSyncCategory>): Promise<ApplySummary> {
    const summary: ApplySummary = { tables: new Set(), reindex: new Map() }
    const enabled = [...categories]
    if (enabled.length === 0) return summary

    const pending = this.deps.state.getPendingApply().filter((r) => categories.has(r.category))
    if (pending.length > 0) this.mergeSummary(summary, await this.applyRecords(pending, categories, true))

    const cursors = this.deps.state.getCursors()
    let since = Math.min(...enabled.map((c) => cursors[c]))
    while (true) {
      const page = await this.deps.transport.getChanges(since, enabled)
      const fresh = page.changes.filter((r) => categories.has(r.category) && r.revision > cursors[r.category])
      if (fresh.length > 0) this.mergeSummary(summary, await this.applyRecords(fresh, categories))
      const reached = page.hasMore ? page.changes[page.changes.length - 1].revision : page.latestRevision
      this.deps.state.setCursors(enabled, reached)
      if (!page.hasMore) break
      since = reached
    }
    return summary
  }

  async sync(categories: ReadonlySet<SelfHostedSyncCategory>): Promise<ApplySummary> {
    const summary = await this.pull(categories)
    this.mergeSummary(summary, await this.push(categories))
    return summary
  }

  private mergeSummary(target: ApplySummary, source: ApplySummary): void {
    for (const table of source.tables) target.tables.add(table)
    for (const [baseId, ids] of source.reindex) target.reindex.set(baseId, [...(target.reindex.get(baseId) ?? []), ...ids])
  }

  // ─── Apply remote records ───

  async applyRecords(
    records: RemoteRecord[],
    categories: ReadonlySet<SelfHostedSyncCategory>,
    fromPending = false
  ): Promise<ApplySummary> {
    const summary: ApplySummary = { tables: new Set(), reindex: new Map() }
    const ops: ApplyOp[] = []
    const shadowWrites: Parameters<SyncStateStore['writeShadow']>[0] = []
    const resolved: string[] = []

    // Latest record per entity wins within a batch.
    const latest = new Map<string, RemoteRecord>()
    for (const record of records) latest.set(record.entityKey, record)

    for (const record of latest.values()) {
      const parsed = parseEntityKey(record.entityKey)
      const spec = parsed ? getTableSpec(parsed.table) : undefined
      if (!parsed || !spec || spec.category !== record.category || !categories.has(spec.category)) {
        if (fromPending) resolved.push(record.entityKey)
        continue
      }
      const payload = record.deleted ? null : (record.data as EntityPayload)
      if (payload && (!payload.row || typeof payload.row !== 'object')) continue
      if (spec.kind === 'preference' && (record.deleted || !isSyncablePreferenceKey(String(parsed.pkValues[1])))) {
        resolved.push(record.entityKey)
        continue
      }

      const local = this.readRow(spec, parsed.pkValues)
      const localBlobs = local ? await this.localBlobDigests(spec, local) : undefined
      const localHash = local ? this.hashRow(spec, local, localBlobs) : null
      const remoteHash = payload ? this.hashRow(spec, payload.row, payload.blobs) : null
      const shadow = this.deps.state.getShadow(record.entityKey)

      if (localHash === remoteHash) {
        resolved.push(record.entityKey)
        if (local && localHash)
          shadowWrites.push({
            entityKey: record.entityKey,
            table: spec.table,
            updatedAt: this.columns(spec).hasUpdatedAt ? toNumber(local.updated_at) : record.updatedAt,
            hash: localHash
          })
        else shadowWrites.push({ entityKey: record.entityKey, deleted: true })
        continue
      }

      const localDirty = shadow ? localHash !== shadow.hash : localHash !== null
      if (localDirty) {
        const localTs = local
          ? Math.max(toNumber(local.updated_at ?? 0), (shadow?.updatedAt ?? 0) + 1)
          : Math.max(this.now(), (shadow?.updatedAt ?? 0) + 1)
        if (compareVersions({ updatedAt: localTs, deviceId: this.deps.deviceId }, record) > 0) {
          resolved.push(record.entityKey)
          continue // local edit is newer; the next push wins on the server
        }
      }
      ops.push({ record, spec, pkValues: parsed.pkValues, payload })
    }

    await this.materializeBlobs(ops)

    const preferenceOps = ops.filter((op) => op.spec.kind === 'preference')
    const rowOps = ops.filter((op) => op.spec.kind !== 'preference')
    const applied: ApplyOp[] = []
    const deferred: RemoteRecord[] = []

    if (rowOps.length > 0) {
      this.deps.db.transaction((tx) => {
        // Multi-pass with per-row savepoints: FK parents may arrive later in the same batch.
        let remaining = this.orderOps(rowOps)
        let nullDangling = false
        while (remaining.length > 0) {
          const failed: ApplyOp[] = []
          for (const op of remaining) {
            try {
              tx.transaction((savepoint) => this.writeOp(savepoint, op, nullDangling))
              applied.push(op)
            } catch (error) {
              failed.push(op)
              if (nullDangling) {
                logger.warn('Deferring remote change', { entityKey: op.record.entityKey, error: String(error) })
              }
            }
          }
          if (failed.length === 0) break
          if (failed.length === remaining.length) {
            if (nullDangling) {
              deferred.push(...failed.map((op) => op.record))
              break
            }
            nullDangling = true
          }
          remaining = failed
        }
      })
    }

    if (preferenceOps.length > 0) {
      const values: Record<string, unknown> = {}
      for (const op of preferenceOps) {
        const key = String(op.pkValues[1])
        if (this.deps.preferences && !this.deps.preferences.isKnownKey(key)) continue
        values[key] = typeof op.payload!.row.value === 'string' ? JSON.parse(op.payload!.row.value) : op.payload!.row.value
      }
      if (this.deps.preferences) await this.deps.preferences.apply(values)
      else
        this.deps.db.transaction((tx) => {
          for (const op of preferenceOps) this.writeOp(tx, op, true)
        })
      applied.push(...preferenceOps)
    }

    for (const op of applied) {
      resolved.push(op.record.entityKey)
      summary.tables.add(op.spec.table)
      const row = this.readRow(op.spec, op.pkValues)
      if (!row) {
        shadowWrites.push({ entityKey: op.record.entityKey, deleted: true })
        continue
      }
      shadowWrites.push({
        entityKey: op.record.entityKey,
        table: op.spec.table,
        updatedAt: this.columns(op.spec).hasUpdatedAt ? toNumber(row.updated_at) : op.record.updatedAt,
        hash: this.hashRow(op.spec, row, await this.localBlobDigests(op.spec, row))
      })
      if (op.spec.kind === 'knowledge_item' && row.type !== 'directory') {
        const baseId = String(row.base_id)
        summary.reindex.set(baseId, [...(summary.reindex.get(baseId) ?? []), String(row.id)])
      }
    }

    this.deps.state.writeShadow(shadowWrites)
    this.deps.state.replacePendingApply(
      resolved.filter((key) => !deferred.some((r) => r.entityKey === key)),
      deferred
    )
    if (applied.length > 0) logger.info('Applied remote changes', { applied: applied.length, deferred: deferred.length })
    return summary
  }

  private orderOps(ops: ApplyOp[]): ApplyOp[] {
    const tableIndex = (table: string) => SYNC_TABLES.findIndex((s) => s.table === table)
    const upserts = ops.filter((op) => op.payload).sort((a, b) => tableIndex(a.spec.table) - tableIndex(b.spec.table))
    const deletes = ops.filter((op) => !op.payload).sort((a, b) => tableIndex(b.spec.table) - tableIndex(a.spec.table))
    return [...upserts, ...deletes]
  }

  private writeOp(tx: Pick<DbType, 'run' | 'get'>, op: ApplyOp, nullDanglingRefs: boolean): void {
    const cols = this.columns(op.spec)
    if (!op.payload) {
      tx.run(sql`DELETE FROM ${id(op.spec.table)} WHERE ${this.pkWhere(cols.pk, op.pkValues)}`)
      return
    }
    const row: Row = {}
    for (const c of cols.synced) {
      if (!(c in op.payload.row)) continue
      const value = op.payload.row[c]
      row[c] =
        value && typeof value === 'object' && '__b64' in (value as Row)
          ? Buffer.from(String((value as Row).__b64), 'base64')
          : value
    }
    if (op.spec.kind === 'knowledge_item') {
      row.status = row.type === 'directory' ? 'completed' : 'idle'
      row.error = null
    }
    if (nullDanglingRefs) this.nullDanglingReferences(tx, op.spec.table, row)

    const names = Object.keys(row)
    const updatable = names.filter((n) => !cols.pk.includes(n))
    const values = sql.join(
      names.map((n) => sql`${row[n] as string | number | null}`),
      sql`, `
    )
    const conflict =
      updatable.length > 0
        ? sql`DO UPDATE SET ${sql.join(
            updatable.map((n) => sql`${id(n)} = excluded.${id(n)}`),
            sql`, `
          )}`
        : sql`DO NOTHING`
    tx.run(
      sql`INSERT INTO ${id(op.spec.table)} (${joinIds(names)}) VALUES (${values}) ON CONFLICT (${joinIds(cols.pk)}) ${conflict}`
    )
  }

  /** Optional references to rows this device does not have (e.g. a model from a disabled category) become NULL. */
  private nullDanglingReferences(tx: Pick<DbType, 'get'>, table: string, row: Row): void {
    for (const fk of this.foreignKeys(table)) {
      const value = row[fk.from]
      if (value === null || value === undefined || fk.notNull || fk.onDelete !== 'SET NULL') continue
      const parentPk = fk.to ?? 'rowid'
      const exists = tx.get(sql`SELECT 1 AS ok FROM ${id(fk.parent)} WHERE ${id(parentPk)} = ${value as string | number}`)
      if (!exists) row[fk.from] = null
    }
  }

  private async localBlobDigests(spec: SyncTableSpec, row: Row): Promise<Record<string, string> | undefined> {
    if (spec.kind !== 'file_entry' && spec.kind !== 'knowledge_item') return undefined
    const slots = await this.collectBlobs(spec, row)
    if (!slots || slots.size === 0) return undefined
    const { blobs } = await this.hashBlobs(slots)
    return Object.keys(blobs).length > 0 ? blobs : undefined
  }

  /**
   * Downloads blob content before the DB transaction so a failed download never leaves a row
   * pointing at missing content. External files whose path does not exist on this OS are
   * localized into internal storage.
   */
  private async materializeBlobs(ops: ApplyOp[]): Promise<void> {
    for (const op of ops) {
      const payload = op.payload
      if (!payload?.blobs) continue
      const row = payload.row
      if (op.spec.kind === 'file_entry') {
        const digest = payload.blobs.content
        if (!digest) continue
        if (row.origin === 'external' && typeof row.external_path === 'string' && (await fileExists(row.external_path)))
          continue
        const target = this.deps.files.internalFile(String(row.id), (row.ext as string | null) ?? null)
        await this.ensureBlobAt(digest, target)
        if (row.origin === 'external') {
          const size = (await fs.stat(target)).size
          op.payload = { ...payload, row: { ...row, origin: 'internal', external_path: null, size, content_hash: null } }
        }
      } else if (op.spec.kind === 'knowledge_item') {
        for (const [relativePath, digest] of Object.entries(payload.blobs)) {
          const target = this.deps.files.knowledgeFile(String(row.base_id), relativePath)
          if (!target) {
            logger.warn('Skipping unsafe knowledge file path from remote', { relativePath })
            continue
          }
          await this.ensureBlobAt(digest, target)
        }
      }
    }
  }

  private async ensureBlobAt(digest: string, target: string): Promise<void> {
    if (await fileExists(target)) {
      const current = await fs.readFile(target)
      if (sha256(current) === digest) return
    }
    const content = await this.deps.transport.downloadBlob(digest)
    if (sha256(content) !== digest) throw new Error(`Downloaded blob ${digest} failed integrity check`)
    await writeFileAtomic(target, content)
  }
}
