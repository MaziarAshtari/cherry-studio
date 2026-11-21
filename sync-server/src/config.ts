import path from 'node:path'

export interface ServerConfig {
  host: string
  port: number
  dataDir: string
  authToken: string
  maxBodyBytes: number
  maxBlobBytes: number
  changesPageSize: number
  heartbeatMs: number
}

const MIN_TOKEN_LENGTH = 24

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const authToken = (env.SYNC_AUTH_TOKEN ?? '').trim()
  if (!authToken) {
    throw new Error(
      'SYNC_AUTH_TOKEN is not set. Generate one with "npm run generate-token" and put it in your .env file.'
    )
  }
  if (authToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`SYNC_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long.`)
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: readInt(env, 'PORT', 8787),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    authToken,
    maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 64 * 1024 * 1024),
    maxBlobBytes: readInt(env, 'MAX_BLOB_BYTES', 1024 * 1024 * 1024),
    changesPageSize: readInt(env, 'CHANGES_PAGE_SIZE', 500),
    heartbeatMs: readInt(env, 'SSE_HEARTBEAT_MS', 25_000)
  }
}
