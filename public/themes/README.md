# 主题资源

主题注册表通过 `/themes/themes.json` 提供；本目录中的 CSS 是直接发布的静态资源，不需要修改应用组件或重新编译 Sass 才能新增配色。

## 注册表结构（version 1）

```json
{
  "version": 1,
  "defaultTheme": "theme-system",
  "themes": [
    { "id": "theme-system", "name": "跟随系统", "css": "theme-system.css" },
    { "id": "theme-light", "name": "极简白", "css": "theme-light.css" },
    { "id": "theme-dark", "name": "极简黑", "css": "theme-dark.css" },
    { "id": "theme-mtf", "name": "蓝粉白", "css": "theme-mtf.css" }
  ]
}
```

- `version`：注册表格式版本，当前为数字 `1`。
- `defaultTheme`：默认主题 ID，必须对应 `themes` 中的一个条目。
- `themes`：按菜单展示顺序排列的主题条目；必须至少 1 项、最多 100 项。任一条目不合法会拒绝整份注册表。
- `id`：唯一且稳定的 `theme-xxx` 标识，也是根元素 `data-theme` 的完整值。
- `name`：菜单展示名称，可以使用中文；原始长度最多 80 个字符，去除首尾空白后不可为空。当前四项名称为跟随系统、极简白、极简黑、蓝粉白。
- `css`：本目录中的 CSS 文件名，不是任意 URL 或路径；命名须匹配 `^theme-[a-z0-9]+(?:-[a-z0-9]+)*\.css$`。

## 新增主题

1. 在本目录新增一个独立 CSS 文件，例如 `theme-ocean.css`。
2. 使用 `:root[data-theme='theme-ocean']` 定义完整语义变量。可参考现有配色，包含 `color-scheme`、背景、正文、面板、表面、边框、次级文字、强调色、焦点、遮罩等变量；`--muted` 是 `--muted-text` 的别名。
3. 所有组件特例同样放在主题作用域下，例如 `:root[data-theme='theme-ocean'] select`。不要添加无条件的 `:root`、`body` 或组件规则，以免已加载资源在切换后污染其他主题。
4. 向 `themes.json` 的 `themes` 追加 `{ "id": "theme-ocean", "name": "海洋蓝", "css": "theme-ocean.css" }`。需要时将 `defaultTheme` 改为该 ID。
5. 在主题菜单点击“重新加载主题”，新条目按注册顺序显示；验证显式浅色/深色、系统明暗切换及切换后无残留。切换失败保留当前主题，首次加载失败使用主样式浅色兜底。

开发环境直接读取本目录；生产构建会复制到 `dist/themes`。生产部署可更新已部署的该目录后点击“重新加载主题”；只修改源码目录时仍需构建并部署，不能自动改变已有部署。

`packages/web/src/lib/themes/themes-load.ts` 提供 `themesLoad`、注册表校验与并发安全的样式切换。旧保存值 `system/light/dark/mtf` 自动迁移为对应 `theme-xxx`；已移除或未知的主题选择回退到 `defaultTheme`。非法注册表不会覆盖当前列表和外观。CSS 属于可信本地资源，不应注册未经审查的第三方样式。

## 内置资源与作用域

- `theme-light.css` 包含极简白配色，并为 `theme-system` 提供浅色基础值。
- `theme-dark.css` 包含极简黑配色、深色下拉箭头和菜单特例。只有 `@media (prefers-color-scheme: dark)` 内的 `theme-system` 规则跟随系统；显式 `theme-dark` 不受系统偏好影响。
- `theme-system.css` 按顺序本地 `@import` 浅色和深色资源，避免重复维护系统配色；所有导入内容仍受完整主题 ID 约束，系统偏好变化由 CSS 实时响应。
- `theme-mtf.css` 保留蓝粉白的背景/面板渐变和主题菜单选中项渐变。
- 应用主样式仅保留浅色语义变量兜底和通用布局/交互样式。资源中完整声明变量，主题选择器比无条件根元素兜底优先，不依赖链接与应用样式的插入先后顺序。

共享资源可以通过本地 `@import` 复用，但必须保留各完整主题 ID 的选择器隔离；不要使用旧的 `light`、`dark`、`system`、`mtf` 作为 `data-theme` 值。
