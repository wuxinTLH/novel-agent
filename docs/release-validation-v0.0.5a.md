# v0.0.5a 发布验证 / Release validation

本记录对应本次工作树，历史 v0.0.4a 报告不作为当前验收。发布前结果在此逐项记录；尚未完成的步骤不得解释为通过。

## 范围 / Scope

- 章节解析：手动起止范围或最近 N 章、真实模型显式准入、幂等调用记录、独立报告、项目与租户隔离、完整输入上限与崩溃不重试。
- 当前增量：国际化、项目卡删除、历史章节状态和折叠、安全取消/保留平台记录本地删除、Token 管理统计、审阅工作台、前端 UTC+8、可配日志时区与章节连续性。
- 不覆盖私有本地 `.mnemon/`、个人截图、Token 账本、真实配置或业务数据；不执行真实付费模型、平台、短信或邮件操作。

## 当前结果 / Results

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

Release assets must exclude dependencies, secrets, live data, local telemetry, personal screenshots, browser profiles and local memory. The archive must match the committed tracked source and include non-empty compiled web/server output and a commit manifest. Historical tags/releases are preserved.
