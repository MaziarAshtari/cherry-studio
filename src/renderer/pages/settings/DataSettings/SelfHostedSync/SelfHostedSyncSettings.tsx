import dayjs from 'dayjs'
import { Eye, EyeOff, PlugZap, RefreshCw } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input, RowFlex, Switch } from '@cherrystudio/ui'
import {
  SettingDescription,
  SettingDivider,
  SettingGroup,
  SettingHelpText,
  SettingRow,
  SettingRowTitle,
  SettingTitle
} from '@renderer/components/SettingsPrimitives'
import { useTheme } from '@renderer/hooks/useTheme'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { settingsControlClasses } from '@renderer/pages/settings/settingsStyles'
import { toast } from '@renderer/services/toast'
import {
  SELF_HOSTED_SYNC_CATEGORIES,
  type SelfHostedSyncCategory,
  type SelfHostedSyncConfig,
  type SelfHostedSyncState,
  type SelfHostedSyncStatus
} from '@shared/types/selfHostedSync'

const STATE_COLORS: Record<SelfHostedSyncState, string> = {
  disabled: 'var(--muted-foreground)',
  idle: 'var(--muted-foreground)',
  connected: 'var(--success, #22c55e)',
  syncing: 'var(--primary)',
  error: 'var(--error)'
}

const STATE_LABEL_KEYS: Record<SelfHostedSyncState, string> = {
  disabled: 'settings.data.self_hosted_sync.state.disabled',
  idle: 'settings.data.self_hosted_sync.state.idle',
  connected: 'settings.data.self_hosted_sync.state.connected',
  syncing: 'settings.data.self_hosted_sync.state.syncing',
  error: 'settings.data.self_hosted_sync.state.error'
}

const CATEGORY_LABEL_KEYS: Record<SelfHostedSyncCategory, string> = {
  chats: 'settings.data.self_hosted_sync.categories.chats',
  assistants: 'settings.data.self_hosted_sync.categories.assistants',
  providers: 'settings.data.self_hosted_sync.categories.providers',
  mcp: 'settings.data.self_hosted_sync.categories.mcp',
  settings: 'settings.data.self_hosted_sync.categories.settings',
  files: 'settings.data.self_hosted_sync.categories.files',
  knowledge: 'settings.data.self_hosted_sync.categories.knowledge'
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

type ConfigPatch = Partial<Omit<SelfHostedSyncConfig, 'categories'>> & {
  categories?: Partial<Record<SelfHostedSyncCategory, boolean>>
}

const SelfHostedSyncSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [config, setConfig] = useState<SelfHostedSyncConfig | null>(null)
  const [status, setStatus] = useState<SelfHostedSyncStatus | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ipcApi
      .request('self_hosted_sync.get_state')
      .then((snapshot) => {
        if (cancelled) return
        setConfig(snapshot.config)
        setStatus(snapshot.status)
        setServerUrl(snapshot.config.serverUrl)
        setAuthToken(snapshot.config.authToken)
        setDeviceName(snapshot.config.deviceName)
      })
      .catch((error: unknown) => toast.error(errorMessage(error)))
    return () => {
      cancelled = true
    }
  }, [])

  useIpcOn('self_hosted_sync.status_changed', setStatus)

  const update = useCallback(async (patch: ConfigPatch) => {
    try {
      const snapshot = await ipcApi.request('self_hosted_sync.update_config', patch)
      setConfig(snapshot.config)
      setStatus(snapshot.status)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }, [])

  const saveConnectionField = (field: 'serverUrl' | 'authToken' | 'deviceName', value: string) => {
    if (config && config[field] !== value.trim()) void update({ [field]: value })
  }

  const handleTestConnection = async () => {
    setTesting(true)
    try {
      await ipcApi.request('self_hosted_sync.test_connection', { serverUrl, authToken, deviceName })
      toast.success(t('settings.data.self_hosted_sync.test.success'))
    } catch (error) {
      toast.error(t('settings.data.self_hosted_sync.test.failed', { message: errorMessage(error) }))
    } finally {
      setTesting(false)
    }
  }

  const handleSyncNow = async () => {
    try {
      await ipcApi.request('self_hosted_sync.sync_now')
      toast.success(t('settings.data.self_hosted_sync.sync_now.success'))
    } catch (error) {
      toast.error(t('settings.data.self_hosted_sync.sync_now.failed', { message: errorMessage(error) }))
    }
  }

  if (!config || !status) return null

  const hasConnection = serverUrl.trim() !== '' && authToken.trim() !== ''
  const syncing = status.state === 'syncing'

  return (
    <>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.self_hosted_sync.title')}</SettingTitle>
        <SettingDescription>{t('settings.data.self_hosted_sync.description')}</SettingDescription>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.enabled')}</SettingRowTitle>
          <Switch
            checked={config.enabled}
            disabled={!config.enabled && !hasConnection}
            onCheckedChange={(enabled) => void update({ enabled, serverUrl, authToken, deviceName })}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.server_url.label')}</SettingRowTitle>
          <Input
            type="url"
            placeholder={t('settings.data.self_hosted_sync.server_url.placeholder')}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={() => saveConnectionField('serverUrl', serverUrl)}
            className={settingsControlClasses.text}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.auth_token.label')}</SettingRowTitle>
          <RowFlex className="items-center gap-1">
            <Input
              type={tokenVisible ? 'text' : 'password'}
              placeholder={t('settings.data.self_hosted_sync.auth_token.placeholder')}
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              onBlur={() => saveConnectionField('authToken', authToken)}
              className={settingsControlClasses.text}
              autoComplete="off"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(
                tokenVisible
                  ? 'settings.data.self_hosted_sync.auth_token.hide'
                  : 'settings.data.self_hosted_sync.auth_token.show'
              )}
              onClick={() => setTokenVisible((visible) => !visible)}>
              {tokenVisible ? <EyeOff size={14} /> : <Eye size={14} />}
            </Button>
          </RowFlex>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.device_name')}</SettingRowTitle>
          <Input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            onBlur={() => saveConnectionField('deviceName', deviceName)}
            className={settingsControlClasses.text}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.actions')}</SettingRowTitle>
          <RowFlex className="flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={handleTestConnection} disabled={!hasConnection || testing}>
              <PlugZap size={14} />
              {t('settings.data.self_hosted_sync.test.button')}
            </Button>
            <Button variant="outline" onClick={handleSyncNow} disabled={!hasConnection || syncing}>
              <RefreshCw size={14} className={syncing ? 'animate-spin' : undefined} />
              {t('settings.data.self_hosted_sync.sync_now.button')}
            </Button>
          </RowFlex>
        </SettingRow>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.self_hosted_sync.status.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.status.state')}</SettingRowTitle>
          <span style={{ color: STATE_COLORS[status.state] }}>{t(STATE_LABEL_KEYS[status.state])}</span>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.data.self_hosted_sync.status.last_sync')}</SettingRowTitle>
          <span style={{ color: 'var(--muted-foreground)' }}>
            {status.lastSyncAt
              ? dayjs(status.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')
              : t('settings.data.self_hosted_sync.status.never')}
          </span>
        </SettingRow>
        {status.lastError && (
          <>
            <SettingDivider />
            <SettingHelpText style={{ color: 'var(--error)' }}>
              {t('settings.data.self_hosted_sync.status.error', { message: status.lastError })}
            </SettingHelpText>
          </>
        )}
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.data.self_hosted_sync.categories.title')}</SettingTitle>
        <SettingDescription>{t('settings.data.self_hosted_sync.categories.description')}</SettingDescription>
        {SELF_HOSTED_SYNC_CATEGORIES.map((category) => (
          <div key={category}>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t(CATEGORY_LABEL_KEYS[category])}</SettingRowTitle>
              <Switch
                checked={config.categories[category]}
                onCheckedChange={(checked) => void update({ categories: { [category]: checked } })}
              />
            </SettingRow>
          </div>
        ))}
      </SettingGroup>
    </>
  )
}

export default SelfHostedSyncSettings
