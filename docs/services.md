# models 服务与用户边界

## 组织方式

[server/index.ts](../server/index.ts) 负责环境、数据锁、服务装配、监听及关闭。业务按模块放在 [server/models/](../server/models/)，当前是一个应用内的控制面、租户 Worker 和数据库 Worker，不是分别部署的分布式微服务。

- `context.ts`：Store、Runner、PlatformRuntime、模型提供方共享上下文，以及 FeatureService 接口。
- `application.ts` / `registry.ts`：显式注册、服务顺序、重复标识校验。
- `http.ts`：统一来源、CSRF、频率、请求体、安全头、静态资源及错误处理。扩展服务不得绕过该层。
- `model-provider.ts` / `model-settings.ts`：模型连接、密钥持久化及配置 API。
- `projects.ts`：小说管理、项目查找和运行中变更约束。
- `workflow.ts` / `workflow-support.ts` / `project-operations.ts`：工作流、节点、图校验、持久化失败回滚。
- `assets.ts`：设定、上传和设定输出采纳。
- `generation.ts` / `chapters.ts`：生成、要求、候选、幂等执行、取消及章节版本。
- `platform.ts`：平台连接、绑定、发布队列等已有平台子服务适配。
- `auth.ts` / `administration.ts`：身份、会话、角色及默认关闭认证时的严格本机管理入口。
- `isolated-tenant-application.ts` / `tenant-runtime-worker.ts`：控制面转发到固定 owner 的隔离租户运行时。
- `sqlconnect.ts` / `sqlconnect-drivers.ts`：原连接探测及预留表初始化；见 [SQLconnect](sqlconnect.md)。
- `document-storage.ts` / `storage-config.ts` / [shared/storage.ts](../shared/storage.ts)：文档边界、v3 多数据库配置、owner 映射与激活清单。
- `relational-storage.ts` / `pooled-storage-bridge.ts` / `database-worker.ts`：v3 关系存储、持久连接池及同步持久化桥接。
- [server/admin.ts](../server/admin.ts)：停服后的身份引导及旧 PostgreSQL v2 迁移 CLI。
- [server/maintenance-cli.ts](../server/maintenance-cli.ts) / [server/maintenance.ts](../server/maintenance.ts)：离线全量应用备份、恢复、全部租户迁移。

保留现有业务 API 路径及应用文档结构，不自动重写旧数据。扩展使用 FeatureService，并在统一防护后装配；自定义服务须加入入口关闭列表并等待 close 钩子。

## 认证、管理与不可变租户上下文

认证、Turnstile 仍默认关闭。`GET /api/services/user` 和 `GET /api/auth/session` 报告状态；安装、创建账号、配置数据库或迁移都不会自动开启认证。首次超级管理员仍须停服后通过 `bootstrap-admin` CLI 创建，没有公开注册 / HTTP 引导。显式 `enable-auth --owner UUID` 才指定旧数据归属并开启认证；没有旧资产的新目录才可选 `--no-legacy`。见 [操作手册](使用手册.md#认证与本地管理-cli)。

管理界面分“用户、数据库、备份与维护、系统与安全”。认证关闭时，本机管理员权限同时要求真实 socket 回环地址、本机 HTTP Host、存在时的本机 Origin，并拒绝 cross-site；写操作还需 `X-Admin-CSRF`。不信任 forwarded headers，局域网访问免登录业务不等于拥有管理员权限。认证开启后须已验证的超级管理员会话，写入另需认证 CSRF；超级管理员不能据此浏览其他租户业务或秘密。

身份只来自服务端验证会话，不接受 `X-User-Id`、查询参数或客户端自报 owner。legacy owner 沿用原目录，其余用户使用 `DATA_DIR/users/<SHA-256(user UUID)>`；SQL 按 owner 隔离。每个租户 Worker 有固定 owner 的 Store、Runner、密钥、平台浏览器、队列及上传。未认证请求失败关闭，不回落共享目录。最多保留 32 个租户运行时，达到容量返回 `TENANT_RUNTIME_CAPACITY`，不是自动无界扩容。

密码采用 scrypt；会话 Cookie 为 HttpOnly / SameSite=Strict。普通用户可修改自己的密码、查看 / 撤销自己的会话；改密撤销该用户全部旧会话。管理员可创建、启停用户、改角色、重置密码、查看 / 撤销用户会话，不能停用或降级最后一个有效超级管理员。停用、角色变更、重置密码都会撤销目标会话；认证模式管理员重置密码需重新验证管理员当前密码，本机免认证管理则使用本机管理授权。退出不等于取消后台任务。

API 摘要：`POST /api/auth/password`、`GET/DELETE /api/auth/sessions`、`DELETE /api/auth/sessions/:sessionId`；管理面 `GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST /api/admin/users/:id/password`、`GET/DELETE /api/admin/users/:id/sessions`、`DELETE /api/admin/users/:id/sessions/:sessionId`。会话列表仅显示不可逆标识、到期时间等元数据，不返回 token。业务写入继续校验 `X-Platform-CSRF`，认证开启时还需 `X-CSRF-Token`。

Turnstile 管理默认关闭；secret 加密保存，仅返回 hasSecret。启用须真实 site key / secret、匹配 action / hostname 及联网 siteverify 验证；网络失败或不匹配拒绝登录，离线桩不证明真实 Cloudflare 验收。认证状态本地使用 `auth.json`，SQL 激活后在全局 owner 文档保存；`auth.key` 保留本地，POSIX `0600` 不代替 Windows ACL。本应用仍仅供本机及可信局域网 HTTP，不是公网部署保证。

## v3 关系存储与运行边界

[storage-profiles 配置及安全样例](sqlconnect.md#v3-storage-profiles) 定义默认 profile、多个 MySQL / PostgreSQL / SQL Server 连接和 owner 映射。关系适配器已实现三种方言，但 **MySQL / SQL Server 当前仅有模拟适配器验证，未证明真实服务器兼容性**。旧 SQLconnect 保存 / 初始化不会迁移；v3 需停服执行 `migrate-all`，没有自动存储切换。已激活配置禁止在线修改，失败不回落旧 JSON。

v3 使用 `novel_agent_v3_*` 表，项目、章节、设定、工作流实体正文成为 canonical 实体表数据；文档保存兼容结构、其他设置以及 revision，读取 / 导出时重建完整 projects 文档。不是把同一正文同时作为独立权威副本双写。owner revision、文档 revision、导入 receipts 与实体同事务提交，CAS 冲突拒绝覆盖。

数据库 Worker 持有异步持久连接池，不再每次业务操作 spawn 新进程 / 新连接。租户 Worker 内保留同步持久化屏障：只有确认实际 COMMIT 才返回，不是 write-behind；等待会阻塞**同一租户**，不阻塞主控制面及其他租户事件循环。控制面认证状态的同步 SQL 持久化仍可能有界阻塞主线程；不能将业务 Worker 隔离理解为所有管理请求均无阻塞。数据库仍可能成为共同瓶颈：同一 profile 的 repository gate 将写入、完整快照及相关读取串行化，这是保证一致性的吞吐取舍，不是无锁高并发或基准性能提升声明。超时 / 未知提交使桥接失败关闭，不自动重试远端副作用。

**仍只允许单应用实例及本地数据锁。** 行锁 / CAS / Worker 隔离不是分布式租约，不保护跨实例重复生成、浏览器或发布；不得多实例共享 owner 运行。平台外部账号锁仅运行时内有效，不是跨租户全局锁；两个租户绑定同一真实平台账号仍可能并发，须避免这种部署 / 操作。离线维护前须停止所有共享所选数据库的运行时，本地文件锁不能替你停止其他主机。

## 全量应用备份与恢复

使用 [维护操作说明](使用手册.md#全量应用备份与恢复) 的 `npm run maintenance -- backup` / `restore` / `migrate-all`。备份遍历安全数据树，保留二进制、空目录、全部租户文件、本地密钥、上传和浏览器资料；对全部配置的 v3 profile 导出应用仓库所有 owners、文档、重建实体内容、revision 和 receipts，不只当前登录者或清单 owner。**这是完整应用备份，不是整个数据库 dump**：不包含数据库其他表、账号权限或服务配置。

排除各层的 `.instance.lock`、`.instance.lock.recovery`、`admin-backups`、`.maintenance-journal.json`、`*.tmp` 和 `.maintenance-*`；符号链接、硬链接及不安全路径拒绝，不会悄悄跟随。外部环境中的 `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` 不打包，必须独立安全保管并在恢复时提供。旧 v1 SQL 激活清单不支持 maintenance backup，应使用独立 `pg_dump` 加完整数据目录备份；旧 admin 自动备份不是本功能的替代。

恢复默认要求新 / 空本地目录、空 v3 应用数据库目标，SQL 还必须显式指定可信目标 profiles 文件，绝不连接备份中的数据库地址。保留旧本地树 rollback 副本；跨文件与多个数据库不能原子回滚。失败留下 `.maintenance-journal.json` 时启动被阻止，须人工核对已提交 profile、备份及目录后安全协调，不能仅删日志或期待自动跨库回滚。恢复撤销认证会话；不会重放远端发布。
