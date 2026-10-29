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

## 命令

在仓库根目录执行，依赖统一由根目录 npm 安装：

```bash
npm run dev --workspace space.syjx.agent.novel.web
npm run build --workspace space.syjx.agent.novel.web
npm run typecheck --workspace space.syjx.agent.novel.web
```

`dev` 仅启动前端（默认端口 5173），需要另行启动服务端。`build` 先执行前端类型检查再构建静态资源；不会构建服务端。整仓测试和联调使用根目录提供的脚本。
