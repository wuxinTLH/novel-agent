# Header / Footer 与站点外观

[English](en/site-appearance.md) · [权限](roles-permissions.md) · [MIT 许可证](../LICENSE) · [中文译文](../LICENSE.zh-CN.md)

应用顶栏与全局页脚分别由 `NavigationHeader` 和 `NavigationFooter` 组件负责。顶栏保留面包屑、语言、主题及原有操作；全局页脚不同于工作流页内的操作栏。

## 管理配置

管理员面板的站点外观功能仅向超级管理员、管理员开放，对应显式权限 `appearance.manage`。运维管理员和作家不因角色权重或前端按钮可见性获得写权限。原有认证、真实回环来源和 CSRF 校验继续有效。

Header、Footer 可分别配置背景色、文字色、强调色、边框色、字号与上下内边距。颜色留空继承主题，否则仅接受 `#RRGGBB`；字号为 12–24 px，上下内边距为 0–32 px。不接受任意 CSS、HTML、脚本、URL 或字体资源。不同颜色的可读性仍需管理员预览确认。

公司名称默认为空，不显示公司版权行；填写后只作为纯文本显示。无论是否填写公司名称，Footer 始终保留固定的 `© SakuraMikku`，链接为 <https://github.com/wuxinTLH/novel-agent>，使用 `target="_blank"` 和 `rel="noopener noreferrer"`。该固定作者归属不是可配置字段。管理员应避免选择使其与背景无法区分的颜色；这不是对主机管理员修改源代码的技术限制。

## 使用步骤

1. 打开管理控制台 → 站点外观。认证开启时须使用管理员或超级管理员；运维管理员与作家没有该配置入口。
2. 分别编辑页眉、页脚并检查预览。颜色可留空或点击“继承主题”；公司名称可留空，填写后最多 120 个字符，按纯文本显示并去除首尾空白。
3. 点击“保存外观”才提交并更新当前页面的全局导航。“重置外观”仅恢复编辑草稿，仍需保存；“重新载入外观”会在有未保存编辑时请求确认。
4. 出现 409 冲突时先保留需要的编辑，再重新载入并人工合并，不自动覆盖或重放写请求。会话切换或过期后关闭并重新打开管理控制台。

主题选择是浏览器本地偏好；站点外观是应用全局配置。显式导航颜色会覆盖相应主题颜色，留空才随主题变化。检查浅色、深色与窄屏可读性，尤其不可遮蔽固定作者链接。

## API 与持久化

- `GET /api/site-appearance`：公开、同源读取站点外观；不含身份、租户或秘密。公开读取不使其它业务接口变为匿名接口。
- `GET /api/admin/site-appearance`：管理员读取。
- `PUT /api/admin/site-appearance`：完整、严格请求 `{ expectedRevision, companyName, header, footer }`。成功返回直接的 `SiteAppearance`，不是 envelope。

读取与成功写入均为 `Cache-Control: no-store`。无效请求返回 400 `SITE_APPEARANCE_INVALID`；修订冲突为 409 `SITE_APPEARANCE_CONFLICT`；存储不可用为 503 `SITE_APPEARANCE_UNAVAILABLE`。管理员接口读写都要求 `appearance.manage`，写入仍须现有管理/会话 CSRF 凭据；公开端点只允许 GET/HEAD，不公开写入或子路径。

`header`、`footer` 均包含 `backgroundColor`、`textColor`、`accentColor`、`borderColor`、`fontSize`、`paddingY`。默认版本为 1、修订为 0；默认公司名称与颜色为空、字号 14、内边距 16。修订冲突返回 409，应重新读取并人工核对，不自动覆盖其它管理员的变更或自动重放写请求。

配置为应用全局控制面数据，保存在 `DATA_DIR/site-appearance.json`，不是每个作品或租户的配置，也不是 SQL 业务文档回退。单实例下采用临时文件、同步落盘与重命名提交；写入失败保留既有配置。配置损坏时返回错误，不静默当成默认配置。备份和恢复必须同时保留该控制面文件；部署时仍应遵守项目全应用备份与停服恢复规则。

## 许可证

英文 [LICENSE](../LICENSE) 为 MIT 许可证原文，版权标注 `2026-2099 SakuraMikku`；[中文版本](../LICENSE.zh-CN.md)为参考译文，发生歧义以英文原文为准。年份范围不承诺未来维护或服务期限，第三方依赖保持各自许可证。
