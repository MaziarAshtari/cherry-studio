import { createOpenAI } from '@ai-sdk/openai'
import { generateText, simulateStreamingMiddleware, streamText, wrapLanguageModel } from 'ai'
import { describe, expect, it, vi } from 'vitest'

const usage = {
  input_tokens: 4,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 8,
  output_tokens_details: { reasoning_tokens: 3 }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function eventStreamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

function createProvider(fetch: typeof globalThis.fetch) {
  return createOpenAI({
    apiKey: 'redacted-test-key',
    baseURL: 'https://example.invalid/v1',
    fetch
  })
}

function readRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function incompleteResponse() {
  return {
    id: 'resp-incomplete',
    created_at: 1,
    model: 'gpt-test',
    status: 'incomplete',
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: 'message-1',
        content: [
          {
            type: 'output_text',
            text: 'partial answer',
            annotations: []
          }
        ]
      }
    ],
    service_tier: 'default',
    incomplete_details: { reason: 'max_output_tokens' },
    usage
  }
}

describe('patched OpenAI Responses adapter', () => {
  it('streams provider-supplied reasoning variants without duplicating done text', async () => {
    const fetchMock = vi.fn(async () =>
      eventStreamResponse([
        {
          type: 'response.created',
          response: { id: 'resp-1', created_at: 1, model: 'gpt-test', service_tier: 'default' }
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-private-payload' }
        },
        {
          type: 'response.reasoning_summary_part.added',
          item_id: 'reasoning-1',
          summary_index: 0
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning-1',
          summary_index: 0,
          delta: 'Deep'
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning-1',
          summary_index: 0,
          text: 'Deep thought'
        },
        {
          type: 'response.reasoning_summary_part.done',
          item_id: 'reasoning-1',
          summary_index: 0
        },
        {
          type: 'response.reasoning_text.delta',
          item_id: 'reasoning-1',
          content_index: 0,
          delta: 'Visible'
        },
        {
          type: 'response.reasoning_text.done',
          item_id: 'reasoning-1',
          content_index: 0,
          text: 'Visible rationale'
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-private-payload' }
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'message-1', phase: 'final_answer' }
        },
        {
          type: 'response.output_text.delta',
          item_id: 'message-1',
          delta: 'Final'
        },
        {
          type: 'response.output_text.done',
          item_id: 'message-1',
          text: 'Final answer'
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'message', id: 'message-1', phase: 'final_answer' }
        },
        {
          type: 'response.completed',
          response: { incomplete_details: null, usage, service_tier: 'default' }
        }
      ])
    )
    const provider = createProvider(fetchMock as typeof globalThis.fetch)
    const result = streamText({
      model: provider.responses('gpt-5'),
      prompt: 'hello',
      providerOptions: {
        openai: {
          reasoningSummary: 'auto',
          store: false
        }
      }
    })

    const reasoningDeltas: string[] = []
    const textDeltas: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') reasoningDeltas.push(part.text)
      if (part.type === 'text-delta') textDeltas.push(part.text)
    }

    expect(reasoningDeltas.join('')).toBe('Deep thoughtVisible rationale')
    expect(reasoningDeltas.join('')).not.toContain('opaque-private-payload')
    expect(textDeltas.join('')).toBe('Final answer')
    expect(await result.finishReason).toBe('stop')
    expect(await result.providerMetadata).toMatchObject({
      openai: {
        responseStatus: 'completed',
        incompleteDetails: null
      }
    })
    expect(readRequestBody(fetchMock)).toMatchObject({
      reasoning: { summary: 'auto' }
    })
    expect(readRequestBody(fetchMock)).not.toHaveProperty('max_output_tokens')
  })

  it('preserves cancellation status and raw finish reason in a streaming response', async () => {
    const fetchMock = vi.fn(async () =>
      eventStreamResponse([
        {
          type: 'response.created',
          response: { id: 'resp-2', created_at: 1, model: 'gpt-test', service_tier: 'default' }
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'message-2', phase: 'final_answer' }
        },
        {
          type: 'response.output_text.done',
          item_id: 'message-2',
          text: 'partial'
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', id: 'message-2', phase: 'final_answer' }
        },
        {
          type: 'response.cancelled',
          response: {
            error: null,
            incomplete_details: { reason: 'cancelled' },
            usage,
            service_tier: 'default'
          }
        }
      ])
    )
    const result = streamText({
      model: createProvider(fetchMock as typeof globalThis.fetch).responses('gpt-test'),
      prompt: 'hello'
    })

    await result.consumeStream()

    expect(await result.text).toBe('partial')
    expect(await result.finishReason).toBe('other')
    expect(await result.rawFinishReason).toBe('cancelled')
    expect(await result.providerMetadata).toMatchObject({
      openai: {
        responseStatus: 'cancelled',
        incompleteDetails: { reason: 'cancelled' }
      }
    })
  })

  it('serializes an explicit max_output_tokens and preserves an incomplete direct generation result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(incompleteResponse()))
    const result = await generateText({
      model: createProvider(fetchMock as typeof globalThis.fetch).responses('gpt-test'),
      prompt: 'hello',
      maxOutputTokens: 321
    })

    expect(result.text).toBe('partial answer')
    expect(result.finishReason).toBe('length')
    expect(result.rawFinishReason).toBe('max_output_tokens')
    expect(result.providerMetadata).toMatchObject({
      openai: {
        responseStatus: 'incomplete',
        incompleteDetails: { reason: 'max_output_tokens' }
      }
    })
    expect(readRequestBody(fetchMock)).toHaveProperty('max_output_tokens', 321)
  })

  it('preserves an abnormal finish when non-streaming generation is exposed through simulated streaming', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(incompleteResponse()))
    const provider = createProvider(fetchMock as typeof globalThis.fetch)
    const result = streamText({
      model: wrapLanguageModel({
        model: provider.responses('gpt-test'),
        middleware: simulateStreamingMiddleware()
      }),
      prompt: 'hello'
    })

    await result.consumeStream()

    expect(await result.text).toBe('partial answer')
    expect(await result.finishReason).toBe('length')
    expect(await result.rawFinishReason).toBe('max_output_tokens')
    expect(await result.providerMetadata).toMatchObject({
      openai: {
        responseStatus: 'incomplete',
        incompleteDetails: { reason: 'max_output_tokens' }
      }
    })
    expect(readRequestBody(fetchMock)).not.toHaveProperty('stream')
  })

  it('leaves response status absent when a stream ends without a terminal event', async () => {
    const fetchMock = vi.fn(async () =>
      eventStreamResponse([
        {
          type: 'response.created',
          response: { id: 'resp-unterminated', created_at: 1, model: 'gpt-test', service_tier: 'default' }
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'message-unterminated', phase: 'final_answer' }
        },
        {
          type: 'response.output_text.done',
          item_id: 'message-unterminated',
          text: 'partial'
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', id: 'message-unterminated', phase: 'final_answer' }
        }
      ])
    )
    const result = streamText({
      model: createProvider(fetchMock as typeof globalThis.fetch).responses('gpt-test'),
      prompt: 'hello'
    })

    await result.consumeStream()

    expect(await result.text).toBe('partial')
    expect(await result.finishReason).toBe('other')
    expect(await result.rawFinishReason).toBeUndefined()
    expect(await result.providerMetadata).toEqual({
      openai: {
        responseId: 'resp-unterminated'
      }
    })
  })
})
