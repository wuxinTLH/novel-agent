# v0.0.5a — Chapter analysis, usage analytics and site appearance

Release tag: `v0.0.5a` · npm/package SemVer: `0.0.5-a`

## 中文

本次预发布包含 v0.0.4a 以来的当前增量，并在用户确认后更新已有 v0.0.5a 的标签、说明和同名资产；版本仍为 v0.0.5a，其他历史版本不变。**先前下载的 v0.0.5a 不会自动更新，旧校验和不适用于替换后的资产，请重新下载并核对新的 SHA-256。** 不声明公网生产就绪、认证合规或真实外部服务全面验收。

- **导航与站点外观：** Header / Footer 独立组件；超级管理员和管理员可配置安全颜色、字号、间距及默认留空的公司名称。即时预览、修订冲突保护和持久化，保留主题默认背景。仅允许固定安全属性，不接受任意 CSS、HTML 或脚本；公共只读接口仅暴露显示配置。
- **署名与许可：** 页脚固定 © SakuraMikku，项目链接在新窗口打开并带安全 rel 属性，公司版权不替换作者署名。新增 2026–2099 中英文 MIT 许可，英文原文为准。

- **章节解析：** 在书稿页选择手动起止章或最近 N 章，显式调用所选模型，分析写法、节奏、剧情规划与推进、人物变化、伏笔及章节衔接。报告和调用状态独立保存，可重复查看，不修改正文。来源章节固定修订和哈希；超限拒绝而非静默截断，无自动付费调用或未知请求重放。
- **章节连续性：** 规划、写作与审校获得独立前章结尾锚点，要求状态过渡及前后证据；修改或恢复前章使后续相关节点失效，防止旧规划授权写作。已有章节不自动覆盖，仍需人工对比候选。
- **阅读与语言：** 放大生成进度、流式预览和候选阅读区；移动端自适应。集中双语系统文案与回归审计，保留用户正文、名称和模型结果原文。历史已完成但正文已删除的章节正确标识并折叠，不改写历史记录。
- **Token 用量：** 超级管理员和管理员专属 Three.js 饼图/柱图、明细表和模型筛选；UTC 日范围最多 31 天。记录准入、成功、失败及 pending，显示请求和 Token、平均/峰值 RPM/TokenPM。仅记录启用后的调用，不补造历史；pending 不证明供应商已接收。WebGL 失败时可读表格仍可用。
- **作品删除：** 作品卡删除、未变更远端的安全批次取消，以及显式二次确认的“保留平台记录并删除本地作品”。后者保留完整平台证据而非全量抹除，历史未知目标仍禁止盲写；不自动重发、核销、清空或删除远端草稿。
- **时间：** 前端时间戳以 UTC+8 的 `yyyy:mm:dd HH:mm` 显示，无后缀。后端普通日志默认 `Asia/Shanghai`，`LOG_TIME_ZONE` 可配置 IANA 时区。业务 ISO 时间、安全审计和统计 UTC 日桶不变。

### 升级与资产

升级前停止写入，备份本地数据、SQL 业务仓库及独立密钥；Token 统计本地账本及站点外观配置也须纳入备份。停止原服务后替换产物再启动；活跃浏览器会话不随重启保存，必要时重新登录核验。解析中的进程被终止后不会自动重试模型调用。服务端认证/短信、同源 HTTPS、hardened 审计、单实例/非 HA 边界不变。

资产为 `novel-agent-v0.0.5a.tar.gz`（跟踪源码及本次 web/server 编译产物）和 `SHA256SUMS.txt`，包含提交 manifest。不含 node_modules、真实数据、环境凭据、Token 账本、个人截图、浏览器登录态或本地记忆。使用 Node `^22.23.4 || ^24.22.2`；解压后按部署指南安装生产依赖及 sharp，再启动编译入口。GitHub 自动源码归档不含编译产物。Docker 标识为 `novel-agent:v0.0.5a`，不含 Chromium。

实际测试结果以[本次验证报告](docs/release-validation-v0.0.5a.md)为准。既有源码 Worker/测试启动时限的间歇失败不因发布自动成为“已修复”；若复现须同时记录失败与复测。隔离 stub 不证明真实付费模型质量、供应商 SQL、短信、SMTP/OIDC/Turnstile、TLS 或番茄送审验收。

详见[章节解析](docs/chapter-analysis.md)、[Token 统计](docs/token-usage.md)、[部署](docs/deployment-modes.md)和[番茄接入](docs/番茄平台接入.md)。

## English

This prerelease includes the changes since v0.0.4a. With explicit user approval, the existing v0.0.5a tag, notes and same-named assets are updated without changing the version; other historical versions remain unchanged. **Previously downloaded v0.0.5a archives do not update themselves, and old checksums do not validate the replacement. Download again and verify the new SHA-256.** No public-production readiness, certification or full external-service acceptance is claimed.

- **Navigation and site appearance:** independent Header/Footer components, with administrator/super-administrator configuration of safe colors, font sizes, padding and an optional company name (empty by default). Includes previews, revision-conflict protection, persistence and theme-preserving defaults. Arbitrary CSS/HTML/scripts are rejected; the public read-only endpoint exposes presentation settings only.
- **Attribution and license:** mandatory © SakuraMikku footer link opens the project in a new tab with safe rel attributes; optional company copyright never replaces author attribution. English MIT and a Chinese reference translation cover 2026–2099; the English text governs.

- **Chapter analysis:** explicitly invoke a selected model over a chapter-number range or the latest N canonical chapters. Analyze style, pacing, plot planning/progression, characters, foreshadowing and continuity. Durable reports and invocation records are separate from manuscript text; source revision/hash references remain fixed. Oversized input is rejected, not silently truncated; uncertain calls are never automatically replayed.
- **Continuity:** independent previous-chapter endings inform planning, writing and review; transitions require evidence. Editing/restoring a predecessor invalidates relevant later node contexts. Existing prose is not overwritten automatically.
- **Review and localization:** larger preview/candidate panes, responsive reading, bilingual system-copy catalogs and accurate collapsed deleted-manuscript history. User content, custom names and model output remain unchanged.
- **Token analytics:** only administrators and super-administrators may view Three.js pie/bar charts and accessible tables. UTC day filters span at most 31 days, with model/request/Token totals and average/peak RPM/TokenPM. Durable admission, success, failure and pending are distinguished; pending does not prove provider receipt. No fabricated historical usage. Tables survive unavailable WebGL.
- **Deletion and evidence:** project-card deletion, cancellation of provably unmutated batches, and separately confirmed local deletion while retaining platform records. Retention is not complete erasure; orphan unknown targets remain write-blocked. No automatic remote replay, evidence clearing or remote draft deletion.
- **Time:** UTC+8 frontend timestamps use `yyyy:mm:dd HH:mm` without a suffix. Backend ordinary logs default to `Asia/Shanghai`, configurable through `LOG_TIME_ZONE`. Business ISO timestamps, security audit chains and UTC statistical buckets are unchanged.

### Upgrade and delivery

Quiesce all writers and back up local data, SQL repositories, the local Token ledger, site appearance configuration and independent keys. Stop before replacing artifacts/restoring. Browser sessions require re-login after restart. Interrupted analysis calls are not automatically retried. Server authentication/SMS, exact same-origin HTTPS, hardened auditing and single-instance/non-HA restrictions remain.

Assets: `novel-agent-v0.0.5a.tar.gz` (tracked source and compiled web/server output) and `SHA256SUMS.txt`, with a commit manifest. Dependencies, live data/environment credentials, Token ledger, personal screenshots, browser state and local memory are excluded. Node `^22.23.4 || ^24.22.2` is required. Install production dependencies and rebuild sharp as documented before starting the compiled server. GitHub-generated source archives need a separate build. Docker identifies `novel-agent:v0.0.5a` and excludes Chromium.

The [validation report](docs/release-validation-v0.0.5a.md) records actual results and limitations. Historical intermittent source-worker/startup deadlines are not declared fixed by release work; preserve failures and repeats if reproduced. Stub tests do not establish real paid-model quality, vendor SQL, SMS, SMTP/OIDC/Turnstile, TLS or Fanqie review acceptance.

See [chapter analysis](docs/en/chapter-analysis.md), [Token analytics](docs/en/token-usage.md), [deployment](docs/en/deployment-modes.md) and [Fanqie](docs/en/fanqie-integration.md).
