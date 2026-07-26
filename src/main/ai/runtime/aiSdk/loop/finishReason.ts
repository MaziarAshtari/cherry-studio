import type { Serializable } from '@shared/types/serializable'

interface ResponsesTerminalMetadata {
  responseStatus?: string
  incompleteDetails?: Serializable
  responseError?: Serializable
}

export interface FinishDetails {
  finishReason?: string
  rawFinishReason?: string
  providerMetadata?: unknown
  text?: string
}

function readResponsesTerminalMetadata(providerMetadata: unknown): ResponsesTerminalMetadata {
  if (!providerMetadata || typeof providerMetadata !== 'object') return {}

  for (const value of Object.values(providerMetadata)) {
    if (!value || typeof value !== 'object') continue
    const candidate = value as Record<string, unknown>
    if ('responseStatus' in candidate || 'incompleteDetails' in candidate || 'responseError' in candidate) {
      return {
        responseStatus: typeof candidate.responseStatus === 'string' ? candidate.responseStatus : undefined,
        incompleteDetails: candidate.incompleteDetails as Serializable | undefined,
        responseError: candidate.responseError as Serializable | undefined
      }
    }
  }

  return {}
}

function terminalMessage(finishReason: string | undefined, rawFinishReason: string | undefined, status?: string) {
  if (status === 'cancelled' || rawFinishReason === 'cancelled') {
    return {
      message: 'The provider cancelled the response before it completed.',
      i18nKey: 'response_cancelled'
    }
  }
  if (finishReason === 'length' || rawFinishReason === 'max_output_tokens' || rawFinishReason === 'max_tokens') {
    return {
      message: 'The response ended because the provider exhausted its output-token budget.',
      i18nKey: 'response_max_output_tokens'
    }
  }
  if (finishReason === 'content-filter' || rawFinishReason === 'content_filter') {
    return {
      message: 'The provider stopped the response because of its content filter.',
      i18nKey: 'response_content_filtered'
    }
  }
  if (finishReason === 'error' || status === 'failed') {
    return {
      message: 'The provider failed before the response completed.',
      i18nKey: 'response_failed'
    }
  }
  if (
    (finishReason === undefined || finishReason === 'other') &&
    rawFinishReason === undefined &&
    status === undefined
  ) {
    return {
      message: 'The response stream ended without a terminal event.',
      i18nKey: 'response_missing_terminal'
    }
  }
  return {
    message: 'The response ended before the provider reported a normal completion.',
    i18nKey: 'response_incomplete'
  }
}

export class FinishReasonError extends Error {
  readonly finishReason: string | null
  readonly rawFinishReason: string | null
  readonly responseStatus: string | null
  readonly incompleteDetails: Serializable
  readonly providerError: Serializable
  readonly i18nKey: string
  readonly text: string | null

  constructor(details: FinishDetails) {
    const metadata = readResponsesTerminalMetadata(details.providerMetadata)
    const display = terminalMessage(details.finishReason, details.rawFinishReason, metadata.responseStatus)
    super(display.message)
    this.name = 'FinishReasonError'
    this.finishReason = details.finishReason ?? null
    this.rawFinishReason = details.rawFinishReason ?? null
    this.responseStatus = metadata.responseStatus ?? null
    this.incompleteDetails = metadata.incompleteDetails ?? null
    this.providerError = metadata.responseError ?? null
    this.i18nKey = display.i18nKey
    this.text = details.text ?? null
  }
}

export function assertSuccessfulFinish(details: FinishDetails): void {
  const status = readResponsesTerminalMetadata(details.providerMetadata).responseStatus
  const hasSuccessfulFinishReason = details.finishReason === 'stop' || details.finishReason === 'tool-calls'
  if (hasSuccessfulFinishReason && (status === undefined || status === 'completed')) return
  throw new FinishReasonError(details)
}
