import { describe, expect, it } from 'vitest'

import { assertSuccessfulFinish, FinishReasonError } from '../finishReason'

describe('assertSuccessfulFinish', () => {
  it.each(['stop', 'tool-calls'])('accepts the normal finish reason %s', (finishReason) => {
    expect(() => assertSuccessfulFinish({ finishReason })).not.toThrow()
  })

  it('rejects a nominal stop when Responses reports an incomplete status', () => {
    expect(() =>
      assertSuccessfulFinish({
        finishReason: 'stop',
        providerMetadata: {
          openai: {
            responseStatus: 'incomplete'
          }
        }
      })
    ).toThrow(FinishReasonError)
  })

  it('preserves Responses incomplete metadata on a max-output-tokens error', () => {
    let error: unknown
    try {
      assertSuccessfulFinish({
        finishReason: 'length',
        rawFinishReason: 'max_output_tokens',
        text: 'partial answer',
        providerMetadata: {
          openai: {
            responseStatus: 'incomplete',
            incompleteDetails: { reason: 'max_output_tokens' }
          }
        }
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      name: 'FinishReasonError',
      finishReason: 'length',
      rawFinishReason: 'max_output_tokens',
      responseStatus: 'incomplete',
      incompleteDetails: { reason: 'max_output_tokens' },
      i18nKey: 'response_max_output_tokens',
      text: 'partial answer'
    })
  })

  it.each([
    ['content-filter', 'content_filter', undefined, 'response_content_filtered'],
    ['error', 'error', 'failed', 'response_failed'],
    ['other', 'cancelled', 'cancelled', 'response_cancelled'],
    ['other', undefined, undefined, 'response_missing_terminal'],
    ['other', 'other', undefined, 'response_incomplete'],
    [undefined, undefined, undefined, 'response_missing_terminal']
  ])('rejects abnormal finish=%s raw=%s status=%s', (finishReason, rawFinishReason, responseStatus, i18nKey) => {
    expect(() =>
      assertSuccessfulFinish({
        finishReason,
        rawFinishReason,
        providerMetadata: responseStatus ? { openai: { responseStatus } } : undefined
      })
    ).toThrow(
      expect.objectContaining({
        name: 'FinishReasonError',
        i18nKey
      })
    )
  })

  it('uses the typed error class', () => {
    expect(() => assertSuccessfulFinish({ finishReason: 'length' })).toThrow(FinishReasonError)
  })
})
