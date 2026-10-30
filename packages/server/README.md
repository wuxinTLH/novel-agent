# 小说创作工作台后端

中文 | [English](README_en.md)

工作区包名：`space.syjx.agent.novel.server`。源码位于 `src/`，由根工作区统一安装、启动、测试与构建。

## 目录与责任

- `src/index.ts`：进程入口，负责环境加载、数据锁、服务装配、监听与关闭。
- `src/core/`：应用装配、HTTP 策略、功能注册及应用根目录定位。
  - `tenancy/`：用户作用域、租户应用和隔离租户 Worker；不是独立部署的服务。
- `src/infrastructure/`：被业务功能复用的技术能力。
  - `storage/`：文档存储边界、存储配置、PostgreSQL 与关系存储、同步桥和数据库 Worker。
  - `storage/sql/`：数据库初始化与迁移资源；构建时复制到对应编译输出目录。
  - `database/`：SQLconnect 连接设置、数据库探测与显式初始化入口和方言驱动。
  - `security/`：模型与平台本地加密凭据存取。
- `src/features/`：按业务责任组织，路由与对应业务逻辑、测试尽量放在一起。
  - `auth/`：认证、会话与用户身份边界。
  - `administration/`：本机管理 API、管理员 CLI、全量备份恢复与维护 CLI。
  - `projects/`：作品默认值、作品数据与迁移、项目 API 和变更操作。
  - `assets/`：资料和上传文件 API。
  - `chapters/`：章节编辑与手动创建。
  - `workflow/`：工作流 API、图结构校验和完成后的发布接续。
  - `generation/`：模型调用执行器与生成校验；`routes/` 保留独立的生成 API 模块。
  - `models/`：模型库、运行设置与模型提供者。
  - `platforms/`：平台适配、浏览器/扩展桥、会话、发布预览与持久化发布队列。

## 跨目录边界

- 前后端共享协议继续位于仓库根目录 `shared/`，不复制为两套定义。
- 根目录 `public/` 是前端静态资源源文件；根目录 `dist/` 是默认前端生产构建产物。可选 [Web 托管模块](src/core/web-hosting.ts)默认提供静态访问与 SPA fallback；API 错误与未知 API fallback 仍由 HTTP 层处理，不回退 HTML。
- 根命令 `npm run build:server` 独立构建后端、Worker 与 SQL 资源，`npm run build:web` 独立构建前端。`SERVE_WEB=false` 关闭 HTML / 主题 / SPA 托管，无需前端产物；默认 `true`，其它字符串拒绝启动。`WEB_DIST_DIR` 默认为应用根目录 `dist`，相对路径以应用根目录解析，可设可信绝对目录；有 `index.html` 才托管，勿指向数据 / 备份 / 源码目录。
- 独立静态服务器须将 `/api`、`/uploads` 同源代理到单一后端，保留 Host / Origin / Cookie / CSRF 与状态，不为业务接口开放跨源 CORS。HTTPS 需显式可信 origin；不信任转发头或放宽本机管理。见[部署指南](../../docs/使用手册.md#前后端独立构建与同源部署)。
- `.env`、默认 `data/` 及相对 `DATA_DIR` 均以工作区/部署根目录为基准，而不是进程当前目录或后端包目录；现有用户数据无需搬迁。
- 后端编译产物位于根目录 `build/packages/server/src/`；租户 Worker、数据库 Worker 与其调用模块保持相对位置。SQL 资源随构建输出复制到 `infrastructure/storage/sql/`。
- 应用根目录通过向上查找包含 `workspaces` 且名称为 `novel-agent` 的根清单定位；生产部署需保留根清单。不要仅凭当前目录推断数据位置。
- 管理与维护操作仍通过根目录命令 `npm run admin -- ...`、`npm run maintenance -- ...` 执行；目录整理不改变认证、数据格式或发布安全边界。

## 工作流默认值与并发

新建章节模板仍为三个创作节点：章节规划（`plan`）→ 正文生成（`draft`，类型 `writer`）→ 一致性审校（`review`，类型 `audit`），外加系统开始/结束节点。世界观、剧情编排可独立使用；作者按需添加的可选节点不改变默认模板。

`maxParallelNodes` 接受 1–8 的整数，省略时按串行（1）运行。生成引擎将并发上限限制为 8，且仅调度依赖已就绪的节点；提高上限不会让线性图自动并行。这是源码契约说明，不代表已完成线上验收。

`CoreModel` accepts only `local` / `server` (unset: local; invalid: fail). Local binds only `127.0.0.1`; server binds `0.0.0.0`, requires offline-enabled auth, hardened/audit, exact HTTPS origin, independent >=32-character keys and gateway off behind a same-origin real TLS proxy. See [deployment modes](../../docs/deployment-modes.md).
