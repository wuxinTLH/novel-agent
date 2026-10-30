# Novel Agent

语言 / Language：[简体中文（默认）](README/README_zhCN.md) · [English](README/README_en.md)

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

生产界面默认是 `http://127.0.0.1:3001`。服务监听本机及局域网接口，仅供可信局域网使用，不要暴露到公网。

两端可独立构建：`npm run build:web` 输出前端，`npm run build:server` 输出后端及 Worker / SQL 资源。`SERVE_WEB` 默认 `true`；设为 `false` 后后端不需要前端产物，也不提供 HTML / 主题 / SPA fallback。保持托管时，`WEB_DIST_DIR` 可指定可信静态构建目录（默认应用根目录的 `dist`，相对路径也以应用根目录解析）。独立静态服务器须将 `/api` 与 `/uploads` 同源反代到同一个后端，不开放跨源业务 CORS，不取消 Cookie / 来源 / CSRF 校验；HTTPS 须显式配置可信 origin。详见[独立部署指南](docs/使用手册.md#前后端独立构建与同源部署)。

如需让本机前端入口使用额外端口，可显式启用安全的回环网关；后端仍只运行一个实例，不会复制租户 Worker 或数据锁：

```powershell
$env:GATEWAY_ENABLED='true'
$env:GATEWAY_PORTS='5173,5174,5175'
$env:GATEWAY_TARGET='http://127.0.0.1:3001'
npm start
```

网关只绑定 `127.0.0.1`，仅允许 HTTP 回环目标，保留请求方法、路径、Cookie、Origin 和响应状态，拒绝 CONNECT/升级隧道并限制请求体、响应体、并发和总时限。已启用的别名端口会显式传入入口和租户 Worker 来源策略，不信任转发头；别名不允许局域网 Host。网关默认请求上限 1 MiB、响应上限 16 MiB、并发 32、总时限 30 秒；采用有界缓冲而非 SSE/WebSocket 代理，不重试写请求。开发模式仍使用 Vite `5173` 与 API `3001`，不要同时占用同一个端口。

这几个端口是同一应用的入口，**不是独立用户或独立数据实例**；同一 host 的 Cookie 跨端口共享。启用认证后，用正常退出/登录切换测试账号，切勿伪造用户头或修改真实数据的认证配置。页面重新获得焦点/恢复可见时会查询服务端身份，发现跨端口登录变化即清除旧会话缓存并刷新；身份未变化时不刷新未保存草稿。临时身份功能回归使用 `npm run smoke:auth`，先执行 `npm run build`。

## 安全加固与容器交付

新增[安全加固与等保四级目标差距](docs/security-hardening.md)（[English](docs/en/security-hardening.md)）：区分应用可实施控制与 OS / 网络 / 国密和 HSM / 集中防篡改审计 / 双人控制 / 测评前置条件，**不声明已达等保四级或通过认证**。共享 HTTP 边界、有界审计链、`SECURITY_PROFILE=hardened` 有限启动检查不改变单实例、非 HA 的边界；默认认证仍关闭。

[Dockerfile](Dockerfile) 与 [Compose](compose.yaml) 提供非 root、只读根、最小能力及独立数据 / 备份卷示例；默认只发布主机回环端口，standard 模式开启审计，不自动启用认证。须先按指南用编译后 CLI 离线引导认证，再配置 HTTPS origin / 独立密钥并开启 hardened。镜像不含 Chromium，不支持默认远程容器首次番茄交互登录。本轮 Compose 静态校验通过，但 Docker Engine 不可用，未实际构建 / 运行镜像；GitHub 预发布不等于生产或合规验收。

## 使用手册

[English documentation index / 英文文档导航](docs/en/README.md)：完整英文指南、模块说明、共享契约与历史报告；不代表界面或外部服务已完成全英文 / 在线验收。

- [完整操作手册](docs/使用手册.md)：安装、正文添加、登录绑定、草稿送审与全自动工作流。新建章节图默认“章节规划 → 正文生成 → 一致性审校”（每章三次模型调用，既有工作流不迁移）；独立图的节点并发上限可设为 1–8（缺省 1），线性图与章节写入保持串行。冲突、反转、高潮与伏笔为按需选择的可选节点，不是每章必跑阶段。
- [番茄平台接入说明](docs/番茄平台接入.md)：能力边界、状态、接口及故障排查。
- [服务模块与用户边界](docs/services.md)：后端模块组织、认证与租户隔离、PostgreSQL 文档快照存储及限制。
- [角色与模块权限](docs/roles-permissions.md)：四种角色、精确权重、运维安全边界与旧账号兼容。
- [SQLconnect 说明](docs/sqlconnect.md)：可选数据库连接、显式建表、凭据保护和部署资源。
- [主题扩展说明](public/themes/README.md)：主题注册表、独立 CSS 与生产部署。
- [更新记录](CHANGELOG.md)：功能变更与验证边界。
- [功能完善验收清单](docs/功能完善验收清单.md)：P1 / P2 / P3 的实现状态与外部验收条件。
- [文件沙箱](docs/文件沙箱.md)：上传准入、内容重构、拒绝策略和隔离边界。
- [平台扩展](docs/平台扩展.md)：MV3 客户端安装、双确认配对和真实平台能力边界。

首次使用番茄登录需要在运行后端的桌面机器操作弹出的 Chromium。纯远程服务器没有可交互桌面时无法完成首次人工登录。

### 页面

- `/workflow`：创作工作流，可新建、切换、整理和运行节点。
- 左侧“创建人物”“创建世界观”会建立独立工作流；“创建小说”用于新建作品或小说工作流。
- `/assets`：设定资料，保存世界观、人物、剧情和章节资料；`/assets/knowledge` 为独立知识事实页，管理人物、关系、时间线、伏笔和事实的标签及章节关联。知识未保存修改在切换编辑、新建及应用内离开 / 切换作品时确认，刷新 / 关闭由浏览器提示；提示不是自动保存或备份。
- 添加节点可切换网格、列表、详细菜单三视图，选择以 `novel-agent.node-picker.view` 保存在当前浏览器同源 localStorage；不可用或值无效时默认网格，不改变工作流图或执行并发。
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

认证及注册、邮箱验证、找回密码、OIDC、MFA 功能默认全部关闭；首次超级管理员仅能停服后本地创建，不提供 HTTP 管理员引导接口。可选公开注册只能创建经邮箱确认的普通用户，不替代管理员引导。预先通过安全方式注入环境变量 `NOVEL_BOOTSTRAP_PASSWORD`（至少 12 个字符、最多 1024 字节），然后执行：

```powershell
npm run admin -- bootstrap-admin --username admin --confirm
```

不要把密码放进命令参数、文档或 Git。创建身份不会开启认证。管理界面提供用户、数据库、备份与维护、系统与安全；认证关闭时仅真实 socket 回环 + 本机 Host / Origin 可管理，写操作还需管理 CSRF，局域网免登录用户不是管理员。首次超级管理员仍仅 CLI 引导；之后可创建 / 启停用户、变更角色、重置密码和撤销会话，保护最后一个有效超级管理员。认证开启后普通用户可在账号安全中改密、查看 / 撤销自己的会话；改密、重置、停用及角色变更撤销相关会话。记录返回的 `ownerId`，再执行 `npm run admin -- enable-auth --owner <UUID> --confirm` 显式将旧数据分配给该身份并启用认证，重启生效。无旧业务数据的新目录才可选 `enable-auth --no-legacy --confirm`；首次登录者不会自动取得旧数据。管理员可管理账号、停用用户及配置默认关闭的 Cloudflare Turnstile；后者需要真实 site key / secret、匹配的 action / hostname 和联网核验，目前不宣称已通过真实 Cloudflare 在线验收。

### 可选完整账号功能

先按上节显式启用认证；创建用户或启用下列功能不会改变认证总开关。登录页按已启用能力显示注册、找回密码、OIDC 与第二因素输入；登录后通过“邮箱与双重验证”管理邮箱和 MFA，“账号安全”继续管理密码与会话。

- 邮件使用可选 nodemailer SMTP 传输：仅 `NOVEL_SMTP_ENABLED=true` 启用，并须安全注入 `NOVEL_SMTP_HOST`、`NOVEL_SMTP_USER`、`NOVEL_SMTP_PASSWORD`、`NOVEL_SMTP_FROM`；`NOVEL_SMTP_PORT` 默认 587，`NOVEL_SMTP_SECURE=true` 时默认 465。不要将真实密码写入文档、命令参数或 Git。TLS 验证不关闭；显式启用却缺少配置会启动失败。
- 管理中心“系统与安全 → 账户功能配置”将注册、邮箱验证、密码恢复和 MFA 分组为开关卡片，并单列可展开的 OIDC 连接与密钥设置；宽屏双列、窄屏单列。管理员另行保存这些开关及邮件回链使用的 HTTPS `publicOrigin`；编辑后须点击“保存配置”，不会自动开启认证。注册始终要求邮件确认；单次邮件令牌 15 分钟过期，完成注册不自动登录，恢复密码撤销会话但不移除 MFA。回链为 `/account/complete#purpose=...&token=...`，不要分享链接或截图。
- OIDC 须显式配置 issuer、clientId、授权 / token / JWKS / 回调 HTTPS 地址，使用 code + PKCE S256、state、nonce、JWKS 签名和精确 issuer / audience 校验。管理员须预先将 issuer + subject 映射到已有用户；不按邮箱自动关联或自动注册，不是任意 OAuth 接入。
- MFA 使用 TOTP，启用时仅展示一次 10 个恢复码；登录必须完成第二因素后才取得业务会话。已用 TOTP counter / 恢复码不能重放，启用或移除 MFA 撤销旧会话；仍有已绑定因素时不能通过全局关闭绕过。

邮件 / OIDC 的 HTTPS 回调须另配 TLS 反向代理及 `NOVEL_TRUSTED_PUBLIC_ORIGIN=https://novel.example.com`（仅示例）：单一 HTTPS origin，无用户信息、路径、查询、片段或通配符。代理须保留浏览器 Host（含非默认端口）、清除不可信转发头，阻止直接外部访问后端；服务不信任 `X-Forwarded-*`，该变量不会让 Node 自行提供 TLS。启用后自动为认证 Cookie 设置 Secure，浏览器须改用该 HTTPS 入口；账号 `publicOrigin` 与 OIDC `redirectUri` 须与之匹配。此配置不放宽免登录本机管理员权限，也不自动开启认证。SMTP、真实 OIDC 提供商及 HTTPS / Cookie 代理部署仍需独立验收，不构成公网生产安全保证。完整配置及接口见 [认证模块说明](packages/server/src/features/auth/README.md)。

### 文稿格式与临时阅读

章节书稿页“文稿格式与阅读”提供 DOCX、EPUB 导出，以及“准备 PDF 打印 → 打印稿件 / 另存为 PDF”。导出按章号使用服务器正式保存的 canonical 章节，不含编辑器未保存内容或未采用候选；已有 Markdown 导出保留。PDF 是浏览器打印，不是服务端 PDF 生成，须检查本机中文字体和分页，不能保证所有阅读器排版一致。

可临时打开单份 ≤ 8 MiB 的 DOCX；旧 `.doc` 须先用 Word / LibreOffice 转为 DOCX。阅读副本仅存服务端内存，30 分钟过期、重启丢失，不自动导入章节或设定，也不上传第三方。每项目最多 10 份、进程最多 64 份 / 64 MiB；ZIP 最多 512 项、实际总解压 ≤ 32 MiB、单项压缩比 ≤ 200:1，验证 5 秒，DOCX 转换 10 秒 / 输出 4 MiB，最多同时处理两份。Word 仅保留清理后的文本结构，不保留图片和活动内容。**PDF 上传目前拒绝**：未提供可靠的 PDF 内容重构能力，不再依靠文件头尾检查放行原始文件；无文本提取 / OCR。PDF 打印导出仍可使用。详见 [文档模块边界](packages/server/src/features/documents/README.md)及[文件沙箱](docs/文件沙箱.md)。

### 界面

- 界面默认简体中文（`zh-CN`），顶栏全局语言切换器（LanguageSwitcher）可切换 English（`en`）；选择以 `novel-locale` 保存在当前浏览器 localStorage。前端翻译资源集中于 `packages/web/src/locals/`。目前仅覆盖账户功能配置、顶栏及部分管理 / 导航文案；创作、平台页面和后端返回消息尚未全面翻译，切换后仍可能显示中文，不代表完整英文界面。
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
- 同一数据目录只允许一个应用实例。v3 数据库 Worker 使用持久连接池；普通操作按 owner 排队，不同 owner 可并发入场，完整快照 / 导入 / 迁移使用独占屏障；持久化仍等待实际 COMMIT，同租户同步等待及认证控制面同步 SQL 仍可能有界阻塞，最多 32 个租户运行时。SQL 行锁 / CAS 不是分布式租约，不支持多实例共享 owner 运行生成 / 发布。
- 平台账号锁现由单实例控制面协调全部租户：按服务端已核验的 provider + 稳定账号身份互斥；身份尚未知的人工登录占用该平台全局锁，阻止与已知账号操作交叠。忙时拒绝，不用 TTL 或 HTTP 断开推断副作用完成；异常失败关闭。它不是跨主机 / 多实例锁，不能阻止官方后台或其他应用操作同一账号。
- 平台登录必须由用户在隔离浏览器中完成，应用不会代填密码或验证码，也不要求粘贴 Cookie、session 或 token。点击核验会自动进入作者首页，读取实时登录身份后保存会话。
- 固定配置 `PLATFORM_SECRETS_KEY` 才能加密跨后端重启保存平台会话；未配置时仅保存在内存。同步网站实际更新的浏览器状态，不臆造双 token 刷新接口；失效或验证码要求仍需重新人工登录。
- 草稿上传、覆盖与送审需要明确操作授权：手动批准，或显式开启自动审批 / 配置全自动工作流。自动审批不关闭账号、正文、版本和幂等校验。删除草稿保留独立确认及只读回查。
- 不提交平台会话、模型密钥、作品数据、公开站点研究缓存或个人截图。自动化测试不是对真实账号送审成功的证明。

### 在线备份任务与离线恢复

管理控制台“备份与维护 → 在线维护任务”可创建全应用备份、按受管备份 ID 校验完整性和生成离线恢复计划。备份先暂停全部租户和控制面新请求，等待已接纳操作排空并关闭全部租户 Worker / 浏览器，持有静默屏障完成快照后再恢复接入；不是只暂停当前用户。无法可靠排空则失败，不降级成活动目录复制。

任务串行执行，默认最多排队 8 项、保留 100 条终态历史、最多 20 个备份 / 未完成产物；容量满需主机管理员安全整理。备份位于数据目录外的受管兄弟目录（默认 `data` 对应 `.data-managed-backups`），包含敏感材料，无浏览器下载 / 任意路径输入；应另行保护 Windows ACL 和外部密钥。界面显示的是阶段进度，不是字节百分比；取消须等当前阶段安全结束，提交阶段不能取消，重启中断不自动重试。完整性校验 / 恢复计划不证明密钥可解密、业务语义正确或目标数据库兼容，也不写入恢复目标。**实际恢复与迁移仍须停服使用 CLI**；没有定时备份、多实例在线协调或跨库原子回滚承诺。

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

### 存储并发基准与在线验证边界

[实际本地模拟报告](scripts/benchmark-storage-report.md) 使用四连接许可、模拟提交延迟和 80 次并发提交，三轮八 owner 的吞吐为约 254–261 ops/s，对照 profile 串行队列约 64–66 ops/s（3.86–4.05 倍）；单 owner 基本不变。**这是 SIMULATED 入场瓶颈实验，不执行真实 SQL / 网络 / 落盘，不是数据库性能提升证明**。可用 `npx tsx scripts/benchmark-storage.ts` 复现；实际数据库锁争用、吞吐和故障恢复仍待在线测量。

新增可选 `npx tsx scripts/test-relational-storage-live.ts` 使用显式安全注入的 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`，且须 `STORAGE_LIVE_ALLOW_CREATE_DATABASE=1`，默认 `STORAGE_LIVE_TLS=verify`。需 CREATEDB 权限，创建 / 验收 / 删除本次唯一的两个临时数据库，不删除已有用户库、不强制断开其他会话；未执行真实在线验收。原 v2 / v3 验收入口保留，所有模拟结果不替代真实 PostgreSQL / MySQL / SQL Server 验收。

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
