import { createSyncServer, type Logger, SERVER_VERSION } from './app.ts'
import { loadConfig } from './config.ts'

function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...meta })
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

const logger: Logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
}

let config
try {
  config = loadConfig()
} catch (error) {
  logger.error((error as Error).message)
  process.exit(1)
}

const instance = createSyncServer(config, logger)
instance.server.listen(config.port, config.host, () => {
  logger.info('Cherry Studio sync server started', {
    version: SERVER_VERSION,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir
  })
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    logger.warn('Listening on a public interface. Put the server behind an HTTPS reverse proxy (Caddy/Nginx).')
  }
})

const shutdown = (signal: string) => {
  logger.info('Shutting down', { signal })
  instance
    .close()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error('Shutdown failed', { error: String(error) })
      process.exit(1)
    })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
