# Agent Note: 自托管多设备同步

Status: proposed

[English](2026-11-21-self-hosted-sync.md) | 中文

## Problem

拥有多台桌面设备（Windows、macOS、Linux）的 Cherry Studio 用户，目前只能通过整份配置的备份与恢复（本地、WebDAV、S3、坚果云）在设备间迁移数据。恢复会替换整个配置并重启应用，无法让两台正在使用的设备持续保持一致，两台设备上的并发修改也会丢失。希望不依赖第三方云服务、持续同步的用户，需要一个可以自行部署、客户端只需地址和令牌即可连接的服务器。

## Proposal

### 归属

- 仓库根目录的 `sync-server/` 是独立的 Node.js 24 服务器，没有运行时 npm 依赖：使用 `node:http`、WAL 模式的 `node:sqlite` 存储记录，以及按内容寻址的 blob 目录。它单独部署（Docker Compose 或 systemd，前置 Caddy/Nginx），不属于 Electron 构建。
- `src/main/services/selfHostedSync/` 负责客户端：生命周期服务 `SelfHostedSyncService`、`SyncEngine`、独立的同步状态 SQLite 文件（`feature.self_hosted_sync.data`）以及 HTTP/SSE 传输。
- `src/renderer/pages/settings/DataSettings/SelfHostedSync/` 负责设置面板，只通过 IpcApi 路由 `self_hosted_sync.*` 与 `self_hosted_sync.status_changed` 事件和主进程通信。
- 上游文件只增加注册代码：服务注册表、路径注册表、IpcApi schema 与 handler 注册表、数据设置菜单，以及追加的语言键。

### 协议

每个同步行都是一个实体，键为 `<表名>:<JSON 主键>`。服务器为每个实体保存最新版本并分配单调递增的 revision。`POST /api/v1/sync/push` 按 UTC 毫秒时间戳 `updatedAt` 进行最后写入优先（LWW）裁决，时间相同时比较设备 ID，返回 `accepted`、`rejected`（附带胜出记录）或 `merged`（内容相同）。删除以墓碑记录保存，并优先于更早的写入。`GET /api/v1/sync/changes` 按分类返回游标之后的记录。`GET /api/v1/sync/events` 是通告新 revision 的 SSE 流。blob 按 SHA-256 只存一份，上传时校验。除健康检查外的所有接口都要求 `Authorization: Bearer <SYNC_AUTH_TOKEN>`；令牌缺失或少于 24 个字符时服务器拒绝启动。

### 客户端变更检测与应用

- 引擎将同步表与"上次同步内容哈希"的影子表对比。哈希变化即为待推送的变更，影子表中消失的条目即为墓碑，因此上游数据服务无需任何变更钩子。`updated_at` 与设备本地列不参与哈希。
- 通过应用唯一连接上的 SQLite `total_changes()` 发现本地写入，防抖 3 秒（最长 30 秒）后推送。启动时执行完整的先拉后推；SSE 通告触发拉取；每 5 分钟（无 SSE 时每 1 分钟）轮询作为兜底；"立即同步"执行完整周期。
- 每页远端变更在一个事务中应用，每行使用独立保存点，并多轮处理外键顺序。指向本机不存在的行的可选引用置为 NULL；仍失败的记录进入待处理队列稍后重试。游标只在提交后前进。若本地未推送的修改比远端版本更新，则保留本地修改并在下次推送时胜出。
- 远端写入会按落库后的行更新影子表并重置 `total_changes()` 水位，已应用的变更不会被回推。
- 分类与表的对应：对话（`topic`、`message`）、助手（`assistant`、`agent`、`prompt`、分组与绑定）、服务商（`user_provider`、`user_model`）、MCP（`mcp_server`）、设置（`preference` 中除路径、代理、备份目标、本地服务等设备相关键以外的行）、文件（`file_entry` 及附件/头像/图标引用）、知识库（`knowledge_base`、`knowledge_item`）。未启用的分类既不推送也不应用；重新启用时重置该分类的游标和影子表以补齐数据。
- 文件与知识库素材以 blob 传输。内部文件写入其内部路径；外部文件在接收端系统上不存在时转为内部存储。知识库条目携带相对于知识库的 POSIX 素材路径，不安全的路径会被拒绝；索引状态按设备保存，由于向量库不可跨系统移植，接收到的条目在本地重新索引。

## Alternatives considered

- 定时复用备份/恢复流程：已否决，因为恢复会替换整个配置并重启，丢失并发修改。
- 为每个 DataApi 服务添加变更事件：已否决，上游改动量和合并风险过大；影子表对比仅凭数据库即可发现同样的变更。
- 将同步设置存入 Preferences：已否决，偏好键由数据分类流水线生成，会带来上游改动，而且设置分类会同步自身配置。
- 客户端端到端加密：不在本次范围内；服务器预期运行在用户自己控制的机器上并通过 HTTPS 访问。
- 服务器使用 Express/Fastify 加 better-sqlite3：为了零运行时依赖、Docker 镜像无需原生编译而否决。

## Acceptance criteria

- AC1 — 服务器拒绝未携带配置令牌的请求，且在缺少令牌时拒绝启动 (verification: unit)
- AC2 — 推送获得单调递增的 revision，拉取只返回游标之后的记录，并支持分页和分类过滤 (verification: unit)
- AC3 — 并发修改在每台设备上收敛到较新版本，时间相同时按设备 ID 裁决，删除不会被过期写入恢复 (verification: unit)
- AC4 — 未启用的分类既不推送也不被覆盖，重新启用后会补齐 (verification: unit)
- AC5 — 相同 blob 只上传一次，附件和知识库文件内容到达另一台设备 (verification: unit)
- AC6 — 从服务器应用的行不会被回推 (verification: unit)
- AC7 — 两个连接同一服务器的 Electron 客户端在对话、助手、服务商、MCP 服务器、设置、附件和知识库上收敛，并通过 SSE 实时更新 (verification: Electron)

## Risks

- 设备间时钟偏差会影响 LWW；客户端会把本地修改的时间戳推到上次同步时间之后，但偏差过大时较旧的修改仍可能胜出。
- 消息按行同步，同一对话在两台设备上同时编辑时可能混合分支，但每一行仍会收敛。
- 大型配置首次同步会推送所有行和 blob；每批最多 200 条变更或 8 MiB。
- 偏好通过 `PreferenceService.setMultiple` 在行事务之后应用，不属于同一个原子提交。
- 令牌与同步的 API 密钥以明文保存在服务器磁盘和本地同步状态文件中，与现有 WebDAV/S3 设置一致。
