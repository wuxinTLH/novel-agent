# models 服务与用户边界

## 组织方式

`server/index.ts` 仅负责环境、数据锁、服务装配、监听及关闭。业务按独立模块放在 `server/models/`，当前为同进程服务，不是需要分别部署的微服务。

- `context.ts`：Store、Runner、PlatformRuntime、模型提供方共享上下文，以及 FeatureService 接口。
- `application.ts` / `registry.ts`：显式注册、服务顺序、重复标识校验。
- `http.ts`：统一来源、CSRF、频率、请求体、安全头、静态资源及错误处理。扩展服务不得绕过该层。
- `model-provider.ts` / `model-settings.ts`：模型连接、密钥持久化及配置 API。
- `projects.ts`：小说管理、项目查找和运行中变更约束。
- `workflow.ts` / `workflow-support.ts` / `project-operations.ts`：工作流、节点、图校验、持久化失败回滚。
- `assets.ts`：设定、上传和设定输出采纳。
- `generation.ts` / `chapters.ts`：生成、要求、候选、幂等执行、取消及章节版本。
- `platform.ts`：平台连接、绑定、发布队列等已有平台子服务适配。
- `user.ts`：保留 User 身份/数据目录边界；实际认证与租户装配由 `auth.ts` / `tenant-application.ts` 负责。
- `sqlconnect.ts` / `sqlconnect-drivers.ts`：数据库连接及显式初始化，原连接说明见 [SQLconnect](sqlconnect.md)。
- `document-storage.ts` / `storage-config.ts`：文档后端绑定、存储激活清单及 owner 选择。
- `postgres-storage.ts` / `postgres-bridge.ts` / `postgres-worker.ts`：PostgreSQL 文档快照、v2 迁移、版本校验及同步提交桥接。
- `server/admin.ts`：停服后显式执行的本地管理 CLI，不通过 HTTP 暴露管理员引导。

保留现有业务 API 路径及 JSON 文档结构，不自动重写数据。注册扩展使用 FeatureService，并在应用统一防护后装配。应用工厂只注册服务路由，不自动托管关闭钩子；自定义服务还须加入入口的关闭列表，在关闭时显式等待其 close 钩子。

## 认证与不可变租户上下文

`GET /api/services/user` 和 `GET /api/auth/session` 报告当前状态。认证默认关闭，仍使用原数据目录及单用户行为；不是安装后自动要求登录。停服后先以 `bootstrap-admin` 本地创建超级管理员，再用 `enable-auth --owner UUID` 显式指定旧数据归属，或仅在没有旧业务文档的新目录使用 `--no-legacy`。完整命令见 [使用手册](使用手册.md#认证与本地管理-cli)。首次登录不自动接管旧数据；`assign-legacy --owner UUID` 是显式归属操作，不是任意跨用户搬迁工具，已有归属或 SQL owner 冲突会拒绝。

启用后只信任服务端验证的会话，不接受 `X-User-Id`、查询参数或客户端自报 owner 作为身份。每个稳定用户 UUID 拥有独立缓存的应用与不可变 owner 上下文，包含 Store、Runner、ModelSecretStore、PlatformRuntime、发布队列和上传路由；不通过切换共享单例的“当前用户”实现隔离。显式指定的 legacy owner 使用原数据目录，其余用户使用 `DATA_DIR/users/<SHA-256(user UUID)>`；SQL 文档按验证身份的 owner 分区。未认证请求失败关闭，不回落到共享目录。超级管理员管理身份及 SQLconnect，不等于可浏览其他租户小说或平台凭据。

认证提供 scrypt 密码校验、HttpOnly / SameSite=Strict 会话 Cookie、会话与登录前 CSRF、登录限流、用户创建 / 停用及最后超级管理员保护。业务写入仍经过既有 `X-Platform-CSRF`，认证模式另校验 `X-CSRF-Token`。停用用户撤销其会话；退出不等于取消已启动的后台任务。租户运行时缓存在服务进程内，服务关闭时取消运行并关闭平台浏览器。

Cloudflare Turnstile 默认关闭；管理员可设置 site key、secret、action、hostname。secret 加密保存，浏览器只见公开配置 / hasSecret；启用后登录向 Cloudflare siteverify 核对 success、action、hostname，缺失、网络失败或不匹配均拒绝。需要真实 Cloudflare 密钥、匹配域名及网络，离线桩不证明真实在线验收。

认证状态默认在本地 `auth.json`，SQL 激活后存全局认证文档；`auth.key` 始终留在本地，按 `0600` 创建 / 收紧，Windows ACL 仍需人工设置。当前入口维持可信私网 HTTP 及既有来源限制，Cookie 未自动切换为公网 HTTPS 部署方案；认证不代表可安全直接暴露公网。

## PostgreSQL 文档快照与迁移边界

设置页继续保存 `DATA_DIR/sqlconnect.json`；配置或旧初始化按钮都不会激活业务存储。SQL 激活后界面禁止修改 / 清除连接配置或再次初始化，连接维护须由本地管理员停服处理。只有 PostgreSQL 有业务文档后端，MySQL / SQL Server 的连接探测和预留表不构成业务支持。停服、完整备份后显式执行 `npm run admin -- migrate-sql --owner <UUID> --confirm`，才会使用该 PostgreSQL 配置执行 v1 初始化及 v2 迁移、按 owner 导入并回读核对文档，写入本地 `business-storage.json` 激活清单。数据库需预先创建，部署需保留 `server/models/sql/` 初始化与迁移资源。

导入前必须本地引导超级管理员；owner 必须对应已有未禁用身份的 UUID，不能任意生成。首次迁移拒绝已有额外本地租户目录，不自动汇总其他租户；仅有账号但未产生租户目录不在此拒绝范围。建议先迁移再启用认证。已有 legacy / SQL 归属冲突会拒绝。同一来源哈希有导入记录，非空目标不盲目覆盖；激活后的旧 JSON 仅为历史快照，改动旧文件不会触发重新导入。SQL 配置、连接或提交出错时失败关闭，不悄悄回落旧 JSON。

业务仅把 `projects.json`、`models.json`、`platform-connections.json`、`publication-queue.json` 作为完整 JSON 文档快照存入 PostgreSQL；不是把章节、模型和发布任务全面改造成规范化 SQL 表。认证另用保留的全局 owner 文档。文档写入使用 owner 行锁和期望 revision；确认实际 `COMMIT` 后才返回，不是后台延迟落库。现有同步持久化屏障由 `spawnSync` 子进程桥接，因此会阻塞服务事件循环，每次桥接操作新建数据库连接。结果未知时停止当前存储，需重启并核对持久状态，不能盲目重试远端写入。

**运行边界仍是单服务进程与本地数据锁。** PostgreSQL 行锁 / CAS 不是跨主机租约，不保护重复生成、浏览器或远端发布等外部副作用；不要跨主机或多实例共享同一 owner 运行服务。

上传、模型密钥、加密密钥、平台秘密和浏览器配置仍在各租户本地目录。恢复必须覆盖完整数据目录、独立保存的密钥和数据库。CLI 的 `admin-backups` 只复制选定根目录文件，SQL 激活后额外捕获清单 owner 的四类文档及全局认证快照；不遍历全部租户 / 上传 / 浏览器文件，也不是全库备份或自动恢复工具。备份含明文数据库密码等敏感数据，必须保护权限。
