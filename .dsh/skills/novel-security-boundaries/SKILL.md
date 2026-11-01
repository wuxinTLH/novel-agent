---
name: novel-security-boundaries
description: 审查或修改 Novel Agent 认证、权限、CSRF、租户隔离、文件解析、模型凭据及平台发布时，保持失败关闭和远端副作用边界。
---
# 安全与租户边界

所有路径相对仓库根目录。先读相关实现和测试，并按领域读取：
- `docs/deployment-modes.md`、`docs/security-hardening.md`、`docs/roles-permissions.md`、`docs/services.md`。
- `packages/server/src/features/auth/README.md`、`packages/server/src/core/tenancy/README.md`、`packages/server/src/infrastructure/security/README.md`。
- 文件/平台任务另读 `docs/文件沙箱.md`、`docs/平台扩展.md`、对应 feature README。

## 必须维持的不变量

- local 默认回环/免登录，server 强制已启用认证、hardened/审计及同源真实 HTTPS 代理；非法 CoreModel 失败启动。不得为了测试改真实配置或放宽 CORS/Host/Origin/CSRF。
- 身份仅来自服务端验证会话；不接受用户头、查询或客户端 owner。业务、管理、认证 CSRF 各有职责，新增路由通过统一 HTTP 边界，拒绝路径大小写绕过。
- 租户 Worker 固定 owner，数据、密钥、上传、浏览器与队列隔离；容量耗尽/未认证失败关闭，不退回共享目录。管理员权限不等于读取其他租户内容。
- 修改认证时核对会话撤销、refresh 轮换与重放、第二因素、限频、过期边界和统一错误；短信/SMTP/OIDC/Turnstile 使用桩，不自动发真实请求或记录秘密。
- 不返回明文密钥、Cookie 或 token；API 配置只暴露掩码/存在标记。不能用关闭 TLS 校验、降低密码策略或伪造身份来使回归变绿。
- 文件准入校验实际大小、类型、解析资源上限、路径/链接与清理结果；PDF 上传当前拒绝，不凭头尾签名重新放行。导出只读取正式 canonical 内容。
- 平台上传/送审是外部写入；保留批准、账号/作品绑定与幂等。未知结果只读核对，不自动重试；本地“成功”不能冒充远端“已发布”。

## 审查与验证

1. 列出输入、信任边界、授权主体与副作用，再写最小改动。
2. 对相同路径覆盖未登录、错误身份、跨租户、权限不足、错误 CSRF/Origin、超限及正常请求；认证变更增加撤销/重放/并发负例。
3. 用 glob 查找受影响目录 `.test.ts`，执行 `node --import tsx --test <明确路径>`，再 `npm run typecheck`；跨边界变更运行 `npm test`。
4. 涉及真实 HTTP/浏览器时先读 `scripts/smoke-auth.mjs` 与 `scripts/smoke-core-model.mjs`，构建后使用临时数据运行；不得改现有 data/auth 或停用户服务。
5. 检查 diff 和测试产物不含秘密，报告 mock、在线验证与生产部署的不同边界；不声称通过等保或消除了全部漏洞。
