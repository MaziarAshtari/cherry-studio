import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { setupTestDatabase } from '@test-helpers/db'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerKnowledgeFunctions } from '@data/db/knowledgeFunctions'
import type { DbType } from '@data/db/types'
import type { SelfHostedSyncCategory } from '@shared/types/selfHostedSync'

import { SyncEngine } from '../SyncEngine'
import type { ChangesPage, OutgoingChange, PushResult, RemoteRecord, SyncTransport } from '../syncHttpClient'
import { SyncStateStore } from '../syncStateStore'

/** In-memory stand-in for the sync server with the same LWW + revision contract. */
class FakeServer {
  revision = 0
  readonly records = new Map<string, RemoteRecord>()
  readonly blobs = new Map<string, Buffer>()
  uploads = 0

  transport(deviceId: string): SyncTransport {
    return {
      getChanges: async (since, categories): Promise<ChangesPage> => ({
        changes: [...this.records.values()]
          .filter((r) => r.revision > since && categories.includes(r.category))
          .sort((a, b) => a.revision - b.revision),
        hasMore: false,
        latestRevision: this.revision
      }),
      push: async (changes: OutgoingChange[]) => {
        const results: PushResult[] = changes.map((change) => {
          const existing = this.records.get(change.entityKey)
          const data = change.deleted ? null : change.data
          if (
            existing &&
            existing.deleted === change.deleted &&
            JSON.stringify(existing.data) === JSON.stringify(data)
          ) {
            return { entityKey: change.entityKey, status: 'merged', revision: existing.revision }
          }
          if (existing) {
            const newer =
              change.updatedAt !== existing.updatedAt
                ? change.updatedAt > existing.updatedAt
                : deviceId >= existing.deviceId
            if (!newer)
              return { entityKey: change.entityKey, status: 'rejected', revision: existing.revision, current: existing }
          }
          const record: RemoteRecord = { ...change, data, deviceId, revision: ++this.revision }
          this.records.set(change.entityKey, record)
          return { entityKey: change.entityKey, status: 'accepted', revision: record.revision }
        })
        return { results, latestRevision: this.revision }
      },
      hasBlob: async (sha) => this.blobs.has(sha),
      uploadBlob: async (sha, content) => {
        this.uploads++
        this.blobs.set(sha, content)
      },
      downloadBlob: async (sha) => {
        const blob = this.blobs.get(sha)
        if (!blob) throw new Error('missing blob')
        return blob
      }
    }
  }
}

const ALL: ReadonlySet<SelfHostedSyncCategory> = new Set([
  'chats',
  'assistants',
  'providers',
  'mcp',
  'settings',
  'files',
  'knowledge'
])

interface Device {
  db: DbType
  engine: SyncEngine
  state: SyncStateStore
  filesDir: string
  close(): void
}

describe('SyncEngine', () => {
  const dbh = setupTestDatabase()
  let tmp: string
  let server: FakeServer
  let devices: Device[]

  const makeDevice = (deviceId: string, db: DbType, close: () => void): Device => {
    const dir = path.join(tmp, deviceId)
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
    const state = new SyncStateStore(path.join(dir, 'state.sqlite'))
    const engine = new SyncEngine({
      db,
      state,
      transport: server.transport(deviceId),
      deviceId,
      files: {
        internalFile: (fileId, ext) => path.join(dir, 'files', ext ? `${fileId}.${ext}` : fileId),
        knowledgeFile: (baseId, rel) => path.join(dir, 'kb', baseId, 'raw', rel),
        maxBlobBytes: 1024 * 1024
      }
    })
    const device = { db, engine, state, filesDir: path.join(dir, 'files'), close: () => (state.close(), close()) }
    devices.push(device)
    return device
  }

  /** Device B starts from a byte copy of the (truncated) migrated schema. */
  const cloneDevice = (deviceId: string): Device => {
    const file = path.join(tmp, `${deviceId}.sqlite`)
    dbh.sqlite.exec(`VACUUM INTO '${file}'`)
    const sqlite = new Database(file)
    sqlite.pragma('foreign_keys = ON')
    registerKnowledgeFunctions(sqlite)
    return makeDevice(deviceId, drizzle({ client: sqlite, casing: 'snake_case' }), () => sqlite.close())
  }

  const insertAssistant = (db: DbType, id: string, updatedAt = 1000) =>
    db.run(sql`INSERT INTO assistant (id, name, emoji, settings, order_key, created_at, updated_at)
      VALUES (${id}, ${'Helper'}, ${'🌟'}, ${'{}'}, ${'a0'}, ${updatedAt}, ${updatedAt})`)

  const insertTopicWithMessages = (db: DbType, topicId: string, assistantId: string | null, updatedAt = 1000) => {
    db.run(sql`INSERT INTO topic (id, name, assistant_id, order_key, last_activity_at, created_at, updated_at)
      VALUES (${topicId}, ${'Topic'}, ${assistantId}, ${'a0'}, ${updatedAt}, ${updatedAt}, ${updatedAt})`)
    db.run(sql`INSERT INTO message (id, parent_id, topic_id, role, data, status, created_at, updated_at)
      VALUES (${`${topicId}-root`}, NULL, ${topicId}, 'root', ${'{"parts":[]}'}, 'success', ${updatedAt}, ${updatedAt})`)
    db.run(sql`INSERT INTO message (id, parent_id, topic_id, role, data, status, created_at, updated_at)
      VALUES (${`${topicId}-m1`}, ${`${topicId}-root`}, ${topicId}, 'user',
        ${'{"parts":[{"type":"text","text":"hello sync"}]}'}, 'success', ${updatedAt + 1}, ${updatedAt + 1})`)
  }

  const count = (db: DbType, table: string) =>
    db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`)?.n

  const topicName = (db: DbType, id: string) =>
    db.get<{ name: string }>(sql`SELECT name FROM topic WHERE id = ${id}`)?.name

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-hosted-sync-'))
    server = new FakeServer()
    devices = []
  })

  afterEach(() => {
    for (const device of devices) device.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('replicates chats to another device without echoing them back', async () => {
    const b = cloneDevice('device-b')
    const a = makeDevice('device-a', dbh.db, () => {})
    insertAssistant(a.db, 'asst-1')
    insertTopicWithMessages(a.db, 'topic-1', 'asst-1')

    await a.engine.sync(ALL)
    const summary = await b.engine.sync(ALL)

    expect(summary.tables).toEqual(new Set(['assistant', 'topic', 'message']))
    expect(count(b.db, 'message')).toBe(2)
    expect(topicName(b.db, 'topic-1')).toBe('Topic')
    // Full-text search triggers ran for synced messages.
    expect(b.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'sync'`)?.n).toBe(
      1
    )

    const revisionAfter = server.revision
    expect((await b.engine.scanLocalChanges(ALL)).changes).toEqual([])
    expect((await a.engine.scanLocalChanges(ALL)).changes).toEqual([])
    await b.engine.sync(ALL)
    expect(server.revision).toBe(revisionAfter)
  })

  it('resolves concurrent edits of the same entity with last-write-wins on both devices', async () => {
    const b = cloneDevice('device-b')
    const a = makeDevice('device-a', dbh.db, () => {})
    insertTopicWithMessages(a.db, 'topic-1', null)
    await a.engine.sync(ALL)
    await b.engine.sync(ALL)

    a.db.run(sql`UPDATE topic SET name = 'from A', updated_at = 5000 WHERE id = 'topic-1'`)
    b.db.run(sql`UPDATE topic SET name = 'from B', updated_at = 6000 WHERE id = 'topic-1'`)

    await b.engine.sync(ALL)
    await a.engine.sync(ALL) // A's push is rejected and B's newer version is applied
    await b.engine.sync(ALL)

    expect(topicName(a.db, 'topic-1')).toBe('from B')
    expect(topicName(b.db, 'topic-1')).toBe('from B')
  })

  it('propagates deletions as tombstones and does not resurrect them with stale edits', async () => {
    const b = cloneDevice('device-b')
    const a = makeDevice('device-a', dbh.db, () => {})
    insertTopicWithMessages(a.db, 'topic-1', null)
    await a.engine.sync(ALL)
    await b.engine.sync(ALL)

    b.db.run(sql`UPDATE topic SET name = 'stale edit', updated_at = 2000 WHERE id = 'topic-1'`)
    a.db.run(sql`DELETE FROM topic WHERE id = 'topic-1'`) // cascades to messages
    await a.engine.sync(ALL)
    expect(server.records.get('topic:["topic-1"]')?.deleted).toBe(true)

    await b.engine.sync(ALL)
    await a.engine.sync(ALL)

    expect(topicName(b.db, 'topic-1')).toBeUndefined()
    expect(count(b.db, 'message')).toBe(0)
    expect(topicName(a.db, 'topic-1')).toBeUndefined()
  })

  it('neither pushes nor applies categories that are disabled', async () => {
    const b = cloneDevice('device-b')
    const a = makeDevice('device-a', dbh.db, () => {})
    const chatsOnly: ReadonlySet<SelfHostedSyncCategory> = new Set(['chats'])
    a.db.run(
      sql`INSERT INTO mcp_server (id, name, is_active, created_at, updated_at) VALUES ('mcp-a', 'A server', 1, 1, 1)`
    )
    insertTopicWithMessages(a.db, 'topic-1', null)
    b.db.run(
      sql`INSERT INTO mcp_server (id, name, is_active, created_at, updated_at) VALUES ('mcp-b', 'B server', 1, 1, 1)`
    )

    await a.engine.sync(ALL)
    await b.engine.sync(chatsOnly)

    expect(count(b.db, 'topic')).toBe(1)
    expect(b.db.all(sql`SELECT id FROM mcp_server`)).toEqual([{ id: 'mcp-b' }])
    expect(server.records.has('mcp_server:["mcp-b"]')).toBe(false)

    // Re-enabling the category later catches up from the start.
    b.state.resetCategory('mcp', ['mcp_server'])
    await b.engine.sync(ALL)
    expect(b.db.all<{ id: string }>(sql`SELECT id FROM mcp_server ORDER BY id`).map((r) => r.id)).toEqual([
      'mcp-a',
      'mcp-b'
    ])
  })

  it('syncs attachment content through deduplicated blobs and nulls references to unsynced rows', async () => {
    const b = cloneDevice('device-b')
    const a = makeDevice('device-a', dbh.db, () => {})
    for (const fileId of ['file-1', 'file-2']) {
      a.db.run(sql`INSERT INTO file_entry (id, origin, name, ext, size, created_at, updated_at)
        VALUES (${fileId}, 'internal', ${fileId}, 'txt', 5, 1, 1)`)
      fs.writeFileSync(path.join(a.filesDir, `${fileId}.txt`), 'same!')
    }
    // External file whose path does not exist on device B is localized into internal storage.
    const externalPath = path.join(tmp, 'external-notes.md')
    fs.writeFileSync(externalPath, '# notes')
    a.db.run(sql`INSERT INTO file_entry (id, origin, name, ext, external_path, created_at, updated_at)
      VALUES ('file-ext', 'external', 'external-notes', 'md', ${externalPath}, 1, 1)`)

    await a.engine.sync(ALL)
    expect(server.uploads).toBe(2)

    fs.rmSync(externalPath)
    await b.engine.sync(ALL)
    expect(fs.readFileSync(path.join(b.filesDir, 'file-2.txt'), 'utf8')).toBe('same!')
    expect(fs.readFileSync(path.join(b.filesDir, 'file-ext.md'), 'utf8')).toBe('# notes')
    expect(b.db.get(sql`SELECT origin, external_path, size FROM file_entry WHERE id = 'file-ext'`)).toEqual({
      origin: 'internal',
      external_path: null,
      size: 7
    })
    expect((await b.engine.scanLocalChanges(ALL)).changes).toEqual([])
  })

  it('ships knowledge files and marks received items for local re-indexing', async () => {
    const b = cloneDevice('device-b')
    const a = makeDevice('device-a', dbh.db, () => {})
    a.db
      .run(sql`INSERT INTO knowledge_base (id, name, order_key, status, chunk_size, chunk_overlap, created_at, updated_at)
      VALUES ('kb-1', 'Docs', 'a0', 'completed', 512, 64, 1, 1)`)
    a.db.run(sql`INSERT INTO knowledge_item (id, base_id, type, data, status, created_at, updated_at)
      VALUES ('item-1', 'kb-1', 'file', ${JSON.stringify({ source: 'C:\\Users\\me\\guide.md', relativePath: 'guide.md' })},
        'completed', 1, 1)`)
    const sourceFile = path.join(tmp, 'device-a', 'kb', 'kb-1', 'raw', 'guide.md')
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
    fs.writeFileSync(sourceFile, '# Guide')

    await a.engine.sync(ALL)
    const summary = await b.engine.sync(ALL)

    expect(fs.readFileSync(path.join(tmp, 'device-b', 'kb', 'kb-1', 'raw', 'guide.md'), 'utf8')).toBe('# Guide')
    expect(b.db.get(sql`SELECT status FROM knowledge_item WHERE id = 'item-1'`)).toEqual({ status: 'idle' })
    expect(summary.reindex).toEqual(new Map([['kb-1', ['item-1']]]))
    // Index status is device-local, so finishing the re-index must not be pushed back.
    b.db.run(sql`UPDATE knowledge_item SET status = 'completed', updated_at = 99 WHERE id = 'item-1'`)
    expect((await b.engine.scanLocalChanges(ALL)).changes).toEqual([])
  })

  it('keeps device-local preferences out of sync', async () => {
    const a = makeDevice('device-a', dbh.db, () => {})
    a.db.run(sql`INSERT INTO preference (scope, key, value, created_at, updated_at) VALUES
      ('default', 'ui.theme_mode', '"dark"', 1, 1),
      ('default', 'app.proxy.url', '"http://proxy"', 1, 1),
      ('default', 'data.backup.local.dir', '"/home/me"', 1, 1)`)

    const { changes } = await a.engine.scanLocalChanges(ALL)

    expect(changes.map((c) => c.entityKey)).toEqual(['preference:["default","ui.theme_mode"]'])
  })
})
