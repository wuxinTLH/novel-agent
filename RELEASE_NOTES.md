# v0.0.4a — Chapter management, world stages and safer platform automation

Release tag: `v0.0.4a` · npm/package SemVer: `0.0.4-a`

## 中文

本次预发布汇总 v0.0.3a 之后的章节管理、世界观资产和番茄自动化改进。**不声明公网生产就绪、等保认证或真实外部服务全面验收。**

- **章节分页与批量删除：** 批量模式默认关闭，点击后显示勾选操作；每页 20 / 50 / 100 条，本页全选，跨页保留所选项并显示数量。未保存草稿须先保存或放弃；删除有明确确认。后端对整批修订号执行 CAS，一次提交，失败回滚；不重排章节编号、不降低编号高水位、不删除远端平台草稿。
- **世界观阶段：** 按自定义阶段分别管理世界观文本和地图，支持阶段新建、改名、空阶段删除及资产移动；旧资产保持未分组。阶段仅组织资产，不自动成为生成上下文。保留租户 / 项目隔离与修订冲突保护。
- **界面与流程：** 模式和身份在 Logo 下方，语言紧邻主题，系统设置位于指南下方；弹窗启闭及尺寸变化平滑过渡，遵循减少动态效果偏好。小说流 / 人物流 / 世界观流创建对应各自预设，修复同类流程切换回跳和资源页尾随斜杠路由。
- **番茄稳定性：** 显式选中账号可复用其现有活跃登录窗口，不接管个人浏览器。空闲和聚焦时刷新本地记录，不定时调用远端平台。作品列表等待就绪，区分未加载和真实空列表，保留 64 位 ID。
- **安全自动核对：** 仅对 `autoApprove=true` 的不可变预览，在已开始写入且已持久化精确远端草稿 ID 后，执行一次精确 ID 的只读完整核对；只有可证明的完整结果才继续。验证码、账号变化、对话框或不确定结果停止；不绕过验证、不重复创建。旧 unknown 批次不会自动重放，缺少远端 ID 仍须人工提供证据。
- **并发租户启动：** 修复首次创建共享目录的检查 / 创建竞态，仅容忍 EEXIST 并强制逐层检查真实目录；符号链接、非目录和其他创建错误继续失败关闭。
- 中英文操作指南、接口说明、项目 Skills 指引及版本标识同步更新；[本次验证报告](docs/release-validation-v0.0.4a.md)记录实际测试结果与限制。

### 升级和资产

升级前备份数据、数据库与外部密钥，停止原服务后更换产物，再重启。重启会丢失活跃平台浏览器会话，必要时重新登录并在应用内核验账号。server 仍要求已配置的短信供应商、离线启用认证、同源真实 HTTPS、独立密钥及 hardened / 审计；单实例 / 非 HA 边界不变。

资产为 `novel-agent-v0.0.4a.tar.gz`（跟踪源码 + 本次服务 / 前端编译产物）及 `SHA256SUMS.txt`，内含提交 manifest。排除依赖、真实配置、业务数据、凭据、浏览器登录态和本地记忆 / 测试产物。使用 Node `^22.23.4 || ^24.22.2`，推荐 24.22.2；从解压根目录执行 `npm ci --omit=dev --ignore-scripts`、`npm rebuild sharp`，再执行 `node build/packages/server/src/index.js`。GitHub 自动源码归档不含编译产物，须另行安装开发依赖并构建。Docker 镜像标识为 `novel-agent:v0.0.4a`，不含 Chromium。

已知验证限制：TypeScript 源码模式的 SQL Worker 启动测试曾间歇触发 5 秒超时，根因尚未证实；未放宽超时或跳过断言，随后多次源码复测及三次编译产物启动通过。详细失败与复测证据保留于验证报告，不能称为已修复。

隔离测试不等于真实模型、短信、SMTP、OIDC、Turnstile、TLS 代理、供应商 SQL 或番茄送审验收；草稿核对不等于公开发布。详见[部署指南](docs/deployment-modes.md)、[番茄接入](docs/番茄平台接入.md)和[验证报告](docs/release-validation-v0.0.4a.md)。

## English

This prerelease adds chapter management, world-stage organization and safer Fanqie automation since v0.0.3a. **It does not claim public-production readiness, certification or complete real-service acceptance.**

- **Chapters:** batch mode is off until explicitly enabled; 20/50/100 pagination, current-page select-all, retained revision-pinned cross-page selections and destructive confirmation. Unsaved selected drafts must be saved or discarded first. The server validates the entire CAS set and commits atomically, rolling back persistence failures. Survivors are not renumbered, the high watermark is retained, and remote platform drafts are never deleted.
- **World stages:** create/rename stages, delete empty stages, upload/filter/move world text and maps. Legacy assets remain ungrouped. Organization does not implicitly alter generation context; tenant/project isolation and revision checks remain.
- **UI/workflows:** identity below the logo, adjacent language/theme controls, administration below the guide, smooth accessible modal motion, family-specific novel/character/world creation, stable workflow selection and trailing-slash resource routing.
- **Fanqie:** reuse only explicitly selected live app-owned sessions; no personal-browser adoption. Automatic polling reads local records only. Wait separately for work-list readiness and preserve 64-bit IDs. Only immutable `autoApprove=true` previews may run one exact-ID full read-back after an execution failure with a durably pinned ID. Continue only on proven results; challenges, identity changes or uncertainty stop safely. No blind replay, CAPTCHA bypass or automatic retry of historical unknown batches.
- **Concurrent tenant startup:** tolerate only a competing directory-creation EEXIST, then validate every ancestor with lstat; symlinks, non-directories and other errors still fail closed.
- Updated bilingual operational guides, API notes, project-skill guidance and version labels. The [validation report](docs/release-validation-v0.0.4a.md) is the source for actual results and limitations.

### Upgrade and delivery

Back up data, databases and independent secrets; stop the service, replace artifacts and restart. Browser sessions do not survive restart: re-login and verify the account in the app if required. Server SMS/authentication, exact same-origin HTTPS, distinct keys, hardened auditing and single-instance/non-HA restrictions remain.

Assets: `novel-agent-v0.0.4a.tar.gz` (tracked source plus built web/server output) and `SHA256SUMS.txt`, including a commit manifest. Dependencies, live configuration/data, credentials, browser sessions, local memory and test artifacts are excluded. With Node `^22.23.4 || ^24.22.2` (24.22.2 recommended), run `npm ci --omit=dev --ignore-scripts`, `npm rebuild sharp`, then `node build/packages/server/src/index.js` from the extracted root. GitHub-generated source archives require development dependencies and a build. Docker identifies `novel-agent:v0.0.4a` and does not include Chromium.

Known verification caveat: the TypeScript-source SQL-worker bootstrap test intermittently exceeded its 5-second deadline; the root cause remains unproven. No timeout was relaxed or assertion skipped. Repeated unchanged-source checks and three compiled-worker startups subsequently passed. The validation report preserves both failures and repeat evidence; this is not described as fixed.

Isolated tests do not prove real paid-model/SMS/SMTP/OIDC/Turnstile/TLS/vendor-SQL/Fanqie acceptance. Verified drafts are not public publication. See [deployment](docs/en/deployment-modes.md), [Fanqie integration](docs/en/fanqie-integration.md) and [validation](docs/release-validation-v0.0.4a.md).
