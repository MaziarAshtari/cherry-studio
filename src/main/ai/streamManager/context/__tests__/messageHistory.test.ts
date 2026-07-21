import { describe, expect, it } from 'vitest'

import type { CherryUIMessage } from '../../types'
import { limitMessageHistory } from '../messageHistory'

function message(id: string, role: CherryUIMessage['role']): CherryUIMessage {
  return { id, role, parts: [] }
}

describe('limitMessageHistory', () => {
  const history = [
    message('u1', 'user'),
    message('a1', 'assistant'),
    message('u2', 'user'),
    message('a2', 'assistant'),
    message('u3', 'user'),
    message('a3', 'assistant'),
    message('u4-current', 'user')
  ]

  it.each([
    { contextCount: 1, expectedIds: ['u3', 'a3', 'u4-current'] },
    { contextCount: 2, expectedIds: ['u3', 'a3', 'u4-current'] },
    { contextCount: 3, expectedIds: ['u2', 'a2', 'u3', 'a3', 'u4-current'] }
  ])(
    'matches the legacy boundary for contextCount=$contextCount and includes the current outgoing user message',
    ({ contextCount, expectedIds }) => {
      expect(limitMessageHistory(history, contextCount).map(({ id }) => id)).toEqual(expectedIds)
    }
  )
})
