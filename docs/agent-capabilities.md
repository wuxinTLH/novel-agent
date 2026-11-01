# 项目 Skill / MCP 审计与接入

## 结论与范围

审计覆盖根脚本、shared 契约、两端主要子系统、测试/冒烟入口及当前 Harness 的扩展机制；不是逐行安全审计，也不证明其他 profile 没有安装 MCP。审计前本仓库没有已跟踪的项目 SKILL.md、AGENTS.md 或 MCP 配置。现有通用开发技能不能替代本项目的提交一致性、租户与发布边界。

本次只增加 agent 指导与可选工具配置，不修改应用实现，不添加根依赖，不覆盖已有认证/短信/API 等未提交改动。

## 已增加的项目 Skill

| Skill | 用途与优化边界 |
| --- | --- |
| [novel-workflow-consistency](../.dsh/skills/novel-workflow-consistency/SKILL.md) | DAG、并发、取消与候选采纳；不靠跳过审校或破坏串行屏障提速 |
| [novel-web-regression](../.dsh/skills/novel-web-regression/SKILL.md) | React 性能、草稿、身份缓存、国际化、可访问性与页面回归 |
| [novel-security-boundaries](../.dsh/skills/novel-security-boundaries/SKILL.md) | Host/Origin/CSRF、服务端身份、租户与上传边界 |
| [novel-storage-performance](../.dsh/skills/novel-storage-performance/SKILL.md) | 同步 COMMIT、CAS、Worker、模拟基准与离线迁移 |
| [novel-platform-publication](../.dsh/skills/novel-platform-publication/SKILL.md) | 发布队列、预览批准、账号锁、未知结果只读核对 |

入口：[AGENTS.md](../AGENTS.md)。当前 DSH 已通过项目目录发现这五项；其他客户端需要自己支持项目 Skill 发现，或显式读取文件。不把仓库指导误作运行时功能或已经测得的性能提升。

## MCP 选择

- **可选增加 Playwright MCP**：用于本地 UI 的连续快照、定位、交互和可访问性回归。现有 Playwright 冒烟脚本足够时优先使用脚本，不为了工具数量强制启动 MCP。
- **不增加 filesystem/git MCP**：已有原生读取、搜索、编辑、Git 命令能力，重复工具扩大暴露面。
- **不增加数据库/平台发布 MCP**：现有存储适配器和测试入口足够；额外服务会增加数据库凭据、破坏性操作和真实发布风险。
- **不新增记忆服务**：当前已有 Mnemon/Hindsight 接口。此次 Hindsight 请求返回认证失败，未擅自补凭据；这与是否缺少 MCP 不同。

## Playwright bundle：已准备，尚未安装

配置位于 [package.json](../.dsh/mcp/playwright/package.json) 和 [cordis.patch.yml](../.dsh/mcp/playwright/cordis.patch.yml)。这是 **DSH Cordis 配置型 bundle**，不是其他客户端的 mcpServers JSON，也不会因放入仓库自动启动。

- 固定依赖：`@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`（与本机客户端版本一致）、`@playwright/mcp@0.0.83`（此次查询注册表得到的固定版本）。未执行依赖安装；固定顶层版本不等于已有完整依赖锁或供应链审计。
- 使用当前 Node 进程与 bundle 内解析的 CLI，避免 Windows `npx.cmd`/shell 引号问题。
- `stdio`，serverName 为 `novel-playwright`，headless、isolated、禁用 service workers 与 WebMCP。
- 仅配置本项目默认回环 origins `http://127.0.0.1:5173` 和 `http://127.0.0.1:3001`；**origin 列表不是安全沙箱，也不完整约束重定向**。仅浏览可信本地测试页面，必要时使用 OS/网络隔离。
- cwd 和输出路径明确写为 `E:/code/novel agent` 与其 `test-results/playwright-mcp` 子目录。移动仓库必须同时更新这两处；测试端口变化须显式调整 origins。
- 未配置秘密、个人浏览器 profile、CDP 连接、文件任意读取或 `--no-sandbox`。isolated 不表示操作系统文件权限隔离；MCP 进程仍继承宿主权限，不得授权访问真实数据、密钥或平台登录资料。
- 产物目录已被仓库忽略，但忽略不等于脱敏：仅使用合成账号/文稿，避免生成秘密截图和 trace。

### 安装与验收（需要后续具备管理能力的会话）

1. 当前会话未提供 `plugin_manager`，所以 **没有安装、没有启动、没有 MCP tools 注册或端到端验收**。不要手工编辑受管理 profile，也不要在其目录运行包管理器。
2. 在具备插件管理能力的 DSH 会话中，先检查当前 profile 插件清单，确认无重复 server；安装可能影响同 profile 的其他项目，需确认此范围。通过 `plugin_manager` 按其 schema 将本仓库 `.dsh/mcp/playwright` 目录作为本地 bundle 安装，保留安装返回的 application/warnings。
3. 安装可能下载依赖或需要 Chromium；网络、文件权限与浏览器安装按提示授权，不绕过沙箱拒绝。无需更改应用根依赖。上游 MCP 使用的 Playwright 版本不保证复用仓库现有浏览器缓存。
4. 新会话确认出现 `mcp__novel-playwright__*`。先做无副作用工具枚举/健康检查（若有），再调用 browser snapshot 验证连接；没有健康工具不虚构 ping 通过。
5. 页面验收前阅读现有 smoke 脚本，使用临时 DATA_DIR、环境白名单和合成账号启动独立测试实例。不得将已含真实数据的默认 dev 实例直接交给 MCP。不要把 DSH GUI 的 3080 端口当成本项目页面。
6. 对准精确回环测试 URL，验证页面快照、一个正常交互、一个错误/权限路径，检查 console 与失败请求；关闭测试浏览器/实例。连接错误修复同一 bundle，不重复创建同名服务。

### 参考

- [Playwright MCP 官方说明](https://github.com/microsoft/playwright-mcp)：CLI 参数、隔离模式、origin 限制与安全边界。
- [此次查询的 npm 元数据入口](https://registry.npmjs.org/@playwright/mcp/latest)：版本会随时间变化，配置固定为本次确认版本，不使用运行时 `latest`。

## 验证原则

本次配置/文档变更优先验证 Skill 元数据、引用路径、bundle JSON/YAML 与 Loader 表达式结构，以及项目类型检查和代表性本地测试。不因此自动调用付费模型、短信/SMTP、真实数据库或番茄发布。没有执行的浏览器、在线数据库或生产验收必须明确标为未验证。

### 本次验证结果

- 通过：5 项 Skill 的 YAML 元数据、名称/目录匹配、38 个字面项目引用、bundle JSON/YAML 和两个 Loader 表达式的语法检查。当前会话的 Skill 目录已显示全部五项。
- `npm run typecheck` 未通过：已有未提交改动中的 [account.test.ts:857](../packages/server/src/features/auth/account.test.ts#L857) 报 TS2339（`account` 不存在于 `never`）和 TS7006（参数 `p` 隐式 `any`）。本次不改动该业务测试。
- 计划执行的 `shared/workflow-scheduler.test.ts` 与 `shared/model-runtime.test.ts` 未运行：沙箱运行器在命令执行前返回 `EXECUTOR_UNAVAILABLE` / `CreateFileMapping` Win32 error 5；未绕过或重试该命令。
- 未安装 MCP 依赖、未启动浏览器、未完成 MCP tools/端到端验收；静态校验不能替代这些步骤。
