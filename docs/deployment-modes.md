# CoreModel：本机与服务端部署

[English](en/deployment-modes.md) · [项目说明](../README.md) · [安全加固与差距](security-hardening.md)

## 模式与启动契约

环境变量名精确为 `CoreModel`（不是模型提供商配置）。只接受字面量 `local` / `server`；未设置时默认 `local`，其他显式值（包括空值、大小写变体）启动失败。

| 项目 | `local` | `server` |
| --- | --- | --- |
| Node HTTP 监听 | 仅 `127.0.0.1` | `0.0.0.0` |
| 访问方式 | 仅本机；不能通过局域网直接访问 | 仅通过受控的同源真实 HTTPS 反向代理；防火墙阻断后端直连 |
| 认证 | 可选，默认关闭 | 必须先离线启用，未启用则启动失败 |
| 安全策略 | 默认 `standard`，可显式选择 `hardened` | 强制 `hardened`，显式 `SECURITY_PROFILE=standard` 拒绝启动 |
| 审计 | standard 默认关闭，可显式开启 | 强制开启，显式 `SECURITY_AUDIT=false` 拒绝启动 |
| 本机网关 | 默认关闭，可显式开启回环别名 | 必须关闭 |

`SECURITY_PROFILE` 仅接受 `standard` / `hardened`，`SECURITY_AUDIT` 仅接受 `true` / `false`；非法显式值拒绝启动。local 下显式 hardened 仍要求严格启动条件并强制审计；server 不允许用关闭认证、standard 或关闭审计绕过。

local 的可信 HTTPS origin 只允许回环主机 `localhost` / `127.0.0.1` / `[::1]`，远程或 LAN origin 拒绝启动；仍须满足精确 HTTPS origin 校验。local hardened 可使用真实回环 HTTPS 代理。该限制不声称阻止主机管理员自行建立外部隧道。

## 原生本机运行

```powershell
$env:CoreModel='local'
npm start
```

使用 `http://127.0.0.1:3001`。本机免登录不授予远端管理权限；现有 Host / Origin / Cookie / CSRF 校验仍保留。额外回环网关只适用于 local，不能用于 LAN 访问，也不创建独立数据实例。建议桌面用户使用原生 local，尤其需要交互式 Chromium 首次平台登录时。

## 服务端：先离线引导，再启动

1. 停止服务并保护数据、数据库及外部密钥；CLI 也持有数据目录锁。
2. 在 CLI 进程显式设置 `$env:CoreModel='server'`（CLI 不自动加载 `.env`），安全注入 `NOVEL_BOOTSTRAP_PASSWORD`，离线执行 `npm run admin -- bootstrap-admin --username admin --phone <E164_PHONE> --data-dir <DATA_DIRECTORY> --confirm`。现有未绑定用户需停服后用 `npm run admin -- set-phone --username <USERNAME> --phone <E164_PHONE> --data-dir <DATA_DIRECTORY> --confirm` 离线迁移；该操作撤销其既有会话。号码须符合 `+` 加国家码的 E.164 形式；备份包含敏感手机号。
3. 记录返回的 owner UUID，再执行 `npm run admin -- enable-auth --owner <RETURNED_OWNER_UUID> --data-dir <DATA_DIRECTORY> --confirm`。只有全新空数据目录才可使用 `--no-legacy`；创建账号本身不会开启认证。
4. 配置 `CoreModel=server`、精确 HTTPS `NOVEL_TRUSTED_PUBLIC_ORIGIN`、两个独立且各至少 32 字符的高熵 `MODEL_SECRETS_KEY` / `PLATFORM_SECRETS_KEY`，保持 `GATEWAY_ENABLED=false`。**启动前必须配置短信提供商** `NOVEL_SMS_PROVIDER=aliyun` 或 `tencent` 及该提供商的全部凭据、已批准签名 / 模板；未配置 / 无效配置拒绝启动，不向真实供应商发送启动探测短信。变量清单及认证流程见[认证模块契约](../packages/server/src/features/auth/README.md#sms-provider-and-turnstile-server-mode)。可显式设置 `SECURITY_PROFILE=hardened` / `SECURITY_AUDIT=true`，但不能设置反向值。
5. 部署真实 TLS 反向代理，保留浏览器 Host（含非默认端口）、Origin、Cookie 和 CSRF；清除不可信转发头，只允许代理到后端。Node 自身不提供 TLS，也不信任 `X-Forwarded-*`；仅填写 HTTPS origin 不会安装证书或启用认证。独立 Web 入口必须同源代理 `/api` 与 `/uploads`，不开放跨源业务 CORS。
6. 启动并在实际 HTTPS 入口验证匿名拒绝、角色 / 租户隔离、CSRF、Secure Cookie、审计及后端不可直连。

HTTPS origin 必须是单一精确来源，无用户信息、非根路径、query、fragment 或通配符；账号邮件 `publicOrigin` 与 OIDC 回调必须相应同源。长度检查不是密钥熵证明。

### server 账号策略

server 对新设密码要求至少 15 个 Unicode 字符、最多 1024 字节，拒绝有限常见密码清单、低字符多样性及账号名衍生密码；改密 / 重置 / 恢复不能重用当前密码。**每次密码登录均须验证绑定手机短信验证码**，未绑定 / 未验证手机号拒绝登录，不以邮件或可选 TOTP 绕过；已启用的 TOTP 仍需额外完成。自助注册先验证手机号，后确认邮箱，才创建已绑定账号。配置 Turnstile 时，登录、注册及发放注册 / 登录 / 绑定短信均须完成服务端校验，挑战令牌不可跨请求重复使用。v0.0.4a 服务端 access 有效期 60 分钟、轮换 refresh 7 天、持久化空闲上限 30 天；**离线 8 天后已过 refresh 有效期，不能宣称离线 30 天免登录**。客户端会在会话恢复和符合条件的失败读取上尝试刷新；不自动重放可能已提交的写操作。最多 5 个有效浏览器会话族。local 保留既有密码与会话策略；相关行为仍以[认证模块契约](../packages/server/src/features/auth/README.md)及完成后的回归 / 真实服务验收为准。

## 站点外观、升级与备份

Header / Footer 分离和管理员站点外观不改变部署模式、同源或认证边界。`GET /api/site-appearance` 仅公开非秘密样式；管理读写需 `appearance.manage`（admin/superadmin），写入仍校验 CSRF。配置是 `DATA_DIR/site-appearance.json` 全局控制面文件，即使 SQL 业务存储也不能只备份数据库。保留整个安全数据树、已创建的外观文件及独立外部密钥；在线备份须全局静默，恢复 / 替换部署前按既有停服规程操作。容器内对应持久数据卷的 `/app/data/site-appearance.json`，不应烘焙进镜像或作为静态资源。恢复后检查颜色对比、默认空公司名与固定作者链接。见[站点外观](site-appearance.md)与[全量备份恢复](使用手册.md#全量应用备份与恢复)。

## Docker 与 Compose

[Dockerfile](../Dockerfile) 的构建参数默认 `ARG CoreModel=server`，构建只接受 local/server；镜像通过 `ENV CoreModel` 保留所选默认值。运行时可覆盖，但启动仍重新校验。例：`docker build --build-arg CoreModel=local -t novel-agent:local .` 只改变镜像默认模式，**不让本机模式可通过端口映射访问**。

[Compose](../compose.yaml) 的 build arg 与运行时环境均使用 `${CoreModel:-server}`，因此 Compose 默认为 server，不是原生运行的默认 local。server 必须在首次服务启动前完成离线 CLI 引导与 HTTPS / 密钥配置；首次直接 `docker compose up` 不能代替引导。编译后 CLI 命令、非 root / 只读根与权限要求见[安全指南](security-hardening.md#本机-docker-操作与离线引导)。使用独立命名数据卷和备份卷，不能删除唯一副本。

**容器 local 仅监听容器内部 `127.0.0.1`。宿主机发布端口不能访问该监听地址；不要把 `CoreModel=local` 加端口映射宣传为可用的本机 Docker 方案。** 建议本机用户原生 local；需要容器外浏览器入口时使用符合全部前置条件的 server 与真实 HTTPS 代理。

当前实现环境缺少可用 Docker Engine，未实际构建镜像或运行容器；配置静态检查不代表目标宿主机验收。镜像不含 Chromium。模式检查、HTTP 防护和本地有界审计不是 OS 内核防护增强、不可篡改集中审计、认证或公网生产安全保证；单实例、非 HA 及外部服务独立验收边界保持不变。当前维护的预发布仍为 `v0.0.5a`（package SemVer `0.0.5-a`），不另增版本号。本次同标签 / 资产替换经明确授权；旧下载和校验值不代表替换后的资产，请重新下载并以[发布说明](../RELEASE_NOTES.md)与[当前发布验证](release-validation-v0.0.5a.md)为准，历史报告不作为当前验收。
