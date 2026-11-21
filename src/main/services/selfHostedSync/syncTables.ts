import type { SelfHostedSyncCategory } from '@shared/types/selfHostedSync'

export type SyncTableKind = 'generic' | 'preference' | 'file_entry' | 'knowledge_item'

export interface SyncTableSpec {
  table: string
  category: SelfHostedSyncCategory
  kind: SyncTableKind
  /** Columns that never leave the device (machine state or trigger-maintained). */
  localColumns?: readonly string[]
}

/** Columns maintained by triggers or local runtime; never synced for any table. */
export const GLOBAL_LOCAL_COLUMNS: readonly string[] = ['fts_rowid', 'searchable_text']

/**
 * Synced tables in FK-friendly apply order (parents first). Deletions run in reverse.
 * Agent sessions, workspaces, jobs and other runtime/machine-bound tables are deliberately absent.
 */
export const SYNC_TABLES: readonly SyncTableSpec[] = [
  { table: 'user_provider', category: 'providers', kind: 'generic' },
  { table: 'user_model', category: 'providers', kind: 'generic' },
  { table: 'mcp_server', category: 'mcp', kind: 'generic' },
  { table: 'group', category: 'assistants', kind: 'generic' },
  { table: 'assistant', category: 'assistants', kind: 'generic' },
  { table: 'agent', category: 'assistants', kind: 'generic' },
  { table: 'prompt', category: 'assistants', kind: 'generic' },
  { table: 'prompt_binding', category: 'assistants', kind: 'generic' },
  { table: 'assistant_mcp_server', category: 'assistants', kind: 'generic' },
  { table: 'agent_mcp_server', category: 'assistants', kind: 'generic' },
  { table: 'knowledge_base', category: 'knowledge', kind: 'generic' },
  // Index status is per-device: each device re-indexes received items with its own vector store.
  { table: 'knowledge_item', category: 'knowledge', kind: 'knowledge_item', localColumns: ['status', 'error'] },
  { table: 'assistant_knowledge_base', category: 'assistants', kind: 'generic' },
  { table: 'agent_knowledge_base', category: 'assistants', kind: 'generic' },
  { table: 'topic', category: 'chats', kind: 'generic' },
  { table: 'message', category: 'chats', kind: 'generic' },
  { table: 'file_entry', category: 'files', kind: 'file_entry' },
  { table: 'chat_message_file_ref', category: 'files', kind: 'generic' },
  { table: 'assistant_avatar_file_ref', category: 'files', kind: 'generic' },
  { table: 'agent_avatar_file_ref', category: 'files', kind: 'generic' },
  { table: 'provider_logo_file_ref', category: 'files', kind: 'generic' },
  { table: 'preference', category: 'settings', kind: 'preference' }
]

/**
 * Preference keys that describe this machine (paths, windows, proxies, local servers, backup targets)
 * rather than the user's portable preferences.
 */
const DEVICE_LOCAL_PREFERENCE_PREFIXES: readonly string[] = [
  'data.backup.',
  'data.trash.',
  'app.proxy.',
  'app.tray.',
  'app.power.',
  'app.dist.',
  'app.zoom_factor',
  'app.use_system_title_bar',
  'app.computer_use.',
  'app.browser.',
  'app.spell_check.',
  'feature.api_gateway.',
  'feature.remote_access.',
  'feature.local_model.',
  'feature.binary.',
  'feature.openclaw.',
  'feature.code_cli.',
  'feature.selection.',
  'feature.screenshot.',
  'ui.window_style'
]

const DEVICE_LOCAL_PREFERENCE_PATTERN = /(^|[._])(path|paths|dir|directory|folder|location)($|[._])/

export function isSyncablePreferenceKey(key: string): boolean {
  if (DEVICE_LOCAL_PREFERENCE_PREFIXES.some((prefix) => key.startsWith(prefix))) return false
  return !DEVICE_LOCAL_PREFERENCE_PATTERN.test(key)
}

export function tablesForCategories(enabled: ReadonlySet<SelfHostedSyncCategory>): SyncTableSpec[] {
  return SYNC_TABLES.filter((spec) => enabled.has(spec.category))
}

export function getTableSpec(table: string): SyncTableSpec | undefined {
  return SYNC_TABLES.find((spec) => spec.table === table)
}
