# v0.0.3a — Phone/SMS authentication and runtime baseline

Release tag: `v0.0.3a` · npm/package SemVer: `0.0.3-a`

## 中文

本次预发布汇总用户授权的完整工作树变更，不只包含上一个版本之后的文档调整。**不声明公网生产就绪、等保四级达标、认证或 OS 内核防护。** 部署者仍须独立验收真实外部服务与运行环境。

- **手机与短信认证：** server 启动要求配置 Alibaba China Dysmsapi/2017-05-25 或 Tencent SMS v20210111 的凭据及获批签名 / 模板。注册先验证手机号，再确认邮箱；每次密码登录均须验证绑定手机号的短信，已启用 TOTP 时仍须额外完成。未绑定账号失败关闭；服务停机后通过 CLI `--phone` 引导或 `set-phone` 迁移，后者撤销旧会话。配置 Turnstile 时对注册、登录及短信发放作服务端校验，不能复用一次性挑战。
- **会话与安全重试：** server access 60 分钟，refresh 轮换有效期 7 天并拒绝重用，持久化空闲上限 30 天；离线 8 天已不能刷新，不是离线 30 天免登录。客户端在会话恢复与符合条件的读取失败时刷新，**不自动重放写操作**；操作结果不明确时先只读核对。local 原有默认免登录行为不变。修复反向代理下刷新与短信登录共用 IP 配额造成的互相阻塞；有效刷新按已验证会话族独立限流，保留用户名、短信尝试及有界入口限制。
- **Node 安全基线：** 仅支持 `^22.23.4 || ^24.22.2`，推荐 24.22.2；旧补丁和其他主版本不支持，升级后重启实际服务。Docker 基础镜像为 Node 22.23.4 bookworm-slim；运行时检查不是 OS 沙箱或系统已升级的证明。
- **部署与容器配置：** 保留 local 仅回环、server 强制认证 / hardened / 审计、同源真实 HTTPS 代理、独立密钥、单实例 / 非 HA 边界。Compose 镜像标识为 `novel-agent:v0.0.3a`，转发选定短信供应商环境变量，默认空值不包含秘密；Docker 增加 OCI 版本 / 源码 / 标题标签，构建上下文排除缓存、测试报告与项目代理配置。容器保持非 root、只读根和独立数据 / 备份卷，不含 Chromium；container local 不能通过发布端口访问。
- **项目代理能力：** 新增项目级 Skills 与能力 / 验收指引；可选 Playwright MCP 只是待通过 DSH plugin_manager 安装的配置 bundle，**未安装、未运行，也不是应用依赖**。
- 创作、文件、存储与平台安全限制继续有效：PDF 上传拒绝；真实 SQL 兼容性、外部服务与代理需独立验收；番茄未知结果只读核对、不盲目重发，送审不等于已发布。

### 升级、交付与验证边界

升级前备份数据、数据库、手机号与外部密钥；server 既有账号须安排停机手机号迁移、凭据轮换及真实 HTTPS / Cookie / CSRF / 短信验收。详见[部署模式](docs/deployment-modes.md)、[安全加固与差距](docs/security-hardening.md)、[Node 基线](docs/node-security.md)和[代理能力](docs/agent-capabilities.md)。

发布资产为 `novel-agent-v0.0.3a.tar.gz`（跟踪源码 + 本次成功构建的服务 / 前端产物）及 `SHA256SUMS.txt`，包内包含提交 manifest。排除 node_modules、真实 `.env`、业务数据、凭据、浏览器登录态及测试产物；GitHub 自动生成的源码归档不含编译产物。若资产包含编译产物，从解压根目录用支持的 Node 执行 `npm ci --omit=dev --ignore-scripts`、`npm rebuild sharp`，然后 `node build/packages/server/src/index.js`；纯源码资产须安装开发依赖并先构建。

本文不新增测试通过或构建成功的声明；以本次发布者实际记录的验证结果为准。历史 Compose 静态检查不证明本次 Docker 镜像构建 / 运行；真实 SMS、SMTP、OIDC、Turnstile、TLS 代理、数据库、容器宿主机与平台发布验收仍不能由桩测试推导。发布或标签不改变这些限制。

## English

This prerelease covers the user-authorized full working tree, not only documentation since the previous tag. **It does not claim public-production readiness, MLPS Level 4 compliance/certification or OS-kernel protection.**

- **Phone/SMS authentication:** server startup requires configured Alibaba China Dysmsapi/2017-05-25 or Tencent SMS v20210111 credentials and approved signature/templates. Registration verifies phone possession before email confirmation; every password login requires bound-phone SMS plus enrolled TOTP where applicable. Unbound accounts fail closed. Bootstrap with CLI `--phone`, or stop the service and migrate existing accounts with `set-phone`, which revokes their sessions. Configured Turnstile is checked server-side on registration, login and SMS issuance; challenges are single-use.
- **Rotating sessions, no write replay:** server access lasts 60 minutes; refresh rotates with a seven-day lifetime, reuse rejection and persisted 30-day idle cap. Eight days offline cannot refresh: this is not a 30-day offline sign-in promise. The client refreshes on restoration and eligible failed reads, **never automatically replays writes**. Reconcile uncertain operations read-only. Native local defaults remain unchanged. Fix shared proxy-IP quota interference between SMS login and refresh: verified refresh families have separate limits while username, SMS-attempt and bounded ingress protections remain.
- **Patched Node baseline:** only `^22.23.4 || ^24.22.2` is supported, with 24.22.2 recommended. Restart actual services after upgrading; other majors and older patches are unsupported. Docker uses Node 22.23.4 bookworm-slim. Runtime checks are not an OS sandbox or proof that system Node was upgraded.
- **Deployment/container configuration:** local remains loopback-only; server requires enabled authentication, hardened/audit, a same-origin real HTTPS proxy and independent keys. Single-instance/non-HA limits remain. Compose identifies `novel-agent:v0.0.3a` and forwards SMS provider settings with empty, secret-free defaults. Docker adds OCI version/source/title labels; build context excludes caches, test reports and project-agent configuration. Non-root/read-only execution and separate data/backup volumes remain; Chromium is absent and container-local listeners cannot be reached through published ports.
- **Project agent capabilities:** project Skills and capability/acceptance guidance are included. The optional Playwright MCP is a configuration bundle awaiting DSH plugin_manager installation: **not installed, not running and not an application dependency**.
- Existing authoring/file/storage/publication restrictions remain: PDF uploads are rejected; live SQL/service/proxy compatibility requires separate acceptance; unknown Fanqie outcomes use read-only reconciliation, never blind resend, and review submission is not public publication.

### Upgrade, delivery and validation boundaries

Back up data, databases, phone information and external keys before upgrading. Plan stopped-service phone migration and credential rotation for existing server accounts, then independently accept HTTPS/cookies/CSRF and actual SMS delivery. See [deployment](docs/en/deployment-modes.md), [hardening gaps](docs/en/security-hardening.md), [Node baseline](docs/node-security.md) and [agent capabilities](docs/agent-capabilities.md).

Assets are `novel-agent-v0.0.3a.tar.gz` (tracked source plus freshly built server/web output) and `SHA256SUMS.txt`, with a commit manifest inside the archive. Dependencies, live `.env`, business data, credentials, browser sessions and test artifacts are excluded. GitHub's automatically generated source archives do not include compiled output. For an asset that actually includes compiled output, use supported Node and run `npm ci --omit=dev --ignore-scripts`, `npm rebuild sharp`, then `node build/packages/server/src/index.js` from the extracted root. Source-only assets require development dependencies and a build first.

This document adds no claim that tests or builds passed; use the publisher's actual current-release verification record. Historical Compose checks do not validate this image build/run. Stub tests cannot establish real SMS/SMTP/OIDC/Turnstile, TLS proxy, database, container-host or platform-publication acceptance. A tag or release changes none of these limits.
