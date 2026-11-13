# 更新记录

## v0.0.5a — 章节解析、用量统计与连续性 / Chapter analysis, usage analytics and continuity

发布标签 `v0.0.5a`；npm/package SemVer `0.0.5-a`。本次汇总 v0.0.4a 之后的当前工作树更新，旧版说明和测试数字保留为历史记录。

### v0.0.5a 同版本更新 / Same-version refresh

经用户明确确认，现有 v0.0.5a 标签移动至本次提交，并替换 Release 说明与同名归档、校验和；其他版本保持不变。先前下载的 v0.0.5a 不是本次产物，必须重新下载并核对新校验和。

- Header / Footer 拆为独立组件，保留顶栏原有操作；未配置背景时保留主题渐变。
- 管理员和超级管理员通过 `appearance.manage` 配置安全颜色、字号、间距及可选公司名称（默认空），支持预览、持久化、修订 CAS 和冲突重新载入。公共显示配置只读，不暴露秘密；拒绝任意 CSS/HTML/脚本。
- 页脚固定 © SakuraMikku 项目新窗口链接及安全 rel 属性，可选公司版权不替换署名。新增 2026–2099 英文 MIT 与中文参考译文。
- 双语使用、部署、权限、安全、备份和 API 文档按当前实现复核；最新验证见本版本报告，原始发布测试记录作为历史保留。

**English:** With explicit approval, this same-version refresh moves the v0.0.5a tag and replaces its release notes/archive/checksum assets; earlier downloads must be replaced and re-verified. Independent Header/Footer components preserve existing controls and theme defaults. Manager-only `appearance.manage` grants safe, revision-protected, persistent presentation settings with optional company attribution. The mandatory © SakuraMikku project link remains; bilingual MIT materials cover 2026–2099 (English governs). Operational documentation and validation are refreshed without implying real external-service acceptance.

- **章节解析：** 手动指定起止章或选择最近 N 章，显式调用所选模型分析写法、节奏、剧情布局、人物、伏笔与跨章衔接；独立保存调用状态、来源修订和报告，可重复查看，不改写正文。不自动重试未知模型请求，不静默截断超限正文。
- **连续性：** 独立前章结尾锚点传递至规划、写作和审校；要求状态过渡及两侧证据。保存或恢复前章使相关后续节点上下文失效；现有正文和历史输出不自动覆盖。模型判断不保证文字质量。
- **审阅与国际化：** 生成进度、预览和候选使用更大的阅读区域，支持展开全文与窄屏排列。系统文案集中到双语词典并加入静态及浏览器回归；用户正文、名称、模型返回和未知服务端错误不擅自翻译。已删除正文的历史生成结果明确标记并默认折叠，而非误报已保存。
- **Token 统计：** 独立持久化调用准入、成功、失败和待定状态；仅超级管理员和管理员可查看 Three.js 图表及表格。UTC 日范围最多 31 天，包含模型、请求、Token、平均/峰值 RPM 和 TokenPM；不编造历史，不将 pending 当作已发往供应商的证据。WebGL 不可用时保留表格。
- **删除与平台证据：** 作品卡提供明确删除入口；未开始写入的安全批次可显式取消。未知远端结果可通过二次确认保留平台证据仅删除本地作品，不等于全部数据抹除；保留证据继续阻止同一远端目标盲写，不重放旧请求或自动清理历史。
- **时间与日志：** 前端时间戳固定 UTC+8、`yyyy:mm:dd HH:mm`，不附时区；统计日边界仍是 UTC。后端日志默认 `Asia/Shanghai`，可通过 `LOG_TIME_ZONE` 配置，不改变持久化时间和安全审计链。
- **交付边界：** Node、安全部署、租户隔离、CSRF、单实例及真实外部服务验收限制不变。实际测试和发布资产以[本次验证记录](docs/release-validation-v0.0.5a.md)为准，不把历史通过数字当作当前结果。

**English:** Explicit chapter analysis supports a chapter range or the latest N chapters, with independent durable reports and invocation records, immutable source revision references and no manuscript mutation or blind request replay. Continuity anchors and downstream invalidation preserve canonical chapter boundaries. Larger review panes, bilingual system-copy catalogs, accurate deleted-chapter history, administrator-only bounded Token analytics, explicit local deletion with retained remote evidence, UTC+8 timestamp presentation and configurable backend log timezones are included. User-authored data is not translated. Historical unknown platform writes remain protected; retained deletion is not complete erasure. See the [current validation report](docs/release-validation-v0.0.5a.md) for actual tests and limitations.

## v0.0.4a — 章节管理与世界观阶段 / Chapter management and world stages

发布标签 `v0.0.4a`；npm/package SemVer `0.0.4-a`。本次汇总 v0.0.3a 之后的创作界面、阶段资产与番茄安全自动化更新；下方旧版数字和限制保留为历史记录。

- **章节管理：** 批量删除默认关闭，显式进入后才显示选择框；支持 20 / 50 / 100 条分页、本页全选与跨页保留已选章节。删除前确认数量并固定版本；有未保存草稿时先保存或放弃。后端一次性校验全部版本并原子保存，冲突或持久化失败不部分删除；保留章节编号高水位，不重排编号，不删除远端平台草稿。
- **世界观阶段：** 新建、重命名及删除空阶段；世界观文本和地图按阶段上传、筛选与移动，旧资产保留未分组。分组只管理资产，不隐式改变生成上下文；项目隔离、修订 CAS 与存储往返保留。
- **创作界面：** 模式 / 身份置于 Logo 下方，语言与主题并列，系统设置位于使用指南下方；弹窗启闭和尺寸平滑过渡并尊重减少动态效果。小说流 / 人物流 / 世界观流创建使用匹配预设，切换同类流程不再回跳首项。
- **番茄可靠性：** 复用明确选中账号的活跃登录窗口；本地状态在空闲、聚焦及可见性变化时只读同步，不以定时器访问远端作品。账号身份与作品列表就绪分离，保留 64 位作品 ID。自动批准的不可变预览允许在已持久化精确远端 ID 后进行一次只读完整核对；不绕过验证、不盲目重发，无法证明仍停止为 unknown。
- **租户启动竞态：** 并发首次启动可能同时创建共享 users 目录；仅对创建竞争的 EEXIST 容忍，随后仍逐层 lstat 拒绝符号链接和非目录，避免合法租户偶发启动失败而不放宽路径边界。
- **版本与交付：** Node 基线仍为 `^22.23.4 || ^24.22.2`；保持 local 回环、server 同源 HTTPS / 认证 / hardened / 审计和单实例限制。源码与编译产物归档及 SHA-256 校验和按本次实际验证发布；验证范围与外部服务缺口见[本次验收记录](docs/release-validation-v0.0.4a.md)。

**English:** Bulk chapter mode is opt-in, with 20/50/100 pagination, current-page selection, revision-pinned cross-page selections, draft protection and atomic server-side CAS deletion. Local deletion never removes platform drafts or renumbers survivors. World stages organize world text/maps without changing generation context; legacy assets remain ungrouped. Shell controls, modal motion, family-specific workflow creation and selection continuity are improved. Fanqie reuses explicit live sessions, synchronizes local state read-only, separates identity from list readiness and preserves 64-bit IDs. Automatic immutable previews may perform one exact-ID full read-back after an execution failure, never blind replay or verification bypass. See the [current validation record](docs/release-validation-v0.0.4a.md); historic validation below is not current-release evidence.

## v0.0.3a — 完整工作树预发布 / Full-working-tree prerelease

发布标签 `v0.0.3a`；npm/package SemVer `0.0.3-a`。本节汇总用户授权的完整工作树，以下旧版本、未发布增量及验证数字保留为历史记录，不当作本次全树验证结果。完整双语说明见 [RELEASE_NOTES](RELEASE_NOTES.md)。

- server 注册先验证手机再确认邮箱，每次密码登录强制绑定手机短信验证，已启用 TOTP 时仍须额外完成；未绑定账号失败关闭。支持 Alibaba / Tencent 配置，停服 CLI `--phone` 引导及 `set-phone` 迁移；配置 Turnstile 时注册、登录和短信发放均服务端校验。
- access 60 分钟、轮换 refresh 7 天、拒绝 refresh 重用、持久空闲上限 30 天；离线 8 天无法刷新。客户端只重试符合条件的读取，不自动重放写入；local 默认不变。
- Node 仅支持 `^22.23.4 || ^24.22.2`，Docker 使用 22.23.4。Compose 镜像为 `novel-agent:v0.0.3a` 并转发 SMS 配置；OCI 标签与构建上下文排除规则同步。
- 项目 Skills 与代理能力指南纳入交付；可选 Playwright MCP 是待安装配置 bundle，未安装 / 未运行，不是应用依赖。
- 资产尚未最终决定；构建成功后优先源码 + 编译产物。此文档更新不声明本次测试 / 构建通过、Docker 实机验收、真实短信 / 外部服务验收、等保认证或公网生产就绪；单实例、同源 HTTPS、权限 / CSRF 与未知远端结果不重发限制保持。

**English:** This prerelease covers the authorized full working tree. Server registration verifies phone before email, and every password login requires bound-phone SMS plus enrolled TOTP; unbound accounts fail closed. Alibaba/Tencent settings, stopped-service phone migration and configured Turnstile checks are included. Access is 60 minutes, rotating refresh seven days with reuse rejection and persisted 30-day idle cap; eight days offline cannot refresh. Eligible reads may retry after refresh, never writes. Supported Node is `^22.23.4 || ^24.22.2`; Docker uses 22.23.4, with Compose SMS forwarding/version and OCI/build-context updates. Project Skills are included; optional Playwright MCP is not installed/running or an application dependency. Assets remain undecided, preferring source plus compiled output only after a successful build. No current-release validation, real-service acceptance, certification or public-production claim is added. Historical entries below are preserved, not refreshed evidence.

[English unreleased summary](#english-unreleased-summary) · [English documentation index](docs/en/README.md)

## English unreleased summary

This is a maintained English summary of unreleased changes, not a translation of every historical release entry. Chinese entries and their original historical evidence remain below. Historical test counts are not refreshed by documentation work; no new real-service acceptance is claimed here.

- **Server phone/SMS and session integration (in progress):** server startup requires configured Alibaba China Dysmsapi/2017-05-25 or Tencent SMS v20210111; CLI bootstrap requires E.164 `--phone` and offline `set-phone` migrates unbound users, who otherwise fail closed. Registration verifies phone before email confirmation; every password login requires SMS, plus enrolled TOTP when applicable. Configured Cloudflare Turnstile checks registration/login/SMS issuance. Access is 60 minutes, rotating refresh seven days and persisted inactivity cap 30 days: eight days offline cannot refresh. Client refresh retries eligible reads, never blindly replays mutations; local legacy behavior is unchanged. No real SMS vendor delivery, external deployment acceptance, MLPS certification or public-production guarantee. [Auth contract](packages/server/src/features/auth/README.md), [deployment guide](docs/en/deployment-modes.md), [security gaps](docs/en/security-hardening.md).
- **CoreModel deployment modes (v0.0.2-a.2):** exact local/server values, native unset default local, invalid values fail; local binds only `127.0.0.1` and rejects remote/LAN trusted HTTPS origins. Server binds `0.0.0.0` only behind a same-origin real TLS proxy, requires offline-enabled auth, exact HTTPS origin, independent >=32-character keys and gateway off, and forces hardened/audit (explicit standard/false fails). New server credentials require 15 Unicode characters, limited-common-blocklist/low-character-diversity/account-name-derived and current-reuse rejection without retroactive invalidation; at most 5 sessions per user after authentication (including enrolled MFA when configured). Docker ARG/ENV and Compose build/runtime default server; container local is unreachable through published ports, so prefer native local. Offline bootstrap precedes first startup; separate named data/backup volumes remain. Docker Engine unavailable: no image build/run. [Deployment guide](docs/en/deployment-modes.md).
- **HTTP-boundary/container increment:** shared HTTP method/target/framing/header checks and server UUIDs; strict `SECURITY_PROFILE=hardened` checks explicit auth, exact HTTPS origin, gateway-off and distinct >=32-character keys, with mandatory bounded local SHA-256-linked audit. Durable admission failure rejects routing; this is not immutable centralized audit or full attributable business logging. Node header/request/keep-alive bounds preserve long SSE responses. Non-root/read-only Compose includes separate data/backup volumes and minimal capabilities; no Chromium. `docker compose config --quiet` passed, but unavailable Docker Engine prevented image build/run. [Bilingual hardening guidance](docs/en/security-hardening.md) records Level 4-target prerequisites/gaps without certification/compliance claims. Single-instance/non-HA and external acceptance limitations remain; release/tag publication is a separate action.
- **Separate delivery and HTTP hardening:** root `build:web` / `build:server` build independently; default integrated hosting remains. `SERVE_WEB=false` keeps APIs/uploads without HTML/SPA or frontend artifacts; `WEB_DIST_DIR` selects trusted web output relative to the application root or an absolute path. Separate hosting requires same-origin `/api` and `/uploads` proxying with original Host and existing Cookie/Origin/CSRF protections, not cross-origin authorization. Private-prefix DNS names now fail literal-IPv4 checks; uppercase API paths no longer skip business CSRF/no-store. Focused local security regression passed 20/20, not a final full-tree total or external-service guarantee.
- **Authoring navigation:** the node picker's grid/list/detailed-menu preference persists in same-origin browser storage. `/assets/knowledge` independently hosts structured facts; unsaved replacements/new records/navigation/project changes require discard confirmation, with browser refresh/close warnings rather than autosave.
- **Chapter throughput and optional composition:** new chapter graphs use planning → prose → consistency review (three ordinary model calls, excluding retries, repairs and custom nodes), preserving saved graphs/prompts. Production branch concurrency is configurable 1–8, default 1; linear dependencies, writer/review barriers and chapter commits remain sequential. Recent-chapter context prioritizes the latest ending, mode mismatches reject before paid calls, and previews expose indirect upstream context. Conflict, twist, climax and foreshadow nodes are optional author-selected presets, never mandatory stages for every chapter.
- **Themes and menus:** the optional blue/pink/white palette uses a soft full-page gradient, white manuscript cards and high-contrast dark controls/focus states. Theme and language have separate keyboard-accessible menus with browser-local persistence. Registry/CSS reload failures preserve the active appearance, and other themes/custom images remain unaffected.
- **Authoring protections:** hard min/max word-count checks, bounded automatic review/repair, earlier-prose retrieval, local draft recovery, bounded chapter/asset history with CAS, unfinished-target resume, structured knowledge, model parameters/usage-budget preflight, incremental progress and safe graph branches/joins. Text retrieval is not vector semantics; model judgments and estimated costs are not factual/billing guarantees.
- **Files:** unified strict admission and reconstruction covers uploads, avatars, old image downloads and model-image outbound use. DOCX is bounded and sanitized; PDF uploads are rejected without reliable reconstruction. PDF export remains browser printing. Child-process limits are not OS isolation or antivirus.
- **Identity and administration:** native local authentication and optional registration/mail recovery/OIDC/MFA/Turnstile default off; server requires offline-enabled auth. CLI-only first-superadmin bootstrap, explicit legacy ownership, independent tenant runtimes, session revocation, exact role/module permissions and strict loopback management remain. Role weights do not inherit permissions. Account settings have grouped switches, explicit Save and expandable OIDC details; English UI coverage remains partial.
- **Storage and maintenance:** v3 profiles support explicit owner mappings and canonical entities/revisions/receipts, persistent DB pools and acknowledged COMMIT. Ordinary owner admission can overlap; snapshots/import/migration remain exclusive. Single-instance platform-account locks coordinate verified accounts across tenants, not other hosts/apps. Full backups cover all configured application repositories and the safe local tree, not an entire database dump. Online backup requires global quiescence; restore/migration stay offline with explicit empty targets and safe journal reconciliation. External encryption keys require independent retention.
- **Publication:** Fanqie is isolated-browser automation, not an official API. Explicit binding/volume selection, full previews, approved create/reuse/same-ID overwrite, read-back and separate review receipts remain. Local auto-approval and persistent workflow continuation are separate opt-ins. Unknown results use exact-ID read-only reconciliation, never blind resend. Review submission is not approval/public publication. Qidian/Qimao remain unavailable; MV3 supports only local single-user pairing/capability inspection/revocation.
- **Engineering/docs:** npm workspaces retain root commands/output/data compatibility and copy required SQL resources. Bounded rate limiting and CSRF/role/tenant checks remain enforced. English counterparts now cover all Chinese-first operational guides, package/theme entry points and a complete [English navigation index](docs/en/README.md); existing English contracts/reports are indexed, not duplicated.

**Validation boundaries:** local tests and browser stubs do not establish real paid-provider, platform review, SMTP/OIDC/Turnstile, proxy or vendor-database acceptance. MySQL/SQL Server are simulated-only; historical PostgreSQL v2 success is not v3 proof. The [benchmark report](scripts/benchmark-storage-report.md) retains historical simulated four-permit results (eight owners about 254–261 vs 64–66 ops/s; no SQL/network/disk evidence). Single-instance/local-loopback-or-server-HTTPS restrictions, partial localization, absent OS-level file isolation and non-atomic cross-database recovery remain explicit. See the [English acceptance record](docs/en/acceptance-checklist.md).

## 未发布

- **服务端手机与短信会话接入（进行中）**：server 启动前须配置 Alibaba China Dysmsapi/2017-05-25 或 Tencent SMS v20210111；CLI 管理员引导须提供 E.164 `--phone`，旧用户停服离线 `set-phone`，未绑定拒绝密码登录。注册须手机验证后邮箱确认，每次密码登录须短信验证（已启用 TOTP 还须额外通过）；已配置 Turnstile 对注册 / 登录 / 短信发放服务端校验。access 60 分钟、轮换 refresh 7 天、持久空闲上限 30 天；离线 8 天无法刷新，客户端仅重试可安全读取，不自动重放写操作。本机旧行为不变；真实短信送达、供应商接入和部署未验收，不作等保认证或公网生产保证。见[认证契约](packages/server/src/features/auth/README.md)、[部署指南](docs/deployment-modes.md)和[安全差距](docs/security-hardening.md)。

### CoreModel 本机 / 服务端模式（v0.0.2-a.2）

- `CoreModel` 仅接受 local/server，原生未设置默认 local，非法值失败；local 仅监听 `127.0.0.1`，拒绝远程 / LAN 可信 HTTPS origin，不再支持局域网直连。server 监听 `0.0.0.0`，必须先离线开启认证、配置精确 HTTPS origin、独立各至少 32 字符密钥并关闭网关，仅通过同源真实 TLS 代理访问，强制 hardened / 审计；显式 standard / false 拒绝启动。
- server 新设密码至少 15 个 Unicode 字符，拒绝有限常见密码清单、低字符多样性、账号名衍生及当前密码重用；不追溯既有凭据。完成身份验证（已配置 MFA 时须通过该验证）后签发会话，每用户最多 5 个有效会话，超限撤销最早到期的会话（按 expiresAt）。注册 / 恢复投递失败保持通用 202 并撤销不确定投递令牌，accepted 不等于 delivered。
- Docker ARG 默认 server，镜像 ENV 保留模式，构建与运行均校验；Compose build arg / runtime 使用 `${CoreModel:-server}`。先离线引导再首次启动，保留独立命名数据 / 备份卷；容器 local 仅内部回环，发布端口不可访问，本机推荐原生 local。Docker Engine 不可用，未构建 / 运行镜像。见[部署指南](docs/deployment-modes.md)。不作认证、内核防护或公网生产保证。

### 先前增量：HTTP 边界、严格策略与容器最小权限（历史记录）

以下保留该增量当时的默认策略 / 验证记录；当前模式与 Docker 默认值由上方 v0.0.2-a.2 及部署指南取代。

- 共享 HTTP 内核统一入口 / 租户响应头、方法 / 路径 / framing / 声明长度预检与服务端 UUID；原始 HTTP 仍可能被 Node 更早拒绝。Node 头部 15 秒、请求接收 120 秒、keep-alive 5 秒、最多 100 头 / socket 1000 请求，不以短绝对响应时限中断长 SSE。
- `SECURITY_PROFILE=hardened` 显式检查认证、精确 HTTPS origin、网关关闭、两个不同且各至少 32 字符的秘密，并强制审计；默认 standard 不变，检查不是代理 TLS、密钥熵、MFA 或合规证明。
- 可选安全审计记录请求元数据，8 MiB 当前段 + 8 轮转段，SHA-256 前链及序号；准入持久化失败拒绝业务。仅启动校验当前段，主机管理员可重写 / 删除；无用户身份 / 原始 URL / 请求体，不是完整业务审计、远程不可抵赖或不可篡改集中审计。
- Docker 多阶段生产镜像使用非 root Node 22；Compose 只读根、独立数据 / 备份卷、tmpfs、drop ALL、no-new-privileges 与资源上限，默认仅发布主机回环、standard + 审计，认证仍需离线引导。镜像不含 Chromium，不支持默认远程容器首次番茄交互登录。Compose 静态校验通过；Docker Engine 不可用，未验证镜像构建 / 运行。
- 新增[中文安全加固与等保四级目标差距](docs/security-hardening.md)及[英文指南](docs/en/security-hardening.md)，明确 OS / 网络、国密 / HSM、集中防篡改审计、双人控制、测评等前置条件；不作等级或认证声明，不改变单实例 / 非 HA 限制。发布 / 标签状态由实际发布动作确认。

### 独立 Web 交付、知识页与 HTTP 边界

- 增加根 `build:web` / `build:server`，保留默认一体构建与启动；可选 Web 托管拆出独立模块。`SERVE_WEB=false` 运行纯 API / uploads，无前端产物也不提供 HTML / SPA fallback；默认 `true`。`WEB_DIST_DIR` 可指定可信前端构建目录（相对路径以应用根目录解析）。独立静态入口同源反代 `/api` 与 `/uploads`，不新增跨源业务 CORS 或放宽 Cookie / 来源 / CSRF。
- 添加节点提供网格、列表、详细菜单三视图并以浏览器同源 localStorage 记忆；`/assets/knowledge` 为独立知识事实页，知识编辑替换、新建、应用内离开和切换作品时确认丢弃未保存修改，刷新 / 关闭交由浏览器提示，不等于自动保存。
- 修复私网来源判断将 `10.attacker.example` 等前缀 DNS 名误作私网字面 IPv4 的问题，以及 `/API/...` 与 Express 不区分大小写路由不一致造成业务 CSRF / no-store 防护遗漏。DNS 利用需受控解析与 rebinding 可达性，不直接绕过认证会话，仍受浏览器私网限制。
- 安全专项本机 HTTP / 临时数据回归 20 / 20 通过；不将历史全测或构建数字更新为本轮最终结果。实际反向代理、真实外部平台 / 模型 / 数据库及 OS 级文件隔离仍有验收或实现缺口，见[验收记录](docs/功能完善验收清单.md)。

### 蓝粉白主题视觉优化

- 蓝粉白可选主题采用浅蓝、粉色与白色的全页柔和渐变；侧栏、顶部、项目栏、工作流及章节选中态保留清晰层次，正文卡片保持白底。
- 交互控件使用高对比度深蓝和深粉色文字/描边，支持键盘焦点提示和窄屏背景滚动；不影响其他主题或用户上传图片。

### 生成吞吐与默认章节模板

- 新增冲突、反转、高潮与伏笔四类可选创作节点，按目标自主添加与连接；推荐编排不代表每章必须全部运行，默认三节点章节图不变。

- 新建章节图采用章节规划、正文生成、一致性审校三个节点；保留审校与旧作品已有工作流及提示词，避免每章重复生成世界观和总体大纲。独立设定图继续可用。
- 分支节点并发上限可调至 8，单一章节的上下游依赖、审校顺序及章节落盘仍受串行约束；最近章节上下文优先保留最新章节末尾，避免长篇截断造成续写断层。
- 正文与设定模式不匹配时在模型调用前拒绝；节点上下文预览显示传递的间接上游。

### 创作功能完善、界面与安全加固

- 补齐字数硬校验、有界审校返修、长篇检索上下文、草稿刷新恢复、章节/资料历史及冲突保护、剩余目标续跑、结构化知识、模型运行参数/预算、流式进度和工作流分支并发。实现及验收边界见 [功能完善验收清单](docs/功能完善验收清单.md)。
- 统一上传准入与文件重构，历史图片读取和模型出站同样检查；缺少可靠 PDF 净化能力时明确拒绝。保留操作系统级隔离未实现的说明，见 [文件沙箱](docs/文件沙箱.md)。
- 改善模型设置保存锁定、配对加载状态、知识输入可访问性、章节恢复错误反馈和窄屏比较；工作流状态刷新不再重置未保存调度输入，数字设置提交前严格校验。
- 修复知识编辑忽略标签/章节关联及返回旧修订的问题；新增关联验证在持久化前执行，拒绝不存在章节并保持原数据。
- HTTP 限流改为固定计数窗口，最多保留 4096 个客户端，闲置到期清理；拒绝请求不再持续追加时间记录，429 提供 Retry-After。
- 升级存在安全公告的解析依赖；数据库身份认证依赖选择兼容驱动范围内的安全版本。真实平台、SQL 服务和操作系统隔离仍需独立环境验证，不作为本地测试通过的推论。

### 账户设置与部分界面双语

- 管理中心 AccountAdminSettings 按基础账户开关与 OIDC 连接 / 密钥设置分组，展示已启用数量、未保存提示和保存反馈；宽屏双列、窄屏单列响应式布局。保留默认关闭的功能及认证总开关独立性；OIDC clientSecret 留空保留已保存值，不回传明文。
- 引入 `packages/web/src/locals/` 前端词条，默认 `zh-CN`；顶栏 LanguageSwitcher 可切换 `en`，浏览器 localStorage 键为 `novel-locale`。目前仅翻译账户配置、顶栏及部分管理 / 导航文案；创作、平台及后端消息仍未完整英文化。
- 根目录 README.md 继续提供完整默认中文说明，并新增 `README/README_zhCN.md` 和 `README/README_en.md` 独立语言入口；同步使用手册的功能边界和链接。

### 项目导航与管理体验

- 优化顶部账号状态栏及项目切换导航，增加全部项目图库、搜索和项目操作入口，适配窄屏布局。
- 管理中心改为工作台、分类导航与状态摘要；在线维护以备份、完整性校验和离线恢复计划分步呈现，高级说明与 CLI 指引折叠展示。
- 界面优化不改变备份敏感性、全租户静默要求及恢复必须停服的边界；角色权限同时控制导航、操作与后端接口。

### 模块化四角色权限

- 统一共享角色及模块权限注册表：超级管理员 1000、管理员 99、运维管理员 100、作家 10。权重仅用于展示与排序，不自动继承权限。
- 管理员仅管理作家及运维账号，角色变更与安全配置写入保留超级管理员权限；最后一个有效超级管理员保护、密码再确认及会话撤销机制保留。
- 运维仅访问工作台、存储只读与备份/完整性校验；禁止用户管理、安全配置写入、数据库变更、初始化、恢复计划及任务取消。后端逐端点授权，前端同步隐藏无权限入口。
- 旧 `user` 账号加载为 `writer`，备份/恢复校验兼容旧角色；认证仍默认关闭，首次引导与恢复迁移的停服要求不变。详见 [角色与模块权限](docs/roles-permissions.md)。

### 单实例安全、并发与运维扩展

- 增加控制面统一的跨租户平台账号锁，使用已核验 provider / 稳定账号身份；未知身份人工登录持有该平台全局锁。忙时拒绝、锁不可用失败关闭，不按 HTTP 断开或 TTL 释放未确定副作用；不宣称跨主机 / 多实例安全。
- v3 普通存储操作改为 owner 级排队，不同 owner 可并发；完整快照、导入及迁移保留独占屏障和实际 COMMIT 确认。同步租户桥接 / 认证 SQL 控制面阻塞边界保留。
- 新增本地 SIMULATED 存储入场基准及实际报告：四连接许可、80 次操作，八 owner 三轮约 254–261 ops/s，对照 profile 队列约 64–66 ops/s，单 owner 基本不变；不执行真实 SQL / 网络 / 落盘，不是生产数据库性能证明。新增需显式创建数据库 opt-in 的可选 PostgreSQL v3 在线验收脚本，真实数据库尚未验收。
- 管理界面增加有界在线维护任务队列：全应用备份、受管备份完整性校验、离线恢复计划、阶段进度与安全取消。备份暂停并排空全部租户和控制面，关闭 Worker / 浏览器后快照，完成后恢复接入；敏感产物存数据目录外的受管目录，无浏览器下载和任意路径操作。恢复 / 迁移仍仅停服 CLI，重启中断不自动重试，非字节进度 / 在线恢复或定时备份。

### 可选账号与文稿格式

- 认证与全部扩展开关保持默认关闭；新增可选邮箱确认普通用户注册、验证邮箱、邮件找回密码、OIDC 与 TOTP MFA / 一次性恢复码。首次超级管理员仍 CLI 引导，注册或配置不自动开启认证。
- 邮件由显式环境变量配置的可选 nodemailer SMTP 发送；邮件令牌单次、15 分钟到期，密码恢复不绕过 MFA。OIDC 使用 PKCE / state / nonce / JWKS 校验和管理员明确 issuer + subject 映射，不自动按邮箱关联或注册；已绑定因素不能通过关闭 MFA 总开关绕过。真实 SMTP / 提供商 / HTTPS 部署仍待独立验收。
- 增加显式 `NOVEL_TRUSTED_PUBLIC_ORIGIN` HTTPS origin opt-in，与保留 Host 的 TLS 反向代理配合并自动启用认证 Secure Cookie；不信任转发头、不自动提供 TLS、不放宽本机免登录管理权限，仍须独立部署验收。
- 增加章节书稿“文稿格式与阅读”：从正式 canonical 章节导出真实 DOCX / EPUB，保留 Markdown；PDF 采用浏览器稿件专用打印 / 另存，不是服务端 PDF 生成，中文字体与分页须人工检查。
- 增加 ≤ 8 MiB DOCX / PDF 临时阅读，30 分钟过期、重启丢失，不导入章节 / 资料；旧 `.doc` 不支持。ZIP 解压限额、独立限时 DOCX 转换、HTML 清理及沙箱防护不等于杀毒；PDF 无文本提取 / OCR，仅交浏览器原生阅读。限制详见模块说明。

### 工程目录与工作区

- 前后端独立为 npm workspaces：`space.syjx.agent.novel.web` 与 `space.syjx.agent.novel.server`；根目录安装、开发、构建、启动和维护命令保留。
- 前端按 app、services、styles、lib 分层，components 和 hooks 进一步按功能划分；后端按 core、features、infrastructure 分层，将各业务服务和测试归属对应领域。
- 更新全部源码引用、Worker / CLI 入口、验收脚本与运行根目录发现，保持根目录 data、shared、public 和构建输出位置兼容；后端构建自动复制四个 SQL 资源，避免生产包遗漏迁移脚本。
- 修复生产验收发现的外层 SQLconnect 写操作 CSRF 防护缺口：在解析请求前校验租户绑定的真实 Worker token，保持认证 CSRF 与角色校验独立，补充缺失 / 错误 / 跨租户 token 拒绝回归。

### 工作流与平台界面

- 将新建节点的提示词集中为共享预设，保留作者已保存的提示词；补充节点模型、关联设定和上游上下文展示。
- 完善人物节点的姓名、性别、性格、经历、模板和数量配置，以及相关校验与运行上下文隔离。
- 调整番茄作品选择，区分已绑定与未绑定作品；章节选择按章号排序并以每页 50 章分组，保留单批 50 章上限。
- 更新工作流、节点配置、平台和设置页面布局、主题样式及应用图标。

### 后端与可选数据库

- 将业务 API 从入口拆为独立服务，并归类于后端工作区 `core/`、`features/` 和 `infrastructure/`；入口保留环境、数据锁、服务装配和关闭管理，延续原 API 路径与本地 JSON 数据。
- 增加默认关闭的认证与本地管理 CLI：停服后通过 `npm run admin -- bootstrap-admin --username admin --confirm` 首次引导超级管理员，密码仅来自 `NOVEL_BOOTSTRAP_PASSWORD` 环境变量；显式选择 legacy owner 后才能启用认证，不让首次登录自动接管旧数据。
- 认证模式按验证后的稳定用户 UUID 装配独立、不可变 owner 的应用上下文，隔离 Store、Runner、模型密钥、平台运行时、发布队列和上传；提供用户创建 / 停用、会话 / CSRF 和管理员 Turnstile 配置，默认单用户行为保留。
- SQLconnect 保留 `sqlconnect.json` 和原连接探测 / 初始化入口，保存 / 初始化不自动迁移。新增 v3 `storage-profiles.json` 多连接及 owner 映射，MySQL / PostgreSQL / SQL Server 关系适配器；MySQL / SQL Server 目前仅模拟 SQL 单元验证，尚无真实服务器兼容性证明。
- v3 项目 / 章节 / 设定 / 工作流使用 canonical 实体表，文档结构、owner / 文档 revisions 及导入 receipts 同事务持久化。停服 `npm run maintenance -- migrate-all --owner UUID --destination EXTERNAL_BACKUP --confirm` 先完整备份、校验全部租户、导入空目标、回读再激活；不自动开启认证。旧 `admin migrate-sql` PostgreSQL v2 单 owner 迁移仍保留为 legacy。
- 数据库 Worker 改用持久连接池；每租户隔离 Worker 保留同步 COMMIT 屏障，同租户等待仍阻塞，其他租户 / 主控制面业务事件循环隔离，最多 32 个租户运行时。当前普通操作按 owner 入场、不同 owner 可并发，快照 / 导入 / 迁移独占；不是无锁性能或分布式服务保证；认证控制面同步 SQL 持久化仍可能短时阻塞主线程。未知提交失败关闭、不回落 JSON，单实例限制不变；跨租户账号锁现由单实例协调，仍非分布式锁。
- 新增离线 `npm run maintenance -- backup --destination PATH --confirm` 与 `restore --source PATH --data-dir NEW --confirm`；仅 SQL 恢复额外必须显式 `--database-config EXPLICIT_TARGET_PROFILES`。完整应用备份含全部配置 v3 仓库 owners / 文档 / 实体内容 / revisions / receipts 和安全本地文件树（含二进制、空目录），不是整个数据库 dump；排除锁、临时文件、admin-backups 和维护产物，拒绝不安全链接。外部环境秘密不入包，需独立保管。
- 恢复默认新 / 空本地和数据库目标，不连接备份源地址；保留文件 rollback 副本，不能自动跨数据库回滚。失败 `.maintenance-journal.json` 阻止启动，需人工安全协调；恢复撤销认证会话，不重放远端发布。旧 version 1 SQL 后端不支持 maintenance backup，须独立 `pg_dump` 加完整目录 / 外部密钥备份。
- 增加管理中心用户 / 数据库 / 维护 / 安全区域、角色 / 密码 / 会话管理和普通用户账号安全；认证仍默认关闭，本机管理需严格 socket 回环、Host / Origin 与管理 CSRF，局域网访问不授予管理员。首次超级管理员仍 CLI，最后一个有效超级管理员受保护；改密、重置、停用及角色变更撤销目标会话。
- 上传、模型秘密 / 密钥、平台凭据与浏览器资料仍本地。数据库密码明文落盘，认证密钥本地 `0600`，Windows ACL 仍需手工维护；备份本身也含秘密。部署继续保留旧初始化与 v2 迁移 SQL 资源。
- Turnstile 需真实 Cloudflare 密钥、匹配 action / hostname 与在线验证，未宣称已通过真实在线验收；认证保留既有可信局域网 HTTP 限制，不代表公网生产部署方案。
- 修复大小写混合 API 路径绕过 SQLconnect 超级管理员检查的问题；认证与角色检查使用和 Express 路由一致的大小写规则，补充读写回归。
- 已启用认证但尚未分配 legacy owner 时，SQL 迁移在连接数据库前拒绝激活，避免生成下次启动无法加载的 owner 配置。
- 新增 `npm run smoke:auth`，使用临时目录与真实 Chromium 验证登录、用户管理、会话、双 CSRF 和账号切换后的数据隔离。
- 已在 `novel_test` 真实 PostgreSQL 测试库通过 v2 重复迁移、已有 v1 表行数保持、提交读回、跨 owner 隔离、并发 CAS 单一成功者、幂等导入及写入后故障回滚；仅保留唯一 `test-pg-*` 测试数据，不清空已有数据，不代表用户工作目录已完成迁移。

### 主题与文档

- 主题改为独立 CSS 与可重新加载的注册表，提供极简白、极简黑、跟随系统、蓝粉白及旧选择迁移；切换失败保留当前主题。
- 补充服务组织、数据库边界与操作、主题扩展及生产部署说明，并扩展回归和生产冒烟测试。
- 自动化测试使用本地桩，不证明真实数据库部署或番茄账号送审成功；在线连接与远端结果仍须单独验收。

## v0.0.2a

- 平台页改为概览与平台二级页结构，番茄操作按“核验账号 → 绑定作品 → 选择章节 → 预览并批准 → 核对结果”五步展示；结果页在会话失效后仍可查看。
- 更新番茄草稿队列：支持明确分卷、同章草稿复用 / 同 ID 覆盖、批量顺序执行、人工或显式自动审批，以及送审回执核验；送审不等于审核通过或已发布。
- 未知结果支持从官方作者页该章编辑链接提供准确远端章节 ID进行只读核对，仍要求账号、作品、分卷、标题和完整正文匹配，不会借此重发。
- 增加当前浏览器隐藏历史与恢复显示；另提供带重复风险确认的本地暂存备份清空，二者均不删除远端正文或本地正式章节。
- 改进正文导入、会话状态同步、全自动工作流接续、版本冲突保护和平台回归测试；同步 README、使用手册与番茄平台接入说明。

## 更新番茄平台接入

### 平台登录与会话

- 核验操作自动进入番茄作者首页，通过实时登录接口验证作者身份，保留 64 位标识精度；不再仅凭 Cookie 存在或页面缓存推断登录。
- 核验作者、读取作品并显式绑定；读取分卷和完整章节 / 草稿目录。
- 同步浏览器实际更新的会话状态；可用固定 `PLATFORM_SECRETS_KEY` 加密持久化，不虚构双 token 刷新流程。

### 上传、覆盖与送审

- 新增持久化批量草稿 / 送审队列，完整正文快照、审批哈希、幂等入场、顺序执行、暂停和失败停止。
- 远端分卷明确选择，同章草稿支持保留远端 ID 覆盖；不允许经草稿流程覆盖已发布或审核中章节。
- 独立自动审批选择框，启用后由服务端批准并启动；仍要求准确账号、目标和 AI 使用声明。
- 送审结果通过精确章节回执验证，送审不等于公开发布或审核通过。
- 修正编辑器段落读取引起的空行比对偏差；未知结果可按已知远端 ID 只读核对，不盲目重发或推断删除。

### 自动工作流与正文输入

- 工作流增加显式全自动模式；通过硬性校验、完成审校且原稿版本未变时自动采用重生成结果，失败停止并保留恢复稿。
- 完整真实工作流成功保存后，可接续已明确配置的绑定作品、分卷和草稿 / 送审动作；演示、单节点和失败运行不上传。
- 章节书稿支持主动添加正文：直接编辑或上传 UTF-8 / GB18030 TXT，单文件 2 MB、单章 200000 字符；正式保存、章号冲突保护和幂等防重复。

### 配套改动

- 同步模型 / 作品设置组件、生成配置界面和 SCSS 样式及静态资源缓存。
- 扩展浏览器、会话、覆盖、队列、工作流接续和正文创建回归测试。
- 更新 [README](README.md)、[使用手册](docs/使用手册.md)、[番茄接入说明](docs/番茄平台接入.md)与环境配置示例。

### 验证边界

离线测试 / 模拟浏览器测试不等于真实账号审核通过。真实身份 / 作品读取和草稿上传已由使用者反馈成功；自动送审、自动接续仍需在线验收。平台审核、验证码、风控和额外声明保留人工处理边界；不提供无人值守定时发布。
