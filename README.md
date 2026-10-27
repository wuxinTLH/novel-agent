# Novel Agent

面向本机和可信局域网的小说创作工作台，版本 `v0.0.2a`。支持多作品、多工作流、世界观编写、章节创作、资料管理、模型库、主题和数据保存；默认仍为免登录单用户，可通过本地管理 CLI 显式启用认证与租户隔离。不是面向公网的生产部署方案。

## 快速开始

需要 Node.js 22.16 及以上版本。

```powershell
npm ci
npm run browser:install
npm run dev
```

开发界面是 `http://127.0.0.1:5173`，API 是 `http://127.0.0.1:3001`。

生产运行：

```powershell
npm run build
npm start
```

生产界面是 `http://127.0.0.1:3001`。服务监听本机及局域网接口，仅供可信局域网使用，不要暴露到公网。

## 使用手册

- [完整操作手册](docs/使用手册.md)：安装、正文添加、登录绑定、草稿送审与全自动工作流。
- [番茄平台接入说明](docs/番茄平台接入.md)：能力边界、状态、接口及故障排查。
- [服务模块与用户边界](docs/services.md)：后端模块组织、认证与租户隔离、PostgreSQL 文档快照存储及限制。
- [SQLconnect 说明](docs/sqlconnect.md)：可选数据库连接、显式建表、凭据保护和部署资源。
- [主题扩展说明](public/themes/README.md)：主题注册表、独立 CSS 与生产部署。
- [更新记录](CHANGELOG.md)：功能变更与验证边界。

首次使用番茄登录需要在运行后端的桌面机器操作弹出的 Chromium。纯远程服务器没有可交互桌面时无法完成首次人工登录。

### 页面

- `/workflow`：创作工作流，可新建、切换、整理和运行节点。
- 左侧“创建人物”“创建世界观”会建立独立工作流；“创建小说”用于新建作品或小说工作流。
- `/assets`：设定资料，保存世界观、人物、剧情和章节资料。
- `/chapters`：章节书稿，编辑、生成、对比和导出章节。点击“添加正文（上传 / 手动编写）”可直接填写正文或上传 TXT（UTF-8 或 GB18030/GBK，最多 2 MB、单章 200000 字符），预览编辑后保存为正式章节；相同章号不会覆盖旧稿。保存不会自动触发远端发布，可到平台页上传或送审。
- `/platforms`：先从平台概览进入番茄二级页面，按左侧“核验账号 → 绑定作品 → 选择章节 → 预览并批准 → 核对结果”逐步操作；右侧每次只显示当前步骤，未完成前置步骤不能进入写入步骤，结果与异常可随时查看。番茄支持草稿回读、批量上传和送审；“自动审批”需显式开启，跳过本工具的逐批人工批准，但仍要核对远端结果。送审不等于已发布。
- 全自动工作流：在工作流设置选择“全自动”，并在平台页选定账号绑定、分卷、草稿/送审动作和 AI 声明，点击“保存当前选择并启用全自动接续”。完整的真实生成工作流成功保存章节后自动进入远端队列，不等待逐章批准；演示运行、单节点、校验/审校失败和版本冲突不会上传。旧配置默认手动。
- 远端已保存但本地显示未知时，在“核对结果”点击批次“只读核对远端结果（不重发）”。可使用已记录的远端章节 ID；若缺失，可从官方后台**该章编辑链接**人工提供准确章节 ID（不是作品 ID），并核对全文、账号、作品和分卷；送审另需精确回执。无法证明的结果仍保留未知，不自动重试。隐藏历史记录仅影响当前浏览器显示，不解除审计和防重复限制；“备份并清空本地暂存”则是有重复上传风险的单独高级恢复操作，不删除远端正文。
- `/settings`：模型库、协议、密钥、运行模式和 SQLconnect 数据库连接配置。

刷新页面会保留当前地址。未知地址显示 404，5 秒后返回上一页；应用错误可从错误页返回首页。

### 世界观编写

1. 在工作流页新建“世界观编写”。
2. 工作流包含开始、自写节点、扩写节点和结束节点。
3. 可填写世界观名称；留空时根据内容生成名称。
4. 运行后只保存世界观正文到设定库。
5. 设定审查、假设标注、章节规划和小说正文不会写入世界观。

世界观流程不创建章节。章节创作应使用独立的章节工作流。

### 章节创作

1. 在模型设置中选择真实模型，或明确使用演示模式。
2. 从工作流或章节页打开“配置目标与要求”。
3. 选择续写、指定单章或章节区间。
4. 保存作品要求或章节要求后运行。
5. 手动模式下已有章节重生成产生候选稿，明确采用后替换原稿；全自动模式下，完整工作流审校完成、硬性校验通过且原稿版本未变时自动采用，失败保留恢复稿并停止批次。

演示模式输出固定模板，不代表模型质量。真实模型调用前必须配置有效地址、模型 ID 和 API Key。

### 模型库

- 可添加多个模型，并在列表中切换当前模型。
- 支持 Chat Completions、Responses API 和 Anthropic Messages。
- 当前模型与运行模式默认保存在数据目录的 `models.json`；显式迁移后由选定 SQL profile 保存，重启后继续使用。模型密钥仍在租户本地目录。
- API Key 加密保存，不返回浏览器，也不写入项目内容。
- 只有模型库为空时才创建初始“默认模型”。已有模型不会在每次启动时被替换成演示模式。

### 节点配置

- 选中节点后可核对提示词、关联设定和直接上游节点；关联设定留空时使用全部设定。
- 节点可跟随全局模型或单独指定模型。指定模型被删除、禁用或缺少密钥时须修复配置，不会悄悄改用其他模型。
- 人物节点支持姓名、性别、性格、经历、模板及 1–100 人的数量配置；新节点使用统一预设，不覆盖已有提示词。

### 可选数据库连接

原 SQLconnect 设置继续使用数据目录的 `sqlconnect.json`，可测试 MySQL、PostgreSQL、SQL Server 并显式初始化预留表，但保存 / 初始化不迁移业务。新的 v3 关系存储通过 `storage-profiles.json` 支持多连接及 owner 映射，使用项目、章节、设定、工作流 canonical 实体表和带 revision 的文档 / 导入回执。三种方言已有适配器，**MySQL / SQL Server 目前仅模拟验证，真实服务器兼容性尚待验收**，不把连接探测或测试桩当作在线证明。

默认仍是本地 JSON。先自行创建目标数据库，配置 [安全 profiles 样例](docs/sqlconnect.md#v3-storage-profiles)，停止全部共享目标数据库的运行时，再执行（UUID 为明确的原目录 owner；命令不会开启认证）：

```powershell
npm run maintenance -- migrate-all --owner <UUID> --destination <EXTERNAL_BACKUP> --confirm
```

该命令持锁先创建外部完整应用备份，再校验全部租户映射、导入空目标、回读验证并激活；不是在线自动切换。激活后 SQL 出错不回落旧 JSON，连接配置须离线维护。旧 `npm run admin -- migrate-sql --owner <UUID> --confirm` 仍保留为 **legacy PostgreSQL v2** 单 owner 迁移，不是 v3 多租户迁移。详见 [使用手册](docs/使用手册.md#全量迁移到-v3-关系存储) 和 [服务边界](docs/services.md)。

### 可选认证

认证默认关闭；首次超级管理员仅能停服后本地创建，不提供公开注册或 HTTP 引导接口。预先通过安全方式注入环境变量 `NOVEL_BOOTSTRAP_PASSWORD`（至少 12 个字符、最多 1024 字节），然后执行：

```powershell
npm run admin -- bootstrap-admin --username admin --confirm
```

不要把密码放进命令参数、文档或 Git。创建身份不会开启认证。管理界面提供用户、数据库、备份与维护、系统与安全；认证关闭时仅真实 socket 回环 + 本机 Host / Origin 可管理，写操作还需管理 CSRF，局域网免登录用户不是管理员。首次超级管理员仍仅 CLI 引导；之后可创建 / 启停用户、变更角色、重置密码和撤销会话，保护最后一个有效超级管理员。认证开启后普通用户可在账号安全中改密、查看 / 撤销自己的会话；改密、重置、停用及角色变更撤销相关会话。记录返回的 `ownerId`，再执行 `npm run admin -- enable-auth --owner <UUID> --confirm` 显式将旧数据分配给该身份并启用认证，重启生效。无旧业务数据的新目录才可选 `enable-auth --no-legacy --confirm`；首次登录者不会自动取得旧数据。管理员可管理账号、停用用户及配置默认关闭的 Cloudflare Turnstile；后者需要真实 site key / secret、匹配的 action / hostname 和联网核验，目前不宣称已通过真实 Cloudflare 在线验收。

### 界面

- 顶栏可切换极简白、极简黑、跟随系统和蓝粉白主题，选择会保存在浏览器本地。
- 主题由独立 CSS 与注册表加载，菜单提供“重新加载主题”；加载失败保留当前外观，首次失败使用浅色兜底。新增与部署方式见 [主题扩展说明](public/themes/README.md)。
- 工作流、章节和表单控件使用统一的 SCSS 样式。
- 样式由 Vite 编译并默认启用静态缓存：带内容哈希的 CSS、JS 和字体可缓存一年；入口 HTML 使用 `no-cache`，更新后会重新获取最新资源。
- 窄屏下工作流工具栏自动换行。
- 删除、放弃等操作使用应用内确认框，不使用浏览器原生 alert。

### 节点整理

工作流画布提供四种整理方式：

- 按流程分层
- 横向排列
- 纵向排列
- 网格排列

整理只调整节点位置，不改变节点内容、连线方向或运行结果。

### 多工作流

- 每个作品可创建多条工作流；章节创作、世界观编写和空白模板彼此独立。
- 切换工作流会载入对应的节点、连线、运行设置和节点输出；修改只保存到当前工作流。
- 删除工作流不会删除作品章节与设定，且每个作品至少保留一条工作流。

### 作品与头像

- 工作流页“作品设置”可修改作品名称、类型、简介并上传 PNG、JPG 或 WebP 封面。
- 点击侧栏或顶栏头像可选择自定义图片。头像会裁切缩放后保存在当前浏览器，不会上传。
- PowerShell 7 用户配置将 Tab 和 Shift+Tab 设为菜单补全；支持虚拟终端时也启用历史与插件预测。

## 数据与安全

复制 `.env.example` 为 `.env` 后按需修改：

```dotenv
PORT=3001
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4.1-mini
MODEL_PROTOCOL=chat-completions
MODEL_API_KEY=your-api-key
```

- 默认业务数据保存在 `data/`，不提交到 Git；v3 显式迁移后由 SQL 接管业务文档及 canonical 项目 / 章节 / 设定 / 工作流实体，全局认证另存 owner 文档。本地仍保留上传、密钥、加密凭据及浏览器资料。
- 新维护 CLI 提供完整应用备份 / 恢复，包含全部配置的 v3 应用仓库 owners、文档 / 实体内容、revision、receipts，以及安全数据树的二进制 / 空目录；**不是全数据库 dump**。锁、临时文件、旧 admin-backups 和维护产物排除；外部环境密钥不包含，须独立保存。旧 v1 SQL 后端明确不支持此备份，须独立 `pg_dump` 加目录备份。详见 [恢复边界与排除项](docs/使用手册.md#全量应用备份与恢复)。
- 认证密钥 `auth.key` 保留在本地，按 `0600` 创建 / 收紧；Windows 仍需手工配置 ACL。丢失密钥会影响加密认证配置的解密。
- SQLconnect 数据库密码以明文保存在数据目录的 `sqlconnect.json`，不属于模型密钥的加密范围；保护操作系统账号、目录权限、Windows ACL 和备份。
- 模型地址不允许指向本机、内网或云元数据地址。
- 业务 API 修改请求仍需当前租户进程上下文的 `X-Platform-CSRF`；启用认证后另需有效会话及 `X-CSRF-Token`，原有来源 / 私网 HTTP 限制不因登录而解除。
- 同一数据目录只允许一个应用实例。v3 数据库 Worker 使用持久连接池；隔离租户内保留同步 COMMIT 屏障，同租户等待仍阻塞，主控制面及其他租户事件循环隔离，最多 32 个租户运行时。同一 profile 的 repository 快照门锁串行化相关操作，是一致性 / 吞吐取舍，非分布式服务或性能基准声明。SQL 行锁 / 版本冲突检测不保证跨主机运行时安全，不能多实例共享 owner 运行发布任务。认证控制面同步 SQL 写入仍可能有界阻塞主线程；平台账号锁也仅运行时内生效，不防止不同租户同时使用同一外部账号。
- 平台登录必须由用户在隔离浏览器中完成，应用不会代填密码或验证码，也不要求粘贴 Cookie、session 或 token。点击核验会自动进入作者首页，读取实时登录身份后保存会话。
- 固定配置 `PLATFORM_SECRETS_KEY` 才能加密跨后端重启保存平台会话；未配置时仅保存在内存。同步网站实际更新的浏览器状态，不臆造双 token 刷新接口；失效或验证码要求仍需重新人工登录。
- 草稿上传、覆盖与送审需要明确操作授权：手动批准，或显式开启自动审批 / 配置全自动工作流。自动审批不关闭账号、正文、版本和幂等校验。删除草稿保留独立确认及只读回查。
- 不提交平台会话、模型密钥、作品数据、公开站点研究缓存或个人截图。自动化测试不是对真实账号送审成功的证明。

### 离线备份与恢复

先停服（包括共享所选数据库的所有运行时），明确数据目录；目的备份目录必须在数据目录外且尚不存在：

```powershell
npm run maintenance -- backup --destination <PATH> --confirm
# 纯本地备份恢复：不传 --database-config
npm run maintenance -- restore --source <PATH> --data-dir <NEW> --confirm
# SQL 备份恢复：必须显式指定可信目标 profiles 文件，不使用备份中的源地址
npm run maintenance -- restore --source <PATH> --database-config <EXPLICIT_TARGET_PROFILES> --data-dir <NEW> --confirm
```

默认拒绝覆盖非空目录 / 非空应用数据库；保留旧目录 rollback 副本，但无跨数据库自动回滚。失败残留 `.maintenance-journal.json` 会阻止启动，须人工安全核对协调，不能简单删日志重试。恢复撤销认证会话，不重放远端发布；外部 `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY` 须安全提供，备份自身也含秘密，请保护 ACL。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

`npm test` 使用临时目录和本地测试桩，不会调用真实模型或平台账号。完成生产构建后，可运行 `npm run smoke` 验证默认模式，或运行 `npm run smoke:auth` 在独立临时目录中验证真实 Chromium 登录、超级管理员创建用户、双 CSRF 写入、退出与切换账号、会话刷新、后端重启后的会话 / 作品恢复和跨租户隔离；后者不连接真实 PostgreSQL 或 Cloudflare，不代表这两项在线验收通过。

真实 PostgreSQL 可通过显式 `npm run test:postgres` 验收：仅接受 `PGDATABASE=novel_test`，连接参数由 `PGHOST`、宿主机映射端口 `PGPORT`、`PGUSER`、`PGPASSWORD` 环境变量提供，切勿将密码写入命令参数或 Git。该脚本会执行真实 v2 迁移、写入并保留唯一 `test-pg-*` 测试 owner，不是只读探测。已在测试库通过重复迁移、已有 v1 表行数保持、实际提交读回、跨 owner 隔离、并发 CAS、幂等导入及事务回滚验收；不等同于已迁移用户当前工作目录，也不代表 Cloudflare 或真实平台发布验收。

构建后还可运行 `node scripts/smoke-administration.mjs`，使用临时目录和真实浏览器检查默认关闭认证的严格本机管理入口及管理界面，不连接真实数据库。新 v3 的可选真实 PostgreSQL 验收使用 `npx tsx scripts/test-relational-storage.ts`，要求显式安全提供 `PGHOST`、`PGPORT`、`PGDATABASE=novel_test`、`PGUSER`、`PGPASSWORD`；默认验证 TLS，`PGSSLMODE=disable` 仅允许回环。该脚本会建 v3 结构、写入并保留唯一 `test-v3-*` 测试 owner，不清理既有数据，不是只读探测。尚未执行该 v3 在线验收，前述真实 v2 结果不证明 v3 或 MySQL / SQL Server 在线通过。

## 主要代码

项目采用 npm workspaces：前端包 `space.syjx.agent.novel.web`，后端包 `space.syjx.agent.novel.server`。根目录执行 `npm install`，现有 `npm run dev`、`npm run build`、`npm start`、`npm run admin -- ...` 和 `npm run maintenance -- ...` 入口保留。

```text
packages/web/
  src/app/                    应用页面与路由装配
  src/components/             common/auth/administration/platforms 等二级组件目录
  src/hooks/                  chapters/generation/workflow/platforms 二级逻辑目录
  src/services/               浏览器 API 客户端
  src/lib/themes/             主题加载逻辑
  src/styles/                 全局与管理样式
packages/server/
  src/index.ts                服务入口
  src/core/                   应用装配、HTTP、安全数据锁和 tenancy 运行时
  src/features/               auth/administration/projects/assets/chapters/workflow/generation/models/platforms
  src/infrastructure/         database/storage/security 技术基础设施
shared/                       前后端共享协议、类型和校验
public/themes/                可独立扩展的主题资源，保留根目录位置
scripts/                      跨包构建资源复制与验收脚本
```

详细分层见 [前端包说明](packages/web/README.md) 和 [后端包说明](packages/server/README.md)。可单独运行 `npm run typecheck --workspace space.syjx.agent.novel.web` 或 `npm run typecheck --workspace space.syjx.agent.novel.server`。构建继续输出根目录 `dist/`（前端）与 `build/`（后端和共享模块），SQL 资源由构建脚本复制；生产入口为 `build/packages/server/src/index.js`。默认数据仍位于根目录 `data/`，根目录 `.env` 的加载位置不变，与工作区命令的当前目录无关。
