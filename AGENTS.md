# Novel Agent 开发入口

本仓库是 Node.js ^22.23.4 或 ^24.22.2 / TypeScript ESM monorepo：React 19 + Vite 7 前端、Express 5 后端与 shared 共享契约。使用 npm 和根 package-lock.json，不混用包管理器。先检查 git status，保留已有未提交改动，不覆盖真实 data、密钥和浏览器登录态。

## 按需加载项目 Skill

Skill 存放在 `.dsh/skills/<name>/SKILL.md`，由 DSH 项目级目录发现；若客户端不支持自动发现，显式读取对应文件。不要一次加载全部内容。

| 工作 | Skill |
| --- | --- |
| 节点执行、调度、章节生成与候选采纳、模型调用 | novel-workflow-consistency |
| React 页面、主题、交互、浏览器冒烟与可访问性 | novel-web-regression |
| 认证、CSRF、权限、租户、上传与远端副作用 | novel-security-boundaries |
| JSON/SQL 存储、Worker、CAS、迁移与性能优化 | novel-storage-performance |
| 平台适配、番茄发布队列、账号锁与未知结果核对 | novel-platform-publication |

跨领域变更加载所有相关 Skill。共享接口先检查 `shared/`，后端先检查 `packages/server/README.md` 与对应 feature README；文档与代码不一致时以实现和测试核实，不将历史报告当作当前验收。

## 验证与安全基线

- 先运行相关 `.test.ts`：`node --import tsx --test <明确的测试路径>`，再按风险运行 `npm test`、`npm run typecheck` 和两端构建。
- 测试框架是 Node test + tsx，不默认引入 Vitest/Jest。根测试收集器只收集 shared 和两端 src 下的 `.test.ts`。
- 冒烟通常依赖已构建产物，先读脚本确认临时 DATA_DIR、端口和清理逻辑。禁止将测试指向真实用户数据或真实远端发布目标。
- 未知远端结果不重发；未经明确授权，不调用付费模型、短信、SMTP、真实数据库迁移或平台发布。
- local/server 监听、认证、同源/CSRF、单应用实例及持久化失败关闭边界不能因“优化”放宽。
- 日志、截图与报告不包含 token、Cookie、正文或连接凭据；不要为调试直接读取 `.env` 或 data 中的秘密。

## 工具扩展

审计结论、MCP 接入与验收步骤见 `docs/agent-capabilities.md`。`.dsh/mcp/playwright/` 是待通过 DSH plugin_manager 安装的配置型 bundle，不是已运行的 MCP，也不是应用依赖。不要手工修改受管理 profile；不要将其他客户端的 mcpServers JSON 当作 DSH 配置。
