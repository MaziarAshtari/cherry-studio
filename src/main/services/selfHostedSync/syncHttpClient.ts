import type { SelfHostedSyncCategory } from '@shared/types/selfHostedSync'

export interface RemoteRecord {
  revision: number
  entityKey: string
  category: SelfHostedSyncCategory
  updatedAt: number
  deviceId: string
  deleted: boolean
  data: unknown
}

export interface OutgoingChange {
  entityKey: string
  category: SelfHostedSyncCategory
  updatedAt: number
  deleted: boolean
  data: unknown
}

export interface PushResult {
  entityKey: string
  status: 'accepted' | 'rejected' | 'merged'
  revision: number
  current?: RemoteRecord
}

export interface ChangesPage {
  changes: RemoteRecord[]
  hasMore: boolean
  latestRevision: number
}

/** The subset of the server protocol the engine depends on (fakeable in tests). */
export interface SyncTransport {
  getChanges(since: number, categories: SelfHostedSyncCategory[]): Promise<ChangesPage>
  push(changes: OutgoingChange[]): Promise<{ results: PushResult[]; latestRevision: number }>
  hasBlob(sha256: string): Promise<boolean>
  uploadBlob(sha256: string, content: Buffer): Promise<void>
  downloadBlob(sha256: string): Promise<Buffer>
}

export class SyncHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SyncHttpError'
    this.status = status
  }
}

export interface SyncHttpClientOptions {
  serverUrl: string
  authToken: string
  deviceId: string
  deviceName: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Server URL must start with http:// or https://')
  }
  return trimmed
}

export class SyncHttpClient implements SyncTransport {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: SyncHttpClientOptions) {
    this.baseUrl = `${normalizeServerUrl(options.serverUrl)}/api/v1`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.authToken}`,
      'X-Device-Id': this.options.deviceId,
      'X-Device-Name': encodeURIComponent(this.options.deviceName),
      ...extra
    }
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers as Record<string, string> | undefined),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (!response.ok && !(init.method === 'HEAD' && response.status === 404)) {
      let message = `${response.status} ${response.statusText}`
      try {
        const body = (await response.json()) as { error?: string }
        if (body.error) message = `${response.status}: ${body.error}`
      } catch {
        // Non-JSON error body; keep the status line.
      }
      throw new SyncHttpError(response.status, message)
    }
    return response
  }

  async verify(): Promise<{ latestRevision: number; serverTime: number }> {
    const response = await this.request('/auth/verify')
    const body = (await response.json()) as { latestRevision: number; serverTime: number }
    return { latestRevision: body.latestRevision, serverTime: body.serverTime }
  }

  async getChanges(since: number, categories: SelfHostedSyncCategory[]): Promise<ChangesPage> {
    const params = new URLSearchParams({ since: String(since), categories: categories.join(',') })
    const response = await this.request(`/sync/changes?${params}`)
    return (await response.json()) as ChangesPage
  }

  async push(changes: OutgoingChange[]): Promise<{ results: PushResult[]; latestRevision: number }> {
    const response = await this.request('/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes })
    })
    return (await response.json()) as { results: PushResult[]; latestRevision: number }
  }

  async hasBlob(sha256: string): Promise<boolean> {
    const response = await this.request(`/blobs/${sha256}`, { method: 'HEAD' })
    return response.status === 200
  }

  async uploadBlob(sha256: string, content: Buffer): Promise<void> {
    await this.request(`/blobs/${sha256}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(content)
    })
  }

  async downloadBlob(sha256: string): Promise<Buffer> {
    const response = await this.request(`/blobs/${sha256}`)
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * Holds the SSE stream open and calls `onRevision` whenever another device pushes.
   * Resolves when the stream ends; rejects on connection errors. The caller owns reconnects.
   */
  async listen(signal: AbortSignal, onOpen: () => void, onRevision: (revision: number) => void): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/sync/events`, {
      headers: this.headers({ Accept: 'text/event-stream' }),
      signal
    })
    if (!response.ok || !response.body) throw new SyncHttpError(response.status, `Event stream failed: ${response.status}`)
    onOpen()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        const lines = block.split('\n')
        const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
        const data = lines
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        if (event === 'revision' && data) {
          try {
            onRevision((JSON.parse(data) as { revision: number }).revision)
          } catch {
            // Ignore malformed events; the polling fallback still converges.
          }
        }
      }
    }
  }
}
