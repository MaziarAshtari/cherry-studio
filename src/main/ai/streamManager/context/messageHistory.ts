import type { CherryUIMessage } from '../types'

/** Match the legacy context window: `contextCount + 2` raw messages, then start at the first user message. */
export function limitMessageHistory(history: CherryUIMessage[], contextCount: number): CherryUIMessage[] {
  const limited = history.slice(-(contextCount + 2))
  const firstUserIndex = limited.findIndex((message) => message.role === 'user')

  return firstUserIndex > 0 ? limited.slice(firstUserIndex) : limited
}
