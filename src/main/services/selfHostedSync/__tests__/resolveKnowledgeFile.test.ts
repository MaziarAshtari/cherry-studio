import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveKnowledgeFile } from '../SelfHostedSyncService'

describe('resolveKnowledgeFile', () => {
  const root = path.join(path.sep, 'data', 'KnowledgeBase')

  it('maps stored POSIX paths onto the host separator', () => {
    expect(resolveKnowledgeFile(root, 'kb-1', 'docs/guide.md')).toBe(path.join(root, 'kb-1', 'raw', 'docs', 'guide.md'))
  })

  it('rejects remote paths that could escape the knowledge base on any OS', () => {
    for (const unsafe of ['../outside.md', 'docs/../../x', '/etc/passwd', 'C:/Windows/x', '..\\outside.md', 'a//b']) {
      expect(resolveKnowledgeFile(root, 'kb-1', unsafe)).toBeNull()
    }
    expect(resolveKnowledgeFile(root, '../kb', 'guide.md')).toBeNull()
  })
})
