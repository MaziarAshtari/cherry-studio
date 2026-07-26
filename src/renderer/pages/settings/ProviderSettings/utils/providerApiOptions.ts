import { ENDPOINT_TYPE } from '@cherrystudio/provider-registry'
import type { Provider } from '@shared/data/types/provider'
import {
  isAnthropicSupportedProvider,
  isAzureOpenAIProvider,
  isOpenAICompatibleProvider,
  isSystemProvider
} from '@shared/utils/provider'

function isOpenAIOptionsProvider(provider: Provider): boolean {
  return isOpenAICompatibleProvider(provider) || isAzureOpenAIProvider(provider)
}

export function supportsOpenAiReasoningSummary(provider: Provider): boolean {
  return (
    provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_RESPONSES ||
    provider.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_RESPONSES] !== undefined
  )
}

export function getProviderApiOptionsVisibility(provider: Provider) {
  const showApiFeatureSettings = !isSystemProvider(provider)
  const isSupportAnthropicPromptCache = isAnthropicSupportedProvider(provider)
  const isOpenAIProvider = isOpenAIOptionsProvider(provider)
  const supportsReasoningSummary = supportsOpenAiReasoningSummary(provider)

  return {
    isOpenAIProvider,
    isSupportAnthropicPromptCache,
    supportsReasoningSummary,
    showApiFeatureSettings,
    hasVisibleApiOptions: showApiFeatureSettings || isSupportAnthropicPromptCache || supportsReasoningSummary
  }
}

export function hasVisibleProviderApiOptions(provider: Provider): boolean {
  return getProviderApiOptionsVisibility(provider).hasVisibleApiOptions
}
