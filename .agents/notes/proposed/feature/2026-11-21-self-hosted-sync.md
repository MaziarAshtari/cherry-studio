# Agent Note: Self-hosted multi-device sync

Status: proposed

English | [中文](2026-11-21-self-hosted-sync.zh.md)

## Problem

Cherry Studio users with several desktops (Windows, macOS, Linux) can only move data between them through whole-profile backup and restore (local, WebDAV, S3, Nutstore). Restoring replaces the profile and relaunches the app, so it cannot keep two active installations converged, and concurrent edits on two devices are lost. Users who want continuous sync without a third-party cloud need a server they can run themselves with only a URL and a token on each client.

## Proposal

### Ownership

- `sync-server/` (repository root) is a standalone Node.js 24 server with no runtime npm dependencies: `node:http`, `node:sqlite` in WAL mode for records, and a content-addressed blob directory. It is deployed separately (Docker Compose or systemd behind Caddy/Nginx) and is not part of the Electron build.
- `src/main/services/selfHostedSync/` owns the client: the lifecycle service `SelfHostedSyncService`, the `SyncEngine`, a private sync-state SQLite file (`feature.self_hosted_sync.data`), and the HTTP/SSE transport.
- `src/renderer/pages/settings/DataSettings/SelfHostedSync/` owns the settings panel; it talks to main only through IpcApi routes `self_hosted_sync.*` and the `self_hosted_sync.status_changed` event.
- Upstream files receive registration glue only: service registry, path registry, IpcApi schema and handler registries, the Data settings menu, and appended locale keys.

### Protocol

Every synced row is one entity keyed `<table>:<JSON primary key>`. The server stores the latest version per entity with a monotonic revision. `POST /api/v1/sync/push` resolves each change with Last-Write-Wins on the UTC `updatedAt` in milliseconds, breaking ties by device id, and answers `accepted`, `rejected` (with the winning record) or `merged` (identical content). Deletions are tombstones that win over older writes. `GET /api/v1/sync/changes` returns records after a revision cursor, filtered by category. `GET /api/v1/sync/events` is an SSE stream announcing new revisions. Blobs are stored once per SHA-256 and verified on upload. All endpoints except health require `Authorization: Bearer <SYNC_AUTH_TOKEN>`; the server refuses to start without a token of at least 24 characters.

### Client change detection and apply

- The engine diffs the synced tables against a shadow of the last synced content hash per entity. A changed hash becomes an outgoing change and a vanished shadow entry becomes a tombstone, so no upstream data service needs a change hook. `updated_at` and device-local columns are excluded from the hash.
- Local writes are noticed through SQLite `total_changes()` on the app's single connection and pushed after a 3 s debounce (at most 30 s). Startup runs a full pull-then-push; SSE revisions trigger a pull; polling every 5 minutes (1 minute without SSE) is the fallback; "Sync Now" runs a full cycle.
- Incoming pages are applied in one transaction with a savepoint per row and repeated passes for FK ordering. Optional references to rows this device lacks become NULL; anything still failing is kept in a pending queue and retried. Cursors advance only after commit. A local unpushed edit that is newer than the incoming version is kept and wins on the next push.
- Remote writes update the shadow from the stored row and reset the `total_changes()` watermark, so applied changes are never echoed back.
- Categories map to tables: chats (`topic`, `message`), assistants (`assistant`, `agent`, `prompt`, groups and bindings), providers (`user_provider`, `user_model`), MCP (`mcp_server`), settings (`preference` rows except device-local keys such as paths, proxy, backup targets and local servers), files (`file_entry` and attachment/avatar/logo refs), knowledge (`knowledge_base`, `knowledge_item`). Disabled categories are neither pushed nor applied; re-enabling one resets its cursor and shadow so it catches up.
- Files and knowledge material travel as blobs. Internal files land at their internal path; an external file whose path does not exist on the receiving OS is localized into internal storage. Knowledge items carry their base-relative POSIX material paths, unsafe paths are rejected, index status stays per device, and received items are re-indexed locally because vector stores are not portable.

## Alternatives considered

- Reuse the backup/restore pipeline on a timer: rejected because restore replaces the whole profile and relaunches, losing concurrent edits.
- Hook every DataApi service to emit change events: rejected for upstream diff size and merge risk; the shadow diff finds the same changes from the database alone.
- Store sync settings in Preferences: rejected because preference keys are generated from the data-classification pipeline, which would add upstream churn, and the settings category would then sync its own configuration.
- Client-side end-to-end encryption: out of scope; the server is meant to run on a machine the user controls behind HTTPS.
- Express/Fastify plus better-sqlite3 on the server: rejected in favour of zero runtime dependencies so the Docker image needs no native build.

## Acceptance criteria

- AC1 — The server rejects requests without the configured bearer token and refuses to start without a token (verification: unit)
- AC2 — Pushes receive monotonic revisions and pulls return only records after the cursor, paged and filtered by category (verification: unit)
- AC3 — Concurrent edits converge to the newer version on every device, ties resolve by device id, and deletions are not resurrected by stale writes (verification: unit)
- AC4 — Disabled categories are neither pushed nor overwritten, and re-enabling one catches up (verification: unit)
- AC5 — Identical blobs are uploaded once and attachment and knowledge file content arrives on the other device (verification: unit)
- AC6 — Rows applied from the server are not pushed back (verification: unit)
- AC7 — Two Electron clients configured with the same server converge on chats, assistants, providers, MCP servers, settings, attachments and knowledge bases, including live updates over SSE (verification: Electron)

## Risks

- Clock skew between devices biases LWW; the client bumps a locally modified entity past its last synced timestamp, but large skew can still make an older edit win.
- Messages are synced per row, so a conversation edited on two devices at once can mix branches; each row still converges.
- The first sync of a large profile pushes every row and blob; batches are capped at 200 changes or 8 MiB.
- Preferences are applied through `PreferenceService.setMultiple` after the row transaction, so they are not part of the same atomic commit.
- The token and synced API keys are stored in plain text on the server disk and in the local sync state file, matching existing WebDAV/S3 settings.
