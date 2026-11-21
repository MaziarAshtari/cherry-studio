import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class BlobError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export function isValidSha256(value: string): boolean {
  return SHA256_PATTERN.test(value)
}

/** Content-addressed blob storage: `<dataDir>/blobs/<aa>/<sha256>`. Identical content is stored once. */
export class BlobStore {
  private readonly root: string
  private readonly tmpDir: string
  private readonly maxBytes: number

  constructor(dataDir: string, maxBytes: number) {
    this.root = path.join(dataDir, 'blobs')
    this.tmpDir = path.join(dataDir, 'tmp')
    this.maxBytes = maxBytes
    fs.mkdirSync(this.root, { recursive: true })
    fs.mkdirSync(this.tmpDir, { recursive: true })
  }

  pathFor(sha256: string): string {
    return path.join(this.root, sha256.slice(0, 2), sha256)
  }

  stat(sha256: string): { size: number } | null {
    try {
      const stats = fs.statSync(this.pathFor(sha256))
      return stats.isFile() ? { size: stats.size } : null
    } catch {
      return null
    }
  }

  /** Streams the request body to disk, verifying size and hash before publishing it atomically. */
  async write(sha256: string, body: IncomingMessage): Promise<{ created: boolean; size: number }> {
    const existing = this.stat(sha256)
    if (existing) {
      body.resume()
      return { created: false, size: existing.size }
    }

    const tmpPath = path.join(this.tmpDir, `${sha256}.${randomUUID()}`)
    const hash = createHash('sha256')
    let size = 0
    const out = fs.createWriteStream(tmpPath)

    try {
      await new Promise<void>((resolve, reject) => {
        body.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > this.maxBytes) {
            body.destroy()
            reject(new BlobError(413, `Blob exceeds the maximum size of ${this.maxBytes} bytes`))
            return
          }
          hash.update(chunk)
          if (!out.write(chunk)) {
            body.pause()
            out.once('drain', () => body.resume())
          }
        })
        body.on('end', () => out.end(() => resolve()))
        body.on('error', reject)
        out.on('error', reject)
      })

      const digest = hash.digest('hex')
      if (digest !== sha256) {
        throw new BlobError(400, `Blob content hash mismatch: expected ${sha256}, got ${digest}`)
      }
      const finalPath = this.pathFor(sha256)
      fs.mkdirSync(path.dirname(finalPath), { recursive: true })
      fs.renameSync(tmpPath, finalPath)
      return { created: true, size }
    } catch (error) {
      out.destroy()
      fs.rmSync(tmpPath, { force: true })
      throw error
    }
  }
}
