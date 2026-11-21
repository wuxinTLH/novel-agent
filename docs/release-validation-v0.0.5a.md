# v0.0.5a 发布验证 / Release validation

本记录对应本次工作树，历史 v0.0.4a 报告不作为当前验收。发布前结果在此逐项记录；尚未完成的步骤不得解释为通过。

## Init 区号与数据库配置补充（2026-11-20）

本轮补齐区号与本地号码分离输入（+86 中国大陆手机、+1 NANP），前后端共同校验并提交 E.164，不宣称全球号码可用或真实短信可达。数据库明确 JSON 默认与 SQL 待用配置；SQL 只私有保存 v3 profile，不连接、不建表、不迁移、不写激活 manifest，重启仍使用 JSON。新增首次环境快照与脱敏/锁定字段，演示页仍零真实 API、零持久化。

验收通过：父执行 Init / phone / demo / locale / Docker 定向 40/40，另数据库前端 helper 5/5；最后追加服务端地区号码读写边界回归后 Init 13/13 通过（无效号码无文件写入、有效 +1 按 E.164 保存）。根 typecheck、Web 与 Server 生产构建通过（4 项 SQL 资源，仅既有 Zod 注释/chunk 警告），locale AST 75 文件、2148 字面翻译调用、0 违规，86 Markdown 本地链接、Compose 静态配置和 diff 空白检查通过。后端覆盖 JSON 默认、SQL 全方言配置纯离线保存、环境优先/半填/密码脱敏、零驱动连接、写失败 journal 及真实 AuthService 重载。

两个生产资源浏览器脚本通过：测试页验证两区号码无效拒绝/有效提交、SQL 配置模拟、重置/刷新、零 API/浏览器存储；真实 Init 使用临时复制部署与虚构 .invalid SQL 主机，检查 +1 合成 POST（受控 400 不创建第二账号）、+86 真正完成、v3 profile 落盘但无业务 manifest、人工重启后正常认证且仍 JSON。1440/768/390 无横向溢出，桌面/手机截图已检查。首次 browser 因 fixture 错误要求 driver 选项固定顺序失败；改为集合排序比对后完整重跑通过，不改变产品行为。未重新运行全量 820 项，不将历史记录作为本轮全量证明。不提交、推送或更新 Release；未执行真实数据库建表/迁移、SMS 或模型调用；Compose 静态检查不是 Docker Engine 实运行证明。

## 初始化临时测试页（2026-11-20）

新增精确 `/init-test` 前端入口：复用 Init 表单，独立内存 transport 与虚构配置，明确“不生效”，重置 / 刷新丢弃输入；不挂载 AuthGate/业务界面，不请求真实 API、不读取环境、不持久化配置或账号。既有 `/init` 与认证边界不变，受限的全新 Server Init 服务不额外开放测试路由。

验收使用 `node scripts/smoke-server-init-test.mjs` 静态生产资源临时 HTTP 服务，不启动核心或使用真实数据。通过：缺失字段拒绝、模拟完整提交、中文/英文切换、显式重置与刷新清空、零 API 请求、localStorage/sessionStorage 无写入、1440/768/390 无横向溢出；桌面/手机截图已检查。定向 21/21、根 typecheck、Web 生产构建与 locale AST 零违规通过。另重跑真实 `smoke-server-init.mjs` 成功，确认表单提取不破坏实际初始化、人工重启与认证边界。不声称重新执行全量 820 项；不提交/推送/更新 Release。

## Server 首次启动 Init 验证（2026-11-20）

仅验证当前工作树，不提交、不推送、不更新标签或 Release；下方发布与回归历史不代替本轮验收。

- 只在全新 Server 数据目录组装隔离 Init 应用；已有目录继续经过原认证、HTTPS 来源、独立密钥和短信供应商检查。普通业务应用仅在 HTTP 边界之后、认证之前公开精确 GET `/api/init/status` 的 false 状态。
- Docker 环境非空值优先：普通值预填，秘密只报告已配置；缺失项留空提示。页面按所选短信供应商显示字段；所有者令牌仅通过请求头传递，不放 URL 或浏览器存储。保存后停留手动重启页，不挂载 AuthGate/业务页面。
- 对初始化持锁、严格 Host/Origin、请求速率/体积限制、权限私有文件、符号链接检查、半提交 journal 失败关闭以及真实 auth.key 格式进行测试。生成的 owner token 没有自动有效期，部署者应在完成后移除环境注入；出错停机核对，不删除恢复 journal 来绕过保护。
- 独立安全复核未发现令牌绕过、已有数据误认领、失败后开放业务或秘密回显。补充修复两项恢复体验：完整配置先纯校验再创建提交 journal；已有 journal 的 status 返回 503，使刷新不能错误地重新提供提交入口。新增过长环境值无写入和恢复态 status 回归，Init 7/7、typecheck 和 Server 重构建通过。随构建继承隐藏 workspace TEMP 的一次 smoke 无法加载初始化表单，按既有静态托管隐藏目录限制改用普通 OS TEMP 完整重跑通过；不改产品静态资源防护。回环入口依赖宿主端口发布/隧道/防火墙，不能宣称 Host 校验可证明 TCP peer 或 TLS。
- 根 typecheck 和 Web/Server 生产构建通过（4 项 SQL 资源）；构建仅既有 Zod 注释和 chunk 大小警告。Init/locale 定向 22/22、后端 Init/auth/tenant 定向 47 项通过；首次全量 819 项、817 通过、1 失败、1 POSIX 跳过（306060.6613 ms）；唯一失败为新增 HEAD fixture 对空响应体 JSON.parse，后端已修 fixture guards 并定向通过，不改生产 HEAD/认证行为。最终完整串行套件通过：820 项，819 通过、0 失败、1 POSIX 专用跳过，313266.9623 ms；包含最终 HEAD fixture、恢复态 status 与过长环境输入测试。
- 新增可复用 `node scripts/smoke-server-init.mjs`：临时复制生产 build/dist、临时数据、净化环境与浏览器外联阻断，验证 token/Origin 拒绝、业务接口关闭、Docker 配置识别、缺失字段、secret 不回显、不存储，1440/768/390 页面无横向溢出（截图已检查），实际填表→保存→IPC 停机→重启后正常认证边界。通过；不发送真实短信或调用模型。首次验收末项误将普通未登录 config 请求预期为 404（实际受正常认证保护返回 401），仅修正 smoke 预期并完整重跑通过。
- 已有 CoreModel local/server、真实 compiled core supervisor、完整隔离认证与管理页冒烟通过；认证覆盖跨端口身份重验、双 CSRF、双向租户隔离、重启与退出，管理页覆盖日志/告警、焦点、配置 CAS、备份校验与 1440/768/390 布局。Locale AST、Markdown 本地链接、Compose 配置及 git diff --check 通过。Docker Engine/真实 TLS 代理/短信投递未验证，不把宿主 Node 进程冒烟称为容器验收。

## 发布后完整回归 / Post-release regression (2026-11-17)

基线提交 `72a73e92acc497533e3868e0b848fe0bbfaade64`，本轮仅执行回归、修复和记录；不提交、不推送、不移动标签、不替换 Release。下方发布历史不作为本轮结果。

已先复现再修复的缺陷：

- 超级工作流的本地世界观与检索结果合计超过普通上游上下文 35000 字符预算时，会挤掉后续大纲、冲突、伏笔与章节规划。上游排序现在优先最终正文（审校），再保留创作规划，最后放本地证据；预算、正式历史/候选隔离和连续性锚点不变。回归同时检查超长最终正文仍优先提供给审校。
- 告警适配器忽略 AbortSignal 时，超时只结束调度等待，不代表真实发送已经停止。记录真实 Promise 的存活数，`waitForIdle()` / `close()` 在未完成时以 `OPERATIONAL_LOGS_UNAVAILABLE` 失败关闭，避免错误放行备份/关闭；迟到结果不把 unknown 改为 sent，不自动重试。预留厂商接口仍未接通。
- 守护进程 starting 观察回调同步触发停止时，之前仍创建子进程。新增 spawn 前停止状态检查；测试用真实子进程写标记验证没有孤儿进程被创建，不仅检查返回码。
- 管理页第一次加载日志告警配置时，全局 busy 将当前 tab 原生禁用，导致键盘焦点丢失。tab 改用 aria-disabled 保持焦点，点击与键盘切换仍被 busy 阻断，关闭/保存锁不变；浏览器测试主动暂停首次 GET，验证加载中与完成后焦点以及忙碌期间的切换/关闭限制。

另将四处直接模型桩测试的空数据目录改为独立临时目录并检查临时用量账本，避免测试写入仓库根 Token 账本或相互争用。早期测试存在空目录写根账本的风险，本轮不声称该私有文件始终未变；未读取或手工覆盖其内容。

### 本轮结果 / Regression results

| 检查 | 结果 |
| --- | --- |
| 全量 Node test | 最终完整串行运行通过：804 项，803 通过、0 失败、1 POSIX 专用跳过，332106.0344 ms；workflow API 集成项 12770.5055 ms。先前两次完整运行均为 802 通过、1 失败、1 跳过，均在原 6 秒就绪断言失败；禁缓存复现后将测试启动期限对齐既有生产 60 秒策略，禁缓存单文件复测 7/7，再完成本次全量通过。失败历史和期限调整详见下文 |
| 定向回归 | 工作流扩展 72/72、独立模型桩 18/18；日志与路由/权限 24/24；守护与 Docker 合约 14 项中 13 通过、1 POSIX 专用跳过；最终管理页 helper 7/7，权限/外观/helper 联合复测 16/16 |
| 类型与构建 | 根 typecheck、Web 与 Server 生产构建通过（复制 4 项 SQL 资源）；焦点修复后重新 typecheck 与 Web 构建通过。仅保留 Zod 注释和大 chunk 警告 |
| 生产核心与部署模式 | 可复用 scripts/smoke-supervisor.mjs 对独立临时副本验证 ready IPC、HTTP health、优雅 IPC 停止、锁释放及不重启；CoreModel local/server 边界冒烟通过 |
| 超级工作流浏览器 | 隔离项目库冒烟通过：实际创建预设、精确节点顺序、原默认图保留、自动生成/发布关闭、标题跳转；1440/1100/768/390 宽度 |
| 管理页浏览器 | 焦点修复后的完整隔离冒烟通过：暂停首次日志告警 GET 验证加载中/完成后的焦点及 busy 锁；日志筛选、配置 CAS、未接通渠道、备份→轮询→校验→离线恢复计划；1440/768/390 无横向溢出、无浏览器运行错误。桌面/移动截图已检查 |
| 认证与租户 | 隔离认证冒烟通过：会话别名、身份重新验证、双 CSRF、缓存清理、双向租户隔离、重启持久化和退出 |
| 国际化/依赖/文档 | Locale AST：69 文件、2092 literal calls、0 违规，353 项上下文复核并非豁免；官方 npm production audit 0 vulnerabilities；85 Markdown 文档本地文件链接通过；git diff --check 通过 |
| 未覆盖项 | Docker Engine named pipe 不可用，只完成 Compose 配置验证，未构建镜像或验证容器。Windows 无 Job containment，崩溃失败关闭而非自动重启；Linux/POSIX 重启/后代清理未在此机器实跑，相关测试跳过。微信/飞书/钉钉/企业微信仅接口预留，未真实发送；未调用真实模型、短信、邮件或平台发布 |

早期全量运行用于复现修复前的上下文缺陷，已中止且不计为通过。第一次修复后全量：804 项，802 通过、1 失败、1 POSIX 跳过，351453.2779 ms；唯一失败为既有 workflow API 的 6 秒启动就绪断言（stderr 为空），期间同时执行过构建和浏览器冒烟。停止其他负载后重跑完整串行套件仍失败：804 项，802 通过、1 失败、1 跳过，341322.0702 ms，仍为同一断言且 stderr 为空。随后独立运行 workflow.test.ts：直接 loader 7/7（8152.9025 ms）、tsx CLI 7/7（7839.3896 ms）。此时未增加超时，未将定向通过替代全量失败。新增仅输出耗时、HTTP 状态、连接错误码、进程退出状态和 stdout/stderr 字节数的安全诊断，不转发运行时原文。强制 TSX_DISABLE_CACHE=1 的单文件冷编译复现为 6/7：6527 ms 时 ECONNREFUSED，子进程仍存活、尚无 stdout/stderr；说明此复现处于监听前，而非租户健康接口已连接后等待。普通缓存单文件已通过，但不据此证明两次全量失败完全同因；当时冷启动耗时及全量启动问题尚未解决，因此不再归因于并行负载。首次管理页冒烟真实发现焦点丢失，修复后保留并加强断言复跑通过。随后基于已复现的冷编译监听前超时，将源进程集成测试的启动阶段改为引用现有 supervisorPolicy.startupTimeoutMs（60000 ms），测试总期限为该值加原业务预算 25000 ms；这是明确的测试期限调整，不是生产性能修复。生产策略、业务执行断言、权限/CSRF、付费准入、上下文预算和未知结果不重试规则不变。强制禁用 tsx 缓存复测 7/7（8050.0639 ms），随后最终完整串行全量通过：804 项、803 通过、0 失败、1 POSIX 专用跳过，332106.0344 ms，workflow API 集成项 12770.5055 ms。保留前述失败历史，仍不声称先前全量失败完全同因。

## 范围 / Scope

- 章节解析：手动起止范围或最近 N 章、真实模型显式准入、幂等调用记录、独立报告、项目与租户隔离、完整输入上限与崩溃不重试。
- 当前增量：国际化、项目卡删除、历史章节状态和折叠、安全取消/保留平台记录本地删除、Token 管理统计、审阅工作台、前端 UTC+8、可配日志时区与章节连续性。
- 不覆盖私有本地 `.mnemon/`、个人截图、Token 账本、真实配置或业务数据；不执行真实付费模型、平台、短信或邮件操作。

## 2026-11-15 发布验证（历史） / Super-workflow and supervisor publication validation (historical)

本轮包含超级小说模板、本地世界观导入与正式历史上下文、生产核心守护、管理员日志与告警预留接口、作品标题工作流跳转、文档与 Docker 入口。保持 v0.0.5a / 0.0.5-a，不修改其他历史 Release。以下历史数字不是本轮验收。

| 本轮检查 / Current check | 结果 / Result |
| --- | --- |
| Full tests / build | Final serialized full suite: 800 tests, 799 passed, 0 failed/cancelled, 1 POSIX-only skip on Windows; 314132.4204 ms. Final root typecheck, server build (4 SQL resources) and web production build passed. Only existing Zod annotation and large-chunk build warnings remain |
| Isolated browser | Projects library passed: real super-template creation and exact ordered node kinds, default template retained, auto-generate/publish off, title navigation and 1440/1100/768/390 widths. Administration passed: log filters, alert CAS/reserved channels, keyboard, backup/restore-plan and 1440/768/390 widths. Temporary data only, no paid/provider calls |
| Guardian fixtures | Windows focused run: 12 passed, 0 failed, 1 POSIX-only test skipped. Isolated compiled real core passed ready IPC, HTTP health, graceful IPC shutdown, data-lock release and no restart. Linux/POSIX restart and descendant cleanup are not runtime-validated here. Windows intentionally fails closed on crash and does not auto-restart |
| Locale / dependencies / privacy | Locale AST: 69 files, 2092 literal calls, 0 violations; 353 remaining literals/expressions require contextual review (not blanket exemptions). Eleven locale tests passed. Official npm registry production audit: 0 vulnerabilities (configured mirror returned unsupported POST 405, not an advisory result). Release filename/credential scan passed 473 files; private local artifacts excluded |
| Docker | Compose configuration passed. Docker Engine named pipe unavailable; image build/container runtime not performed. Core/supervisor/container shutdown budgets are 20/25/30 seconds; outer restart disabled |
| Archive / GitHub (historical publication) | Published commit `72a73e92acc497533e3868e0b848fe0bbfaade64`; archive SHA-256 `cfd1edfcc686ebacf32b425f832a22096e71e68ad47af54822f1190086ec581c`, 2061390 bytes. Verified 473 tracked source files byte-for-byte and remote asset digest; only v0.0.5a tag/release replaced. This historical archive does not contain the 2026-11-17 uncommitted regression fixes |

第一次并发全量测试遇到既有 workflow API 6 秒就绪和数据库 Worker 5 秒时限失败；对应未改动的定向 14 项复测通过。随后串行测试的 TEMP 误设于仓库隐藏目录，导致根发现测试继承真实仓库祖先、静态托管因隐藏路径返回 404，同时 workflow 就绪仍超时；改用仓库外非隐藏临时目录再跑全量，不放宽断言或声称永久修复。构建时曾捕获新守护测试策略的字面量类型不匹配，已修正为受验证的数值策略类型，须以最终构建结果为准。

## 上次同版本更新验证（历史） / Previous same-version refresh validation (historical)

在用户明确授权后，现有 v0.0.5a 标签、说明和同名资产将更新至本次提交，npm 版本仍为 0.0.5-a；其他历史版本不变。先前下载的归档与校验和对应旧提交，不代表本次产物，必须重新下载校验。发布前保留原始归档用于追溯。

新增范围为独立 Header / Footer、管理员站点外观、可选公司名称、固定作者链接及 2026–2099 双语 MIT 许可。显示设置限制为安全颜色与数字；匿名只读仅暴露站点显示配置，修改仍受权限、CSRF 和修订 CAS 保护。完整备份包含站点外观配置；其他客户端不会自动实时同步已打开页面。

| 本次更新检查 / Refresh check | 结果 / Result |
| --- | --- |
| Full tests | final: 763/763 passed, 0 failures/skips/cancels, 298030.55 ms. First run: 762/763; the unchanged workflow API readiness assertion reached its 6-second startup deadline with empty logs. The focused unchanged workflow suite then passed 7/7, followed by this complete serialized rerun. No timeout or safety assertion was relaxed; intermittent startup root cause is not claimed fixed |
| Typecheck and web/server build | passed after documentation and theme README refresh; Web and Server compiled artifacts included only after clean-commit packaging |
| Navigation/administration/tenancy/locale focused regressions | 54/54 passed before documentation refresh |
| Site appearance isolated browser | passed against a disposable backend: real persistence, 409 conflict, restart, fixed attribution, theme defaults, bilingual 390px; no live-site writes |
| Broader browser regression | all 18 suites passed across serialized disposable-root runs. Initial unified run: 17/18; administration UI still expected 6 tabs and the former last tab. Updated only smoke assertions to require all 7 tabs, the new appearance tab and correct End/arrow wraparound while retaining focus, ARIA, visibility and overflow checks. Final administration rerun passed (5519 ms); no product behavior or safety guard was loosened. All suites use isolated data and sanitized environments, not live user data |
| Dependency, locale, documentation and privacy checks | official npm audit: 0 vulnerabilities, 451 dependencies (248 production, 176 development, 97 optional; categories overlap). Locale AST: 67 files, 2044 literal calls, 2106 merged keys, 0 violations; 321 expressions reviewed contextually (not blanket exemptions). Documentation: 70 Markdown files, 568 relative inline links and 51 heading anchors, 0 missing within checked scope. Privacy/credential-marker check: 457 files passed, private local files excluded. Docker Compose configuration passed; Docker image/runtime not validated because Engine is unavailable |
| Archive and GitHub identity/digests | gated on clean commit and post-commit verification; final receipt reported separately |

## 原始发布结果（历史） / Original publication results (historical)

以下是更新前 v0.0.5a 的结果，不替代上方本次验证。

| 检查 | 结果 |
| --- | --- |
| Node | v24.22.2 |
| npm official audit | 0 vulnerabilities; 451 dependencies (248 production, 176 development, 97 optional; categories overlap) |
| Docker Compose configuration | passed |
| Docker image build/runtime | not performed: Docker Engine named pipe unavailable |
| Full tests | final: 748/748 passed, 0 skips/cancels, 299122.7444 ms. First run: 744/745; sole failure was the explicit registry-order expectation missing `chapter-analyses`. Exact order/duplicate-ID assertions retained and updated; three additional defensive lifecycle tests included in the final run |
| Typecheck and web/server build | passed: integrated build, followed by final shared typecheck and server rebuild |
| Isolated browser regressions | all 17 suites passed across serialized isolated runs. Final unified run: 16/17; `smoke.mjs` hit its unchanged 10-second startup readiness deadline with empty logs, then passed unchanged in an isolated rerun (21556 ms total). Earlier five stale smoke contracts were corrected for localized count spacing, the new usage tab, local diagnostics GET fixtures and responsive-style readiness; no safety/overflow assertions were removed |
| Locale and documentation checks | locale AST: 62 files, 2019 literal translation calls, 2083 merged keys, 0 violations; 305 expressions require contextual review (not exemptions). Documentation: 67 Markdown files, 487 relative inline links and 49 Markdown heading anchors checked; 0 missing. External/reference-style/HTML links and all GitHub slug edge cases are not certified |
| Release privacy/source/archive checks | filename/credential-marker scan passed for 439 files; private local files excluded. Packaging is gated on a clean committed tree; post-commit verifier checks SHA256, manifest, non-empty builds and byte equality for every tracked source file before upload |
| GitHub push and release verification | performed after this report is committed: require pushed master/tag to equal the packaged commit, both release assets uploaded, and archive digest equal local SHA256. Final publication receipt is reported separately; this source report does not self-certify a future upload |

## 边界 / Limitations

测试使用临时数据、模拟服务与独立浏览器，不证明真实模型文字质量或供应商送达、生产 TLS、OIDC、Turnstile、平台送审或厂商 SQL 验收。WebGL 测试可使用软件渲染；无 WebGL 时提供等价表格。Token 统计从新调用开始，pending 不是供应商收到请求的证据；UTC 分桶不随前端 UTC+8 显示变更。

已知历史源码 Worker 与 API 测试启动存在间歇时限失败；本次若出现，须保留失败和复测原因，不放宽断言、跳过测试或声称永久修复。账本是有界的单写者本地遥测，不是 SQL 故障回退或计费凭证。完整备份须涵盖该账本并停止写入；恢复仍须停服。保留平台证据删除仅移除本地作品，不是完全抹除；未知远端目标的写入阻止必须继续生效。

Release assets must exclude dependencies, secrets, live data, local telemetry, personal screenshots, browser profiles and local memory. The archive must match the committed tracked source and include non-empty compiled web/server output and a commit manifest. Other historical tags/releases are preserved; the explicitly authorized same-version v0.0.5a refresh replaces that tag and its same-named assets.
