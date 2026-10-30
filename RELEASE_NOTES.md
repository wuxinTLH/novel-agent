# v0.0.2-a.1 — Security hardening prerelease

## 中文

本预发布版新增服务端共享 HTTP 安全边界、严格启动配置、有限本地审计链及非 root Docker 部署基线。**不代表等保四级达标、认证、操作系统内核安全增强或公网生产就绪。** 参见 [安全加固与差距指南](docs/security-hardening.md)。

- 共享请求边界限制方法、危险路径编码、异常 framing、URL / Header / 声明请求体大小；生成服务端请求 ID 并统一安全头。
- `SECURITY_PROFILE=hardened` 要求已启用认证、精确 HTTPS 来源、禁用本机网关、独立外置密钥及审计。
- 元数据审计支持 SHA-256 前链、有限轮转与准入落盘失败关闭；不是不可篡改、完整用户操作审计或集中审计系统。
- Node 请求头、请求接收、keep-alive 及单连接请求数量限制。
- 多阶段 Dockerfile、Compose 非 root / 只读根 / capabilities drop / no-new-privileges / 资源限制，持久化数据及独立备份卷。
- 保留上版节点三视图、偏好记忆、知识独立页及脏稿保护。

### 发布边界

Docker Engine 在实现环境不可用，**未实际构建或运行镜像**；仅校验 Compose 配置。默认 Compose 仍是 standard、审计开启、认证待离线初始化，只绑定宿主机回环端口。默认镜像不含 Chromium，不能直接进行番茄交互登录。真实 TLS、外部服务、OS 隔离、国密 / HSM、集中审计、双人控制和正式测评仍需专门实施与验收。

发布压缩包包含跟踪源码、编译后的 `build` / `dist`、锁文件和 Docker 配置，不包含依赖目录、业务数据或真实 `.env`。Node.js 需 >=22.16；解压后运行 `npm ci --omit=dev --ignore-scripts`、`npm rebuild sharp`，再使用 `node build/packages/server/src/index.js`。检查 SHA256SUMS 及 manifest 中提交号。升级前备份数据与独立密钥。

## English

This prerelease adds a shared HTTP boundary, opt-in hardened startup, bounded local audit chaining, HTTP reception limits and a non-root Docker deployment baseline. **It is not a Level 4 MLPS certification, OS-kernel protection, immutable audit or public-production assurance.** See the [hardening and gaps guide](docs/en/security-hardening.md).

Docker Engine was unavailable: the image was not built/run; only Compose configuration was validated. Default Compose remains standard with audit enabled and requires offline auth bootstrap; it publishes only on host loopback. Chromium is not included. TLS, external services, host confinement, Chinese-cryptography requirements/HSM, centralized audit, dual control and formal assessment remain deployment responsibilities.

The archive contains tracked source, compiled server/web output, lockfile and Docker configuration, but no dependencies, live data or real `.env`. Use Node >=22.16; install with `npm ci --omit=dev --ignore-scripts`, run `npm rebuild sharp`, then `node build/packages/server/src/index.js`. Verify SHA256SUMS and manifest commit before use; retain independent data/key backups.
