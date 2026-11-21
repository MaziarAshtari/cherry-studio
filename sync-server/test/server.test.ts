import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createSyncServer, type SyncServer } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'
const silentLogger = { info() {}, warn() {}, error() {} }

let instance: SyncServer
let baseUrl: string
let dataDir: string

function headers(deviceId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'X-Device-Id': deviceId, 'X-Device-Name': deviceId, ...extra }
}

async function push(deviceId: string, changes: unknown[]) {
  const res = await fetch(`${baseUrl}/api/v1/sync/push`, {
    method: 'POST',
    headers: headers(deviceId, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ changes })
  })
  assert.equal(res.status, 200)
  return (await res.json()) as {
    results: Array<{ entityKey: string; status: string; revision: number; current?: { data: unknown } }>
    latestRevision: number
  }
}

async function pull(deviceId: string, since: number, categories?: string[], limit?: number) {
  const params = new URLSearchParams({ since: String(since) })
  if (categories) params.set('categories', categories.join(','))
  if (limit) params.set('limit', String(limit))
  const res = await fetch(`${baseUrl}/api/v1/sync/changes?${params}`, { headers: headers(deviceId) })
  assert.equal(res.status, 200)
  return (await res.json()) as {
    changes: Array<{ entityKey: string; revision: number; deleted: boolean; data: unknown; deviceId: string }>
    hasMore: boolean
    latestRevision: number
  }
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-sync-test-'))
  const config = loadConfig({ SYNC_AUTH_TOKEN: TOKEN, DATA_DIR: dataDir, MAX_BLOB_BYTES: '1024' })
  instance = createSyncServer(config, silentLogger)
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
})

after(async () => {
  await instance.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('configuration', () => {
  it('refuses to start without a token or with a weak token', () => {
    assert.throws(() => loadConfig({}), /SYNC_AUTH_TOKEN is not set/)
    assert.throws(() => loadConfig({ SYNC_AUTH_TOKEN: 'short' }), /at least/)
  })
})

describe('authentication', () => {
  it('serves health without auth', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { status: string }).status, 'ok')
  })

  it('rejects missing and wrong tokens on every protected endpoint', async () => {
    const endpoints: Array<[string, string]> = [
      ['GET', '/api/v1/auth/verify'],
      ['GET', '/api/v1/sync/changes?since=0'],
      ['POST', '/api/v1/sync/push'],
      ['GET', '/api/v1/sync/events'],
      ['HEAD', `/api/v1/blobs/${'a'.repeat(64)}`]
    ]
    for (const [method, url] of endpoints) {
      const missing = await fetch(`${baseUrl}${url}`, { method })
      assert.equal(missing.status, 401, `${method} ${url} without token`)
      const wrong = await fetch(`${baseUrl}${url}`, { method, headers: { Authorization: 'Bearer nope' } })
      assert.equal(wrong.status, 401, `${method} ${url} with wrong token`)
    }
  })

  it('verifies the token and registers the device', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/verify`, {
      headers: headers('device-a', { 'X-Device-Name': encodeURIComponent('Laptop ü') })
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; device: { deviceId: string; deviceName: string } }
    assert.equal(body.ok, true)
    assert.deepEqual([body.device.deviceId, body.device.deviceName], ['device-a', 'Laptop ü'])
  })

  it('requires a device id for verification', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/verify`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(res.status, 400)
  })
})

describe('incremental sync with LWW', () => {
  it('pushes, pulls incrementally, and resolves conflicts with last-write-wins', async () => {
    const start = (await pull('device-b', 0)).latestRevision

    const first = await push('device-a', [
      { entityKey: 'topic:1', category: 'chats', updatedAt: 1000, deleted: false, data: { name: 'A1' } },
      { entityKey: 'mcp_server:1', category: 'mcp', updatedAt: 1000, deleted: false, data: { name: 'srv' } }
    ])
    assert.deepEqual(
      first.results.map((r) => r.status),
      ['accepted', 'accepted']
    )

    const pulled = await pull('device-b', start)
    assert.deepEqual(
      pulled.changes.map((c) => c.entityKey),
      ['topic:1', 'mcp_server:1']
    )
    const cursor = pulled.latestRevision
    assert.equal((await pull('device-b', cursor)).changes.length, 0, 'nothing new after the cursor')

    // Older write loses and the winner is returned.
    const stale = await push('device-b', [
      { entityKey: 'topic:1', category: 'chats', updatedAt: 999, deleted: false, data: { name: 'B-old' } }
    ])
    assert.equal(stale.results[0].status, 'rejected')
    assert.deepEqual(stale.results[0].current?.data, { name: 'A1' })

    // Same timestamp: deterministic tie-break by device id ('device-b' > 'device-a').
    const tie = await push('device-b', [
      { entityKey: 'topic:1', category: 'chats', updatedAt: 1000, deleted: false, data: { name: 'B-tie' } }
    ])
    assert.equal(tie.results[0].status, 'accepted')
    const tieLoser = await push('device-a', [
      { entityKey: 'topic:1', category: 'chats', updatedAt: 1000, deleted: false, data: { name: 'A-tie' } }
    ])
    assert.equal(tieLoser.results[0].status, 'rejected')

    // Identical content is merged without a new revision.
    const same = await push('device-a', [
      { entityKey: 'topic:1', category: 'chats', updatedAt: 5000, deleted: false, data: { name: 'B-tie' } }
    ])
    assert.equal(same.results[0].status, 'merged')

    const newer = await pull('device-a', cursor)
    assert.deepEqual(
      newer.changes.map((c) => [c.entityKey, c.data, c.deviceId]),
      [['topic:1', { name: 'B-tie' }, 'device-b']]
    )
  })

  it('propagates tombstones and does not resurrect deleted entities with stale writes', async () => {
    await push('device-a', [
      { entityKey: 'assistant:9', category: 'assistants', updatedAt: 2000, deleted: false, data: { n: 1 } }
    ])
    const cursor = (await pull('device-b', 0)).latestRevision
    const del = await push('device-b', [
      { entityKey: 'assistant:9', category: 'assistants', updatedAt: 3000, deleted: true, data: { ignored: true } }
    ])
    assert.equal(del.results[0].status, 'accepted')

    const tombstones = await pull('device-a', cursor)
    assert.deepEqual(
      tombstones.changes.map((c) => [c.entityKey, c.deleted, c.data]),
      [['assistant:9', true, null]]
    )

    const resurrect = await push('device-a', [
      { entityKey: 'assistant:9', category: 'assistants', updatedAt: 2500, deleted: false, data: { n: 2 } }
    ])
    assert.equal(resurrect.results[0].status, 'rejected')
  })

  it('filters changes by category and paginates by revision', async () => {
    const base = (await pull('device-a', 0)).latestRevision
    await push('device-a', [
      { entityKey: 'p:1', category: 'providers', updatedAt: 1, deleted: false, data: 1 },
      { entityKey: 's:1', category: 'settings', updatedAt: 1, deleted: false, data: 1 },
      { entityKey: 'p:2', category: 'providers', updatedAt: 1, deleted: false, data: 2 }
    ])
    const onlyProviders = await pull('device-b', base, ['providers'])
    assert.deepEqual(
      onlyProviders.changes.map((c) => c.entityKey),
      ['p:1', 'p:2']
    )
    const none = await pull('device-b', base, [])
    assert.equal(none.changes.length, 0)

    const page1 = await pull('device-b', base, undefined, 2)
    assert.equal(page1.changes.length, 2)
    assert.equal(page1.hasMore, true)
    const page2 = await pull('device-b', page1.changes[1].revision, undefined, 2)
    assert.deepEqual(
      page2.changes.map((c) => c.entityKey),
      ['p:2']
    )
    assert.equal(page2.hasMore, false)
  })

  it('rejects malformed pushes', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sync/push`, {
      method: 'POST',
      headers: headers('device-a', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ changes: [{ entityKey: 'x', category: 'BAD!', updatedAt: 1, deleted: false, data: 1 }] })
    })
    assert.equal(res.status, 400)
  })
})

describe('content-addressed blobs', () => {
  it('stores each blob once and serves it back', async () => {
    const content = Buffer.from('hello cherry studio')
    const sha = createHash('sha256').update(content).digest('hex')
    const url = `${baseUrl}/api/v1/blobs/${sha}`

    assert.equal((await fetch(url, { method: 'HEAD', headers: headers('device-a') })).status, 404)
    const created = await fetch(url, { method: 'PUT', headers: headers('device-a'), body: content })
    assert.equal(created.status, 201)
    const again = await fetch(url, { method: 'PUT', headers: headers('device-b'), body: content })
    assert.equal(again.status, 200)
    assert.equal(((await again.json()) as { created: boolean }).created, false)

    const head = await fetch(url, { method: 'HEAD', headers: headers('device-b') })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(content.length))
    const got = await fetch(url, { headers: headers('device-b') })
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), content)
  })

  it('rejects content whose hash does not match and oversized blobs', async () => {
    const wrongSha = createHash('sha256').update('other').digest('hex')
    const mismatch = await fetch(`${baseUrl}/api/v1/blobs/${wrongSha}`, {
      method: 'PUT',
      headers: headers('device-a'),
      body: Buffer.from('not other')
    })
    assert.equal(mismatch.status, 400)
    assert.equal((await fetch(`${baseUrl}/api/v1/blobs/${wrongSha}`, { headers: headers('device-a') })).status, 404)

    const big = Buffer.alloc(2048, 1)
    const bigSha = createHash('sha256').update(big).digest('hex')
    const tooBig = await fetch(`${baseUrl}/api/v1/blobs/${bigSha}`, {
      method: 'PUT',
      headers: headers('device-a'),
      body: big
    })
    assert.equal(tooBig.status, 413)
  })
})

describe('real-time events', () => {
  it('notifies other devices about new revisions over SSE', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/sync/events`, {
      headers: headers('device-b'),
      signal: controller.signal
    })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += decoder.decode(value)
      }
    }
    await readUntil('event: hello')
    const pushed = await push('device-a', [
      { entityKey: 'sse:1', category: 'chats', updatedAt: 1, deleted: false, data: {} }
    ])
    await readUntil('event: revision')
    assert.match(buffer, new RegExp(`"revision":${pushed.latestRevision}`))
    controller.abort()
  })
})
