import {
  Input,
  PageSidePanelItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip
} from '@cherrystudio/ui'
import { useProvider } from '@renderer/hooks/useProvider'
import { toast } from '@renderer/services/toast'
import { cn } from '@renderer/utils/style'
import {
  ANTHROPIC_CACHE_DEFAULT_LAST_N_MESSAGES,
  ANTHROPIC_CACHE_DEFAULT_TOKEN_THRESHOLD
} from '@shared/ai/anthropicCache'
import type { Provider, RuntimeApiFeatures } from '@shared/data/types/provider'
import { isAnthropicSupportedProvider } from '@shared/utils/provider'
import { Info } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import ProviderSettingsDrawer from '../primitives/ProviderSettingsDrawer'
import { drawerClasses } from '../primitives/ProviderSettingsPrimitives'
import { getProviderApiOptionsVisibility, supportsOpenAiReasoningSummary } from '../utils/providerApiOptions'

interface ProviderApiOptionsDrawerProps {
  providerId: string
  open: boolean
  onClose: () => void
}

type ApiFeatureKey = keyof RuntimeApiFeatures

interface ApiOption {
  key: ApiFeatureKey
  label: string
  help: string
}

const CACHE_TOKEN_THRESHOLD_MAX = 100000
const CACHE_LAST_N_MAX = 10
const DEFAULT_REASONING_SUMMARY = 'default'
const DISABLED_REASONING_SUMMARY = 'off'

type ReasoningSummarySelection =
  | typeof DEFAULT_REASONING_SUMMARY
  | typeof DISABLED_REASONING_SUMMARY
  | NonNullable<Provider['settings']['summaryText']>

function clampInteger(value: string, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return min
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function apiOptionId(providerId: string, key: string): string {
  return `provider-api-option-${providerId}-${key}`
}

function OptionTitle({ id, label, help }: { id: string; label: string; help: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <label htmlFor={id} className="min-w-0 cursor-pointer truncate">
        {label}
      </label>
      <Tooltip content={help}>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/55"
          aria-label={help}>
          <Info className="size-3" aria-hidden />
        </span>
      </Tooltip>
    </span>
  )
}

export default function ProviderApiOptionsDrawer({ providerId, open, onClose }: ProviderApiOptionsDrawerProps) {
  const { t } = useTranslation()
  const { provider, updateProvider } = useProvider(providerId)

  const cacheControl = provider?.settings?.cacheControl
  const cacheTokenThreshold =
    cacheControl?.enabled === false ? 0 : (cacheControl?.tokenThreshold ?? ANTHROPIC_CACHE_DEFAULT_TOKEN_THRESHOLD)
  const cacheLastNMessages = cacheControl?.cacheLastNMessages ?? ANTHROPIC_CACHE_DEFAULT_LAST_N_MESSAGES
  const [tokenThresholdDraft, setTokenThresholdDraft] = useState(String(cacheTokenThreshold))
  const [cacheLastNDraft, setCacheLastNDraft] = useState(String(cacheLastNMessages))
  const effectiveCacheTokenThreshold = clampInteger(tokenThresholdDraft, 0, CACHE_TOKEN_THRESHOLD_MAX)

  useEffect(() => {
    if (!open) {
      return
    }
    setTokenThresholdDraft(String(cacheTokenThreshold))
    setCacheLastNDraft(String(cacheLastNMessages))
  }, [cacheLastNMessages, cacheTokenThreshold, open])

  const openAIOptions = useMemo<ApiOption[]>(
    () => [
      {
        key: 'developerRole',
        label: t('settings.provider.api.options.developer_role.label'),
        help: t('settings.provider.api.options.developer_role.help')
      },
      {
        key: 'streamOptions',
        label: t('settings.provider.api.options.stream_options.label'),
        help: t('settings.provider.api.options.stream_options.help')
      },
      {
        key: 'serviceTier',
        label: t('settings.provider.api.options.service_tier.label'),
        help: t('settings.provider.api.options.service_tier.help')
      },
      {
        key: 'verbosity',
        label: t('settings.provider.api.options.verbosity.label'),
        help: t('settings.provider.api.options.verbosity.help')
      }
    ],
    [t]
  )

  const options = useMemo<ApiOption[]>(() => {
    if (!provider) {
      return []
    }

    const visibility = getProviderApiOptionsVisibility(provider)
    if (!visibility.showApiFeatureSettings) {
      return []
    }

    const items: ApiOption[] = [
      {
        key: 'arrayContent',
        label: t('settings.provider.api.options.array_content.label'),
        help: t('settings.provider.api.options.array_content.help')
      }
    ]

    if (visibility.isOpenAIProvider) {
      items.push(...openAIOptions)
    }

    return items
  }, [openAIOptions, provider, t])

  const handleSaveError = useCallback(() => {
    toast.error(t('settings.provider.save_failed'))
  }, [t])

  const updateApiFeature = useCallback(
    (key: ApiFeatureKey, checked: boolean) => {
      if (!provider) {
        return
      }
      updateProvider({
        apiFeatures: {
          ...provider.apiFeatures,
          [key]: checked
        }
      }).catch(handleSaveError)
    },
    [handleSaveError, provider, updateProvider]
  )

  const updateCacheSettings = useCallback(
    (updates: NonNullable<Provider['settings']['cacheControl']>) => {
      if (!provider) {
        return
      }

      const next = {
        tokenThreshold: ANTHROPIC_CACHE_DEFAULT_TOKEN_THRESHOLD,
        cacheSystemMessage: true,
        cacheLastNMessages: ANTHROPIC_CACHE_DEFAULT_LAST_N_MESSAGES,
        ...provider.settings.cacheControl,
        ...updates
      }

      updateProvider({
        providerSettings: {
          ...provider.settings,
          cacheControl: {
            ...next,
            enabled: (next.tokenThreshold ?? 0) > 0
          }
        }
      }).catch(handleSaveError)
    },
    [handleSaveError, provider, updateProvider]
  )

  const updateReasoningSummary = useCallback(
    (selection: ReasoningSummarySelection) => {
      if (!provider) return

      const summaryText =
        selection === DEFAULT_REASONING_SUMMARY
          ? undefined
          : selection === DISABLED_REASONING_SUMMARY
            ? null
            : selection
      updateProvider({
        providerSettings: {
          ...provider.settings,
          summaryText
        }
      }).catch(handleSaveError)
    },
    [handleSaveError, provider, updateProvider]
  )

  const commitTokenThreshold = useCallback(() => {
    const next = clampInteger(tokenThresholdDraft, 0, CACHE_TOKEN_THRESHOLD_MAX)
    setTokenThresholdDraft(String(next))
    updateCacheSettings({
      enabled: next > 0,
      tokenThreshold: next
    })
  }, [tokenThresholdDraft, updateCacheSettings])

  const commitCacheLastNMessages = useCallback(() => {
    const next = clampInteger(cacheLastNDraft, 0, CACHE_LAST_N_MAX)
    setCacheLastNDraft(String(next))
    updateCacheSettings({
      enabled: effectiveCacheTokenThreshold > 0,
      tokenThreshold: effectiveCacheTokenThreshold,
      cacheLastNMessages: next
    })
  }, [cacheLastNDraft, effectiveCacheTokenThreshold, updateCacheSettings])

  if (!provider) {
    return <ProviderSettingsDrawer open={open} onClose={onClose} title={t('settings.provider.api.options.label')} />
  }

  const isSupportAnthropicPromptCache = isAnthropicSupportedProvider(provider)
  const showReasoningSummary = supportsOpenAiReasoningSummary(provider)
  const showCacheDetailOptions = effectiveCacheTokenThreshold > 0
  const cacheSystemMessage = cacheControl?.cacheSystemMessage ?? true
  const reasoningSummarySelection =
    provider.settings.summaryText === undefined
      ? DEFAULT_REASONING_SUMMARY
      : provider.settings.summaryText === null
        ? DISABLED_REASONING_SUMMARY
        : provider.settings.summaryText

  return (
    <ProviderSettingsDrawer
      open={open}
      onClose={onClose}
      title={t('settings.provider.api.options.label')}
      headerClassName="px-6 pt-4 pb-2"
      bodyClassName="space-y-0 px-6 pt-1 pb-6">
      <div className="flex min-w-0 flex-col gap-4">
        {options.length > 0 ? (
          <div className="flex flex-col gap-4">
            {options.map((item) => {
              const id = apiOptionId(providerId, item.key)
              return (
                <PageSidePanelItem
                  key={item.key}
                  title={<OptionTitle id={id} label={item.label} help={item.help} />}
                  action={
                    <Switch
                      id={id}
                      checked={provider.apiFeatures[item.key]}
                      onCheckedChange={(checked) => updateApiFeature(item.key, checked)}
                    />
                  }
                />
              )
            })}
          </div>
        ) : null}

        {showReasoningSummary ? (
          <>
            {options.length > 0 ? <div className={drawerClasses.divider} /> : null}
            <PageSidePanelItem
              title={
                <OptionTitle
                  id={apiOptionId(providerId, 'reasoning-summary')}
                  label={t('settings.provider.api.options.reasoning_summary.label')}
                  help={t('settings.provider.api.options.reasoning_summary.help')}
                />
              }
              action={
                <Select value={reasoningSummarySelection} onValueChange={updateReasoningSummary}>
                  <SelectTrigger
                    id={apiOptionId(providerId, 'reasoning-summary')}
                    aria-label={t('settings.provider.api.options.reasoning_summary.label')}
                    size="sm"
                    className="w-36 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_REASONING_SUMMARY}>
                      {t('settings.provider.api.options.reasoning_summary.default_auto')}
                    </SelectItem>
                    <SelectItem value={DISABLED_REASONING_SUMMARY}>
                      {t('settings.provider.api.options.reasoning_summary.off')}
                    </SelectItem>
                    <SelectItem value="auto">{t('settings.provider.api.options.reasoning_summary.auto')}</SelectItem>
                    <SelectItem value="concise">
                      {t('settings.provider.api.options.reasoning_summary.concise')}
                    </SelectItem>
                    <SelectItem value="detailed">
                      {t('settings.provider.api.options.reasoning_summary.detailed')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              }
            />
          </>
        ) : null}

        {isSupportAnthropicPromptCache ? (
          <>
            {options.length > 0 || showReasoningSummary ? <div className={drawerClasses.divider} /> : null}
            <div className="flex flex-col gap-4">
              <PageSidePanelItem
                title={
                  <OptionTitle
                    id={apiOptionId(providerId, 'cache-token-threshold')}
                    label={t('settings.provider.api.options.anthropic_cache.token_threshold')}
                    help={t('settings.provider.api.options.anthropic_cache.token_threshold_help')}
                  />
                }
                action={
                  <Input
                    id={apiOptionId(providerId, 'cache-token-threshold')}
                    type="number"
                    min={0}
                    max={CACHE_TOKEN_THRESHOLD_MAX}
                    value={tokenThresholdDraft}
                    onChange={(event) => setTokenThresholdDraft(event.target.value)}
                    onBlur={commitTokenThreshold}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }
                    }}
                    className={cn(drawerClasses.input, 'h-9 w-24 shrink-0 text-center')}
                  />
                }
              />

              {showCacheDetailOptions ? (
                <>
                  <PageSidePanelItem
                    title={
                      <OptionTitle
                        id={apiOptionId(providerId, 'cache-last-n')}
                        label={t('settings.provider.api.options.anthropic_cache.cache_last_n')}
                        help={t('settings.provider.api.options.anthropic_cache.cache_last_n_help')}
                      />
                    }
                    action={
                      <Input
                        id={apiOptionId(providerId, 'cache-last-n')}
                        type="number"
                        min={0}
                        max={CACHE_LAST_N_MAX}
                        value={cacheLastNDraft}
                        onChange={(event) => setCacheLastNDraft(event.target.value)}
                        onBlur={commitCacheLastNMessages}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur()
                          }
                        }}
                        className={cn(drawerClasses.input, 'h-9 w-24 shrink-0 text-center')}
                      />
                    }
                  />

                  <PageSidePanelItem
                    title={
                      <OptionTitle
                        id={apiOptionId(providerId, 'cache-system-message')}
                        label={t('settings.provider.api.options.anthropic_cache.cache_system')}
                        help={t('settings.provider.api.options.anthropic_cache.cache_system_help')}
                      />
                    }
                    action={
                      <Switch
                        id={apiOptionId(providerId, 'cache-system-message')}
                        checked={cacheSystemMessage}
                        onCheckedChange={(checked) =>
                          updateCacheSettings({
                            enabled: effectiveCacheTokenThreshold > 0,
                            tokenThreshold: effectiveCacheTokenThreshold,
                            cacheSystemMessage: checked
                          })
                        }
                      />
                    }
                  />
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </ProviderSettingsDrawer>
  )
}
