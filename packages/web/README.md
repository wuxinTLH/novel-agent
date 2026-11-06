# Web 前端

中文 | [English](README_en.md)

npm workspace 包名：`space.syjx.agent.novel.web`。本包负责 React 界面、浏览器交互和主题加载；服务端实现位于另一个 workspace，不直接由前端导入。

## 源码分层

- [入口](src/main.tsx)：挂载 React、确认对话框提供者、认证入口及全局样式。
- [app](src/app/App.tsx)：应用组合与页面导航；现有工作流、章节和设置界面的内联实现暂保持完整，避免目录迁移同时改变业务。
- `components/` 按功能设置第二级目录：
  - `common`：通用弹窗、确认对话框与错误提示。
  - `auth`：登录入口和账号安全。
  - `administration`：管理控制台。
  - `workflow`：工作流节点相关交互。
  - `generation`：生成配置、候选正文与进度。
  - `chapters`：手动章节录入。
  - `platforms`：平台绑定与发布批次。
  - `settings`：模型和数据库连接设置。
  - `projects`：小说项目设置。
- `hooks/` 按 `generation`、`chapters`、`workflow`、`platforms` 分组；除 React hooks，也保留对应领域的纯函数与就近测试。
- [services](src/services/api.ts)：同源 API 请求、会话令牌与错误处理。
- [lib/themes](src/lib/themes/themes-load.ts)：主题注册表校验和并发安全的主题加载。
- [locals](src/locals/README.md)：渐进式中英文支持，不代表全应用已翻译。语言选择器使用主题化自定义按钮及单选菜单，而非原生 select；提供键盘导航、Escape 关闭及焦点恢复。
- [styles](src/styles/styles.scss)：全局 Sass；[管理样式](src/styles/administration.scss)由管理控制台和账号安全共同使用。

## 有意保留的根目录边界

- [公共资源](../../public/themes/README.md)仍在仓库根目录 `public/`，由本包的 [Vite 配置](vite.config.ts)通过 `publicDir` 引用。主题仍通过 `/themes/` 提供，图标仍为 `/favicon.svg`，无需改变部署 URL。
- [shared](../../shared/types.ts)暂留仓库根目录，作为前后端共享的类型与校验逻辑；前端通过相对路径引用，不复制定义。
- 构建产物仍输出到仓库根目录 `dist/`，与服务端静态资源服务保持兼容；并非本包内的独立 `dist/`。
- 开发代理保留 `/api`、`/uploads`，目标为 `http://127.0.0.1:3001`。源码目录调整不改变浏览器路由或 API URL。

## 页面与浏览器偏好

- `/assets/knowledge` 独立承载知识事实编辑，保留类型 / 搜索、标签 / 章节关联、修订冲突与原 API 边界。未保存知识编辑在替换条目、新建、应用内离开 / 切换作品时确认放弃；刷新 / 关闭使用浏览器警告，不等于自动保存。
- 添加节点有网格、列表、详细菜单三视图，`novel-agent.node-picker.view` 以同源 localStorage 记忆；读取失败 / 非法值默认为网格，存储失败不阻止当前切换。与工作流图布局 / 执行并发无关。
- 根 `npm run build:web` 等价于独立前端构建。可将完整 `dist/` 部署到独立静态服务器（含主题及前端路由 fallback），后端设置 `SERVE_WEB=false`；浏览器 `/api`、`/uploads` 必须同源反代，不能将 API 错误回退成 HTML，不新增跨源业务 CORS 或绕过 CSRF。默认仍后端托管；`WEB_DIST_DIR` 可改变其可信构建目录。见[部署指南](../../docs/使用手册.md#前后端独立构建与同源部署)。

### v0.0.4a 创作与界面更新

- **世界观阶段**：在设定资料页创建、重命名和筛选阶段；世界观文字、上传资料及地图图片可归入阶段，也可改回“未分组”。旧资料默认未分组，不自动迁移。阶段是资料整理方式，不自动限制生成引用；节点关联设定留空仍使用全部设定，需限定引用时显式选择资料。仅空阶段可删除，先移动或删除其资料。
- **章节分页与批量删除**：每页可选 20 / 50 / 100 章。批量模式默认关闭，点击独立按钮才开启，切换作品或卸载页面重置。全选仅选择当前页；已勾选条目可跨页保留，并显示已选总数，不隐式全选整个作品。确认前检查所选章及固定修订号；所选章含当前或缓存的未保存草稿时，须先保存或放弃。服务端原子检查权限、运行状态及全部章节修订，任何失效项使整批失败，不部分删除。每批最多 500 章；删除本地正式章节（含其随章历史）并失效相关工作流输出，保留历史章号水位，后续章节不重排、不自动补用已删章号。不删除远端平台正文，也不撤回已发送请求。
- **界面位置与工作流类型**：本机模式 / 账户状态移至侧栏标志下，管理控制台入口位于“使用指南”下并保留权限判断；顶栏语言切换在主题按钮左侧。小说、人物、世界观页面的创建按钮与弹窗按当前家族显示“创建小说流 / 创建人物流 / 创建世界观流”，保留相应模板和已选同类工作流。通用弹窗加入打开、关闭及尺寸变化动效，遵循减少动态效果偏好，不取代焦点管理、忙碌保护或未保存确认。

## 命令

在仓库根目录执行，依赖统一由根目录 npm 安装：

```bash
npm run dev --workspace space.syjx.agent.novel.web
npm run build --workspace space.syjx.agent.novel.web
npm run typecheck --workspace space.syjx.agent.novel.web
```

`dev` 仅启动前端（默认端口 5173），需要另行启动服务端。`build` 先执行前端类型检查再构建静态资源；不会构建服务端。整仓测试和联调使用根目录提供的脚本。
