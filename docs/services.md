# 后端分层、服务与用户边界

语言 / Language：[中文](services.md) · [English](en/services.md) · [English documentation index](en/README.md)

## 组织方式

[服务入口](../packages/server/src/index.ts) 负责环境、数据锁、服务装配、监听及关闭。后端包名为 `space.syjx.agent.novel.server`，源码分为 [core](../packages/server/src/core/)、[features](../packages/server/src/features/) 和 [infrastructure](../packages/server/src/infrastructure/)，不再将全部服务混放在 models 目录。当前是一个应用内的控制面、租户 Worker 和数据库 Worker，不是分别部署的分布式微服务。具体目录职责见 [后端包说明](../packages/server/README.md)。下列文件名在对应功能目录中定位，API 路径不变。

- `context.ts`：Store、Runner、PlatformRuntime、模型提供方共享上下文，以及 FeatureService 接口。
- `application.ts` / `registry.ts`：显式注册、服务顺序、重复标识校验。
- `http.ts`：统一来源、CSRF、频率、请求体、安全头、API 404 及错误处理。扩展服务不得绕过该层。
- [web-hosting.ts](../packages/server/src/core/web-hosting.ts)：独立、可选的 Web 静态资源与 SPA 托管。`SERVE_WEB` 默认 `true`，`false` 时仅保留 API / uploads 及 JSON fallback；`WEB_DIST_DIR` 默认应用根目录的 `dist`，可指定可信构建目录。
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
- `platform-account-lock.ts`：单实例控制面协调所有租户的已核验外部账号锁，未知登录占整个平台锁；非分布式锁。
- `documents.ts` / `exports.ts` / `parser.ts`：正式章节 DOCX / EPUB 导出、浏览器打印数据、限额的 DOCX / PDF 临时阅读。
- `account.ts` / `account-mail.ts`：默认关闭的注册、邮件、OIDC 与 MFA 能力，SMTP 显式注入。
- `online-maintenance.ts`：有界在线备份、完整性校验与离线恢复计划队列。
- [admin.ts](../packages/server/src/features/administration/admin.ts)：停服后的身份引导及旧 PostgreSQL v2 迁移 CLI。
- [server/maintenance-cli.ts](../packages/server/src/features/administration/maintenance-cli.ts) / [server/maintenance.ts](../packages/server/src/features/administration/maintenance.ts)：离线全量应用备份、恢复、全部租户迁移。

保留现有业务 API 路径及应用文档结构，不自动重写旧数据。扩展使用 FeatureService，并在统一防护后装配；自定义服务须加入入口关闭列表并等待 close 钩子。

## Web 交付与 API 安全边界

`npm run build:web` 与 `npm run build:server` 可分别构建两端；默认仍一体启动。独立静态入口必须将 `/api`、`/uploads` 同源代理到唯一后端，不将数据目录作为静态目录，不用 HTML 改写 API 错误。Host / Origin / Cookie / CSRF 和可信 HTTPS origin 配置仍有效，没有新增跨源业务 CORS。完整配置与反向代理注意事项见[使用手册](使用手册.md#前后端独立构建与同源部署)。这只是交付职责拆分，不是分布式服务或放宽公网边界。

来源策略现在先确认字面 IPv4 再匹配私网范围，拒绝 `10.attacker.example` 等伪装前缀 DNS 名；这类名称在具备 DNS rebinding 可达性时可能绕过旧来源判断，但不直接绕过认证会话，且仍受浏览器私网访问限制。API 防护与 Express 路由的大小写行为保持一致，`/API/...` 也必须执行业务 CSRF 与 `no-store`，不能靠改变路径大小写跳过。回归使用真实本机 HTTP 与临时数据，不代表所有漏洞或部署环境均已验收。

## 认证、管理与不可变租户上下文

认证、Turnstile 仍默认关闭。`GET /api/services/user` 和 `GET /api/auth/session` 报告状态；安装、创建账号、配置数据库或迁移都不会自动开启认证。首次超级管理员仍须停服后通过 `bootstrap-admin` CLI 创建，没有 HTTP 管理员引导；可选邮箱确认注册仅创建普通用户，默认关闭。显式 `enable-auth --owner UUID` 才指定旧数据归属并开启认证；没有旧资产的新目录才可选 `--no-legacy`。见 [操作手册](使用手册.md#认证与本地管理-cli)。

管理界面分“用户、数据库、备份与维护、系统与安全”。认证关闭时，本机管理员权限同时要求真实 socket 回环地址、本机 HTTP Host、存在时的本机 Origin，并拒绝 cross-site；写操作还需 `X-Admin-CSRF`。不信任 forwarded headers，局域网访问免登录业务不等于拥有管理员权限。认证开启后按[显式角色权限矩阵](roles-permissions.md)逐接口授权，写入另需认证 CSRF；具备管理权限也不能据此浏览其他租户业务或秘密。

身份只来自服务端验证会话，不接受 `X-User-Id`、查询参数或客户端自报 owner。legacy owner 沿用原目录，其余用户使用 `DATA_DIR/users/<SHA-256(user UUID)>`；SQL 按 owner 隔离。每个租户 Worker 有固定 owner 的 Store、Runner、密钥、平台浏览器、队列及上传。未认证请求失败关闭，不回落共享目录。最多保留 32 个租户运行时，达到容量返回 `TENANT_RUNTIME_CAPACITY`，不是自动无界扩容。

密码采用 scrypt；会话 Cookie 为 HttpOnly / SameSite=Strict。普通用户可修改自己的密码、查看 / 撤销自己的会话；改密撤销该用户全部旧会话。管理员可创建、启停用户、改角色、重置密码、查看 / 撤销用户会话，不能停用或降级最后一个有效超级管理员。停用、角色变更、重置密码都会撤销目标会话；认证模式管理员重置密码需重新验证管理员当前密码，本机免认证管理则使用本机管理授权。退出不等于取消后台任务。

API 摘要：`POST /api/auth/password`、`GET/DELETE /api/auth/sessions`、`DELETE /api/auth/sessions/:sessionId`；管理面 `GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST /api/admin/users/:id/password`、`GET/DELETE /api/admin/users/:id/sessions`、`DELETE /api/admin/users/:id/sessions/:sessionId`。会话列表仅显示不可逆标识、到期时间等元数据，不返回 token。业务写入继续校验 `X-Platform-CSRF`，认证开启时还需 `X-CSRF-Token`。

Turnstile 管理默认关闭；secret 加密保存，仅返回 hasSecret。启用须真实 site key / secret、匹配 action / hostname 及联网 siteverify 验证；网络失败或不匹配拒绝登录，离线桩不证明真实 Cloudflare 验收。认证状态本地使用 `auth.json`，SQL 激活后在全局 owner 文档保存；`auth.key` 保留本地，POSIX `0600` 不代替 Windows ACL。本应用仍仅供本机及可信局域网 HTTP，不是公网部署保证。

## v3 关系存储与运行边界

[storage-profiles 配置及安全样例](sqlconnect.md#v3-storage-profiles) 定义默认 profile、多个 MySQL / PostgreSQL / SQL Server 连接和 owner 映射。关系适配器已实现三种方言，但 **MySQL / SQL Server 当前仅有模拟适配器验证，未证明真实服务器兼容性**。旧 SQLconnect 保存 / 初始化不会迁移；v3 需停服执行 `migrate-all`，没有自动存储切换。已激活配置禁止在线修改，失败不回落旧 JSON。

v3 使用 `novel_agent_v3_*` 表，项目、章节、设定、工作流实体正文成为 canonical 实体表数据；文档保存兼容结构、其他设置以及 revision，读取 / 导出时重建完整 projects 文档。不是把同一正文同时作为独立权威副本双写。owner revision、文档 revision、导入 receipts 与实体同事务提交，CAS 冲突拒绝覆盖。

数据库 Worker 持有异步持久连接池，不再每次业务操作 spawn 新进程 / 新连接。租户 Worker 内保留同步持久化屏障：只有确认实际 COMMIT 才返回，不是 write-behind；等待会阻塞**同一租户**，不阻塞主控制面及其他租户事件循环。控制面认证状态的同步 SQL 持久化仍可能有界阻塞主线程；不能将业务 Worker 隔离理解为所有管理请求均无阻塞。普通存储操作在获取连接前按 owner 排队，不同 owner 可并发；快照 / 导入 / 迁移走独占入场屏障，等待已入场事务实际结束。数据库共享 repository 锁与 owner 锁仍参与一致性 / CAS，并不保证不同数据库引擎无争用。超时 / 未知提交使桥接失败关闭，不自动重试远端副作用。

**仍只允许单应用实例及本地数据锁。** 行锁 / CAS / Worker 隔离不是分布式租约，不保护跨实例重复生成、浏览器或发布；不得多实例共享 owner 运行。平台账号锁由单实例控制面在全部租户间协调：服务端已核验 provider + 稳定账号身份互斥；未知身份登录持有该平台全局锁，与该平台所有账号操作互斥。客户端不能自报锁键，Worker 私有能力及身份摘要用于协调；忙时拒绝，锁不可用失败关闭，不按 TTL 或请求断开提前释放，Worker 退出后才清理其残留租约。这不保护其他实例、其他应用或官方后台并发操作。离线维护前须停止所有共享所选数据库的运行时，本地文件锁不能替你停止其他主机。

### 模拟基准与真实验收

[本地 SIMULATED 实测报告](../scripts/benchmark-storage-report.md) 使用四连接许可、80 次操作、三轮测量：八 owner 队列约 254–261 ops/s，对照 profile 队列约 64–66 ops/s（3.86–4.05 倍），单 owner 基本不变。适配器没有真实 SQL、网络、落盘和数据库锁；只能说明模拟入场瓶颈移除，不能证明 PostgreSQL / MySQL / SQL Server 实际吞吐。报告中的可选在线脚本要求明确环境变量和 `STORAGE_LIVE_ALLOW_CREATE_DATABASE=1`，创建并仅删除本次生成的两个临时数据库；真实 v3 在线验收尚未完成。

## 可选完整账号扩展

[认证模块配置](../packages/server/src/features/auth/README.md) 包含注册、邮箱验证、密码恢复、OIDC、TOTP MFA 与恢复码；认证总开关和每项能力仍全部默认关闭。首次超级管理员仍由 CLI 引导，公开注册必须邮箱确认且仅能普通用户，不自动登录。SMTP 由显式 `NOVEL_SMTP_ENABLED=true` 与 `NOVEL_SMTP_HOST` / `NOVEL_SMTP_USER` / `NOVEL_SMTP_PASSWORD` / `NOVEL_SMTP_FROM` 注入，端口默认 587，`NOVEL_SMTP_SECURE=true` 默认 465，使用可选 nodemailer 传输与证书验证。邮件令牌单次、15 分钟到期，回链使用 HTTPS publicOrigin 和 fragment，避免进入请求查询与日志。

OIDC 显式配置端点，使用 code + PKCE S256、state / 浏览器绑定 cookie、nonce 与 JWKS 签名验证（精确 issuer / audience）；管理员通过 `PUT /api/admin/account/oidc/users/:id` 明确 issuer + subject 关联已有用户，不按邮箱自动注册 / 合并。MFA 在密码 / OIDC 后验证新鲜 TOTP counter 或单次恢复码才签发会话；启用 / 移除因素、恢复密码撤销旧会话，恢复密码不移除 MFA，已绑定因素时不能全局关闭绕过。真实邮件、提供商与 HTTPS / Cookie 反向代理部署仍须独立验收，不是公网生产安全声明。

账号邮件 / OIDC 部署须另配 TLS 终止代理及显式 `NOVEL_TRUSTED_PUBLIC_ORIGIN=https://novel.example.com` 单一 HTTPS origin；代理保留浏览器 Host、拒绝直接绕过后端、清除不可信转发头，服务从不信任 `X-Forwarded-*`。这会自动给认证 Cookie 加 Secure，但不会提供 TLS，也不改变认证默认关闭或免登录本机管理边界。HTTPS origin / Host 需精确一致，管理员账号 `publicOrigin` 与 OIDC 回调同源；具体操作见 [使用手册](使用手册.md#可选注册邮箱恢复oidc-与双重验证)。

## 文稿导出与临时文档

[文档服务及限制](../packages/server/src/features/documents/README.md) 已挂入受现有项目授权 / CSRF / 来源限制保护的业务路由；章节书稿页“文稿格式与阅读”使用同一服务。DOCX / EPUB 导出读取按章号排列的已保存 canonical 章节，不含候选和未保存编辑；PDF 是浏览器稿件专用打印 / 另存，不是服务端 PDF 生成，字体 / 分页需人工确认。

DOCX 单份 ≤ 8 MiB，服务端内存副本 30 分钟过期、重启丢失，不进入项目或资料存储；每项目 10 份、进程 64 份 / 64 MiB，最多同时处理两份。DOCX ZIP 全项验证（512 项 / 32 MiB 实际解压 / 单项 200:1 / 5 秒），转换独立进程（128 MiB V8 heap / 10 秒 / 4 MiB 输出）并清理图片、链接及活动内容；不是 OS 级内存上限或杀毒。**PDF 上传因缺少可靠内容重构而拒绝**，不能仅凭头尾签名放行原件；无文本提取 / OCR，PDF 打印导出保留。旧 `.doc` 必须自行转换为 DOCX。

## 在线维护任务

[在线维护管理器](../packages/server/src/features/administration/online-maintenance.ts) 由主进程单例装配，管理中心“备份与维护”可提交 backup、validate、restore-plan。默认排队 8 项 / 终态历史 100 条 / 备份或未完成产物 20 个，达到容量不自动删除敏感备份。备份必须先阻止全部租户及控制面新请求，排空真实处理 promise，关闭所有租户 Worker / 浏览器，持有静默屏障与实例锁再导出全部配置 profile；不能可靠排空则拒绝。完成或安全失败后恢复接入，不将当前用户暂停误作全局一致性。

产物位于数据目录外受管兄弟目录（默认 `.data-managed-backups`），不提供浏览器下载、原始目录 / manifest / 错误内容或任意路径输入。备份含秘密，必须由主机管理员保护 ACL、容量及外部密钥。任务进度为阶段估计而非字节进度；取消需安全检查点，committing 不能取消；重启标记 interrupted，不自动重试。validate / restore-plan 仅检查完整性及给出离线提示，不证明解密 / 业务语义、不连接备份源数据库、不导入目标。恢复和迁移仍必须停服 CLI，非定时备份 / 分布式维护服务。

## 全量应用备份与恢复

使用 [维护操作说明](使用手册.md#全量应用备份与恢复) 的 `npm run maintenance -- backup` / `restore` / `migrate-all`。备份遍历安全数据树，保留二进制、空目录、全部租户文件、本地密钥、上传和浏览器资料；对全部配置的 v3 profile 导出应用仓库所有 owners、文档、重建实体内容、revision 和 receipts，不只当前登录者或清单 owner。**这是完整应用备份，不是整个数据库 dump**：不包含数据库其他表、账号权限或服务配置。

排除各层的 `.instance.lock`、`.instance.lock.recovery`、`admin-backups`、`.maintenance-journal.json`、`*.tmp` 和 `.maintenance-*`；符号链接、硬链接及不安全路径拒绝，不会悄悄跟随。外部环境中的 `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` 不打包，必须独立安全保管并在恢复时提供。旧 v1 SQL 激活清单不支持 maintenance backup，应使用独立 `pg_dump` 加完整数据目录备份；旧 admin 自动备份不是本功能的替代。

恢复默认要求新 / 空本地目录、空 v3 应用数据库目标，SQL 还必须显式指定可信目标 profiles 文件，绝不连接备份中的数据库地址。保留旧本地树 rollback 副本；跨文件与多个数据库不能原子回滚。失败留下 `.maintenance-journal.json` 时启动被阻止，须人工核对已提交 profile、备份及目录后安全协调，不能仅删日志或期待自动跨库回滚。恢复撤销认证会话；不会重放远端发布。
