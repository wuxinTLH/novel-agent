# v0.0.2-a.2 — Local / server deployment modes

## 中文

本版本以 `CoreModel` 区分本地使用和受控服务器部署。**这是面向等保四级目标的应用控制增强，不是等保四级达标、认证或操作系统内核改造。** 参见[双模式部署](docs/deployment-modes.md)和[安全控制差距](docs/security-hardening.md)。

- `CoreModel` 仅接受 `local` / `server`，原生启动未设置时为 `local`，其他显式值拒绝启动。
- `local` 仅监听 `127.0.0.1`；拒绝远程 / 局域网可信 HTTPS 来源及非回环网关配置。主机管理员仍能自行建立代理或隧道，应用不能控制主机外部暴露行为。
- `server` 监听所有接口但强制 hardened、认证与审计；必须预先离线初始化并启用认证，提供精确 HTTPS origin、两个独立外置密钥，关闭本机网关。显式 standard 或关闭审计会失败，真实 TLS 与后端网络隔离仍由部署者负责。
- server 新凭据至少 15 个 Unicode 字符，拒绝有限常见 / 低多样性 / 账号名派生密码以及当前密码复用；覆盖 CLI 引导、新建、变更和重置。旧凭据不会被追溯拒绝，需要安排轮换。
- server 每用户最多 5 个有效会话，仅完整认证成功后淘汰最早到期会话，持久化失败不撤销既有会话。
- 注册 / 找回密码邮件失败仍返回统一受理响应，并撤销投递不确定的令牌；202 不证明邮件已经送达。
- Docker 新增 `ARG CoreModel=server` 与运行时 `ENV CoreModel`，只允许两种取值；Compose 同步构建 / 运行时选择，默认 server，必须先完成离线认证初始化。local 容器仅监听容器回环，不可通过普通发布端口使用，建议原生本地运行。
- 审阅全部 Markdown 文档，同步相关中英文使用、权限、认证、部署与差距说明。

### 兼容与验证边界

以前依赖默认局域网监听的部署必须显式迁移为 server，不能再使用默认免登录模式对外服务。升级前备份数据及密钥并完成认证引导、现有凭据轮换、真实 HTTPS / Cookie / 代理验收。

Docker Engine 在实现环境不可用，**未实际构建或运行镜像**。Compose 配置校验及原生产物双模式启动检查不代替 Docker、真实 TLS 或正式测评。默认镜像不含 Chromium。强制 MFA、国密 / HSM、独立集中审计、双人控制、宿主机和网络隔离等剩余差距见指南。

发布压缩包包含跟踪源码、编译后的 `build` / `dist`、锁文件及 Docker 配置，不含依赖目录、真实 `.env` 或业务数据。Node >=22.16；解压后执行 `npm ci --omit=dev --ignore-scripts`、`npm rebuild sharp`，再运行 `node build/packages/server/src/index.js`。核验 SHA256SUMS 和 manifest 提交号。

## English

`CoreModel` accepts only `local` or `server`; native startup defaults to loopback-only local. Server mode requires previously enabled authentication, mandatory hardened controls and auditing, an exact HTTPS origin, distinct external keys and disabled local gateway; explicit downgrade settings fail closed. Real TLS and backend network isolation remain deployment responsibilities.

Server-only new credential policy requires at least 15 Unicode characters (at most 1024 bytes), rejects a limited common-password blocklist, low-character-diversity and account-derived passwords, and prevents current-password reuse. Existing hashes remain usable and require planned rotation. Completed authentication (including enrolled MFA when configured) caps active sessions at five per user, evicting the earliest-expiring session only after successful persistence. Public registration/recovery delivery failures return generic acceptance and revoke uncertain tokens; acceptance does not prove delivery.

Docker validates build `ARG CoreModel=server` and carries it into runtime `ENV`; Compose defaults to server and needs offline auth bootstrap before first start. Container-local mode binds only container loopback and is not reachable through ordinary published ports; use native local mode instead. See [deployment modes](docs/en/deployment-modes.md) and [hardening gaps](docs/en/security-hardening.md).

**No MLPS Level 4 certification or OS-kernel protection is claimed. Docker Engine was unavailable, so no image build/run was validated.** Real TLS, external services, mandatory MFA, HSM/Chinese cryptography, centralized independent audit, dual control and host/network controls remain separate work.

Archive includes tracked source and compiled output, not dependencies, live data or secrets. Node >=22.16; install production dependencies with `npm ci --omit=dev --ignore-scripts`, run `npm rebuild sharp`, then start `node build/packages/server/src/index.js`. Verify SHA256SUMS and manifest commit; back up data and keys before migration.
