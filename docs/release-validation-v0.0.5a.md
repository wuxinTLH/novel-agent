# v0.0.5a 发布验证 / Release validation

本记录对应本次工作树，历史 v0.0.4a 报告不作为当前验收。发布前结果在此逐项记录；尚未完成的步骤不得解释为通过。

## 范围 / Scope

- 章节解析：手动起止范围或最近 N 章、真实模型显式准入、幂等调用记录、独立报告、项目与租户隔离、完整输入上限与崩溃不重试。
- 当前增量：国际化、项目卡删除、历史章节状态和折叠、安全取消/保留平台记录本地删除、Token 管理统计、审阅工作台、前端 UTC+8、可配日志时区与章节连续性。
- 不覆盖私有本地 `.mnemon/`、个人截图、Token 账本、真实配置或业务数据；不执行真实付费模型、平台、短信或邮件操作。

## 同版本更新验证 / Same-version refresh validation

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
