import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'

import { BlobError, BlobStore, isValidSha256 } from './blobStore.ts'
import type { ServerConfig } from './config.ts'
import { type IncomingChange, SyncStore } from './store.ts'

export const SERVER_VERSION = '1.0.0'
export const PROTOCOL_VERSION = 1

const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_ENTITY_KEY_LENGTH = 512
const MAX_CHANGES_PER_PUSH = 5000

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

class HttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
}

function parseChanges(body: unknown): IncomingChange[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { changes?: unknown }).changes)) {
    throw new HttpError(400, 'Body must be an object with a "changes" array')
  }
  const raw = (body as { changes: unknown[] }).changes
  if (raw.length > MAX_CHANGES_PER_PUSH) {
    throw new HttpError(413, `At most ${MAX_CHANGES_PER_PUSH} changes are allowed per push`)
  }
  return raw.map((item, index) => {
    const change = item as Partial<IncomingChange> | null
    if (!change || typeof change !== 'object') throw new HttpError(400, `changes[${index}] must be an object`)
    if (
      typeof change.entityKey !== 'string' ||
      change.entityKey.length === 0 ||
      change.entityKey.length > MAX_ENTITY_KEY_LENGTH
    ) {
      throw new HttpError(400, `changes[${index}].entityKey is invalid`)
    }
    if (typeof change.category !== 'string' || !CATEGORY_PATTERN.test(change.category)) {
      throw new HttpError(400, `changes[${index}].category is invalid`)
    }
    if (typeof change.updatedAt !== 'number' || !Number.isSafeInteger(change.updatedAt) || change.updatedAt < 0) {
      throw new HttpError(400, `changes[${index}].updatedAt must be a non-negative integer (UTC milliseconds)`)
    }
    if (typeof change.deleted !== 'boolean') throw new HttpError(400, `changes[${index}].deleted must be a boolean`)
    if (!change.deleted && change.data === undefined) {
      throw new HttpError(400, `changes[${index}].data is required for non-deleted changes`)
    }
    return {
      entityKey: change.entityKey,
      category: change.category,
      updatedAt: change.updatedAt,
      deleted: change.deleted,
      data: change.deleted ? null : change.data
    }
  })
}

function parseCategories(value: string | null): string[] | null {
  if (value === null) return null
  const categories = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  for (const category of categories) {
    if (!CATEGORY_PATTERN.test(category)) throw new HttpError(400, `Invalid category "${category}"`)
  }
  return categories
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Fan-out of revision notifications to connected SSE clients. */
class EventHub {
  private readonly clients = new Set<{ res: ServerResponse; deviceId: string }>()

  get size(): number {
    return this.clients.size
  }

  add(res: ServerResponse, deviceId: string): () => void {
    const client = { res, deviceId }
    this.clients.add(client)
    return () => this.clients.delete(client)
  }

  publish(revision: number, sourceDeviceId: string): void {
    const payload = `event: revision\ndata: ${JSON.stringify({ revision, deviceId: sourceDeviceId })}\n\n`
    for (const client of this.clients) {
      if (client.deviceId !== sourceDeviceId) client.res.write(payload)
    }
  }

  heartbeat(): void {
    for (const client of this.clients) client.res.write(`: heartbeat ${Date.now()}\n\n`)
  }

  closeAll(): void {
    for (const client of this.clients) client.res.end()
    this.clients.clear()
  }
}

export interface SyncServer {
  server: http.Server
  store: SyncStore
  close(): Promise<void>
}

export function createSyncServer(config: ServerConfig, logger: Logger): SyncServer {
  const store = new SyncStore(config.dataDir)
  const blobs = new BlobStore(config.dataDir, config.maxBlobBytes)
  const hub = new EventHub()
  const expectedTokenDigest = createHash('sha256').update(config.authToken).digest()

  const isAuthorized = (req: IncomingMessage): boolean => {
    const header = headerValue(req, 'authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) return false
    const digest = createHash('sha256').update(match[1].trim()).digest()
    return timingSafeEqual(digest, expectedTokenDigest)
  }

  const requireDevice = (req: IncomingMessage): { deviceId: string; deviceName: string } => {
    const deviceId = headerValue(req, 'x-device-id') ?? ''
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new HttpError(400, 'Missing or invalid X-Device-Id header')
    const rawName = headerValue(req, 'x-device-name')
    let deviceName = deviceId
    if (rawName) {
      try {
        deviceName = decodeURIComponent(rawName).slice(0, 128)
      } catch {
        deviceName = rawName.slice(0, 128)
      }
    }
    return { deviceId, deviceName }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (method === 'GET' && pathname === '/api/v1/health') {
      sendJson(res, 200, { status: 'ok', version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION })
      return
    }

    if (!pathname.startsWith('/api/v1/')) throw new HttpError(404, 'Not found')
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      throw new HttpError(401, 'Invalid or missing bearer token')
    }

    if (method === 'GET' && pathname === '/api/v1/auth/verify') {
      const { deviceId, deviceName } = requireDevice(req)
      const device = store.touchDevice(deviceId, deviceName)
      sendJson(res, 200, {
        ok: true,
        serverTime: Date.now(),
        latestRevision: store.latestRevision(),
        protocolVersion: PROTOCOL_VERSION,
        device
      })
      return
    }

    if (method === 'GET' && pathname === '/api/v1/sync/changes') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'Query "since" must be >= 0')
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? `${config.changesPageSize}`, 10)
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 1, 1), config.changesPageSize)
      const categories = parseCategories(url.searchParams.get('categories'))
      sendJson(res, 200, store.changesSince(since, categories, limit))
      return
    }

    if (method === 'POST' && pathname === '/api/v1/sync/push') {
      const { deviceId, deviceName } = requireDevice(req)
      const changes = parseChanges(await readJsonBody(req, config.maxBodyBytes))
      store.touchDevice(deviceId, deviceName)
      const result = store.push(deviceId, changes)
      const accepted = result.results.filter((item) => item.status === 'accepted').length
      if (accepted > 0) hub.publish(result.latestRevision, deviceId)
      logger.info('Push processed', { deviceId, received: changes.length, accepted, revision: result.latestRevision })
      sendJson(res, 200, result)
      return
    }

    if (method === 'GET' && pathname === '/api/v1/sync/events') {
      const { deviceId } = requireDevice(req)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ revision: store.latestRevision() })}\n\n`)
      const remove = hub.add(res, deviceId)
      req.on('close', remove)
      return
    }

    const blobMatch = /^\/api\/v1\/blobs\/([^/]+)$/.exec(pathname)
    if (blobMatch) {
      const sha256 = blobMatch[1].toLowerCase()
      if (!isValidSha256(sha256)) throw new HttpError(400, 'Blob id must be a lowercase hex sha256 digest')

      if (method === 'HEAD') {
        const info = blobs.stat(sha256)
        res.writeHead(info ? 200 : 404, info ? { 'Content-Length': info.size } : {})
        res.end()
        return
      }
      if (method === 'GET') {
        const info = blobs.stat(sha256)
        if (!info) throw new HttpError(404, 'Blob not found')
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': info.size,
          'Cache-Control': 'private, max-age=31536000, immutable'
        })
        fs.createReadStream(blobs.pathFor(sha256)).pipe(res)
        return
      }
      if (method === 'PUT') {
        const declared = Number.parseInt(headerValue(req, 'content-length') ?? '', 10)
        if (Number.isFinite(declared) && declared > config.maxBlobBytes) {
          throw new HttpError(413, `Blob exceeds the maximum size of ${config.maxBlobBytes} bytes`)
        }
        const result = await blobs.write(sha256, req)
        sendJson(res, result.created ? 201 : 200, { sha256, size: result.size, created: result.created })
        return
      }
    }

    throw new HttpError(404, 'Not found')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const statusCode = error instanceof HttpError || error instanceof BlobError ? error.statusCode : 500
      const message = statusCode === 500 ? 'Internal server error' : (error as Error).message
      if (statusCode === 500) logger.error('Unhandled request error', { url: req.url, error: String(error) })
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (statusCode === 413) res.setHeader('Connection', 'close')
      sendJson(res, statusCode, { error: message })
    })
  })

  const heartbeat = setInterval(() => hub.heartbeat(), config.heartbeatMs)
  heartbeat.unref()

  return {
    server,
    store,
    close: async () => {
      clearInterval(heartbeat)
      hub.closeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      store.close()
    }
  }
}
