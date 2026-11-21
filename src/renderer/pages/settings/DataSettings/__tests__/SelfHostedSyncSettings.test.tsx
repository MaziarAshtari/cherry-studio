import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { t } from 'i18next'
import { afterEach, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'
import {
  DEFAULT_SELF_HOSTED_SYNC_CATEGORIES,
  type SelfHostedSyncConfig,
  type SelfHostedSyncSnapshot
} from '@shared/types/selfHostedSync'

import SelfHostedSyncSettings from '../SelfHostedSync/SelfHostedSyncSettings'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseConfig: SelfHostedSyncConfig = {
  enabled: false,
  serverUrl: '',
  authToken: '',
  deviceName: 'laptop',
  categories: { ...DEFAULT_SELF_HOSTED_SYNC_CATEGORIES }
}

function mockSync(initial: SelfHostedSyncConfig) {
  let config = initial
  const snapshot = (): SelfHostedSyncSnapshot => ({
    config,
    status: { state: config.enabled ? 'connected' : 'disabled', deviceId: 'dev-1', lastSyncAt: null, lastError: null }
  })
  const request = vi.spyOn(ipcApi, 'request').mockImplementation((async (route: string, input?: any) => {
    if (route === 'self_hosted_sync.get_state') return snapshot()
    if (route === 'self_hosted_sync.update_config') {
      config = { ...config, ...input, categories: { ...config.categories, ...input.categories } }
      return snapshot()
    }
    if (route === 'self_hosted_sync.test_connection') return { latestRevision: 3, serverTime: 1 }
    throw new Error(`Unexpected route ${route}`)
  }) as never)
  return request
}

it('cannot be enabled until a server URL and token are entered, then saves them when enabling', async () => {
  const request = mockSync(baseConfig)
  render(<SelfHostedSyncSettings />)

  const toggle = (await screen.findAllByRole('switch'))[0]
  expect(toggle).toBeDisabled()
  const testButton = screen.getByRole('button', { name: t('settings.data.self_hosted_sync.test.button') })
  expect(testButton).toBeDisabled()

  fireEvent.change(screen.getByPlaceholderText(t('settings.data.self_hosted_sync.server_url.placeholder')), {
    target: { value: 'https://sync.example.com' }
  })
  fireEvent.change(screen.getByPlaceholderText(t('settings.data.self_hosted_sync.auth_token.placeholder')), {
    target: { value: 'secret-token' }
  })
  expect(toggle).toBeEnabled()

  fireEvent.click(testButton)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('self_hosted_sync.test_connection', {
      serverUrl: 'https://sync.example.com',
      authToken: 'secret-token',
      deviceName: 'laptop'
    })
  )

  fireEvent.click(toggle)
  expect(await screen.findByText(t('settings.data.self_hosted_sync.state.connected'))).toBeInTheDocument()
})

it('masks the token until revealed', async () => {
  mockSync({ ...baseConfig, serverUrl: 'https://sync.example.com', authToken: 'secret-token' })
  render(<SelfHostedSyncSettings />)

  const tokenInput = await screen.findByDisplayValue('secret-token')
  expect(tokenInput).toHaveAttribute('type', 'password')
  fireEvent.click(screen.getByRole('button', { name: t('settings.data.self_hosted_sync.auth_token.show') }))
  expect(tokenInput).toHaveAttribute('type', 'text')
})

it('offers one toggle per sync category and persists changes', async () => {
  mockSync({ ...baseConfig, serverUrl: 'https://sync.example.com', authToken: 'secret-token', enabled: true })
  render(<SelfHostedSyncSettings />)

  const switches = await screen.findAllByRole('switch')
  // Enable toggle + seven categories.
  expect(switches).toHaveLength(8)
  const mcpSwitch = switches[1 + Object.keys(DEFAULT_SELF_HOSTED_SYNC_CATEGORIES).indexOf('mcp')]
  expect(mcpSwitch).toBeChecked()
  fireEvent.click(mcpSwitch)
  await waitFor(() => expect(mcpSwitch).not.toBeChecked())
})
