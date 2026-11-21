# CoreModel：本机与服务端部署

[English](en/deployment-modes.md) · [项目说明](../README.md) · [安全加固与差距](security-hardening.md)

## 模式与启动契约

环境变量名精确为 `CoreModel`（不是模型提供商配置）。只接受字面量 `local` / `server`；未设置时默认 `local`，其他显式值（包括空值、大小写变体）启动失败。

| 项目 | `local` | `server` |
| --- | --- | --- |
| Node HTTP 监听 | 仅 `127.0.0.1` | `0.0.0.0` |
| 访问方式 | 仅本机；不能通过局域网直接访问 | 仅通过受控的同源真实 HTTPS 反向代理；防火墙阻断后端直连 |
| 认证 | 可选，默认关闭 | 业务运行必须已启用；仅全新目录可进入隔离 Init |
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


## 核心进程守护

生产 `npm start` 与 Docker 入口通过独立 Node.js 守护进程启动核心，开发热更新不使用守护。核心完成 HTTP 和可选网关启动后才报告就绪；启动前配置、认证、锁或端口错误不会自动循环重启，启动等待上限 60 秒。就绪后的非预期退出采用 1、2、4、8、16 秒退避，滚动 5 分钟最多重启 5 次，预算耗尽即退出并等待人工检查。正常关闭、SIGINT / SIGTERM 和父进程断连不会触发重启；关闭先通过私有 IPC 请求核心清理，核心清理上限 20 秒，守护 25 秒后才强制终止。

自动崩溃重启仅在 Linux / POSIX 启用，以独立进程组清理旧核心及其后代。Windows 当前没有原生 Job Object 约束，无法证明崩溃后代已完全退出，因此非预期退出失败关闭、等待人工检查，不自动拉起；正常关闭仍使用 IPC。

守护不会删除数据锁、清空维护日志、重放模型请求或平台写入，也不是健康探针、操作系统服务或高可用方案。未知生成/发布结果仍须人工核对；核心退出并清理其子进程后才允许启动替代实例。容器保留 init 和 30 秒停止宽限，Compose 使用 `restart: "no"`，防止外层无限重启绕过内部预算。部署为系统服务时同样不要配置无上限的外层重启。故障后先检查退出信息、数据锁与维护恢复状态，再人工启动；不得直接删除锁文件。

## 初始化临时测试页面

在正常 Web 服务或前端开发服务打开 `/init-test`（例如 `http://127.0.0.1:3001/init-test`）。该页使用虚构配置和页面内存模拟，供测试读取配置、缺失项校验与完成提示；不调用真实初始化 API、不读取 Docker 环境、不保存配置或创建管理员。请只填写测试数据。可重置再测，刷新会丢弃所有测试状态；模拟成功无需重启服务。全新 Server 的受限 Init 服务不会开放该测试路由，请使用正常 Web / 开发入口；真实初始化仍访问 `/init`。

## Server Core 首次启动 Init

全新 `CoreModel=server` 数据目录可先进入独立 Init 页面：只提供初始化页面与受保护的配置接口，不加载业务、租户或普通管理 API。已有数据目录不重新引导；认证或存储配置损坏仍须停服检查，不能用向导接管已有实例。local 模式不显示此页面。

- 页面自动识别当前进程环境，包括 Compose 注入的 HTTPS origin、模型 / 平台加密密钥及短信提供商配置；不访问 Docker socket，也不读取宿主机任意文件。非秘密值预填，秘密仅显示“已配置”，未配置项留空并提示添加。非空环境配置优先于向导保存值。
- 操作者必须持有 `NOVEL_INIT_TOKEN`（至少 32 字符）或从受控数据卷中的 `.init-token` 读取自动生成令牌。令牌不打印到日志，不进入 URL 或浏览器持久存储；保护数据卷与主机权限。Compose 可通过同名环境变量注入令牌，不要提交真实令牌。
- 未配置 HTTPS origin 时，仅通过受控宿主回环地址 / 隧道访问 Init；不要开放后端端口到公网。配置 origin 时保留精确 Host / Origin，并通过真实 HTTPS 代理访问。初始化页面不能安装证书，也不使 HTTP 业务安全可用。
- 补齐精确 HTTPS origin、两个独立且各至少 32 字符的高熵密钥、所选短信提供商的完整配置，以及首个超级管理员的用户名、手机号和强密码。手机号选择区号后只输入本地号码：`+86` 为中国大陆 11 位手机号，`+1` 为符合 NANP 规则的 10 位号码；提交时组合成 E.164，当前 Init 不声称支持所有国家地区。配置检测不会发送真实短信。
- 数据库步骤显式选择本地 JSON（立即作为默认业务存储）或 SQL 连接配置（MySQL / PostgreSQL / SQL Server）。SQL 选择仅离线保存待用连接配置：**不会连接数据库、建表、迁移或启用 SQL 业务存储**，重启后仍为 JSON。后续须由管理员停服、备份并单独确认离线初始化与激活；数据库应提前创建，不要把保存配置当作初始化成功。`/init-test` 中数据库选择也仅在内存模拟，不连接真实数据库。
- 完成后保留初始化配置与认证数据，界面要求人工重启（Compose：`docker compose restart`）；不会自动登录、开放业务或无限重启。重启仍执行原有 hardened / 审计、HTTPS、认证与短信配置检查。初始化配置含秘密，必须随数据卷保护与备份，不能作为静态资源。

数据库环境变量仅用于首次 Init 快照：`NOVEL_INIT_DB_MODE`（`local-json` / `sql-later`）、`NOVEL_INIT_DB_DRIVER`、`NOVEL_INIT_DB_HOST`、`NOVEL_INIT_DB_PORT`、`NOVEL_INIT_DB_DATABASE`、`NOVEL_INIT_DB_USER`、`NOVEL_INIT_DB_PASSWORD`、`NOVEL_INIT_DB_TLS`（默认 `verify`）、`NOVEL_INIT_DB_TIMEOUT_MS`。非空环境字段优先并锁定，密码仅显示已配置；缺失字段仍可填写。SQL 连接在受保护的 `storage-profiles.json` 中保存为 v3 待用 profile，不产生启用标记；初始化完成后不根据这些变量自动覆盖运行期数据库设置。TLS 关闭仅允许明确回环主机。离线初始化/激活步骤见[数据库说明](sqlconnect.md#v3-storage-profiles)，不得删除 journal 或手写激活标记绕过核验。

首次容器启动可按以下顺序操作（仅受控宿主机终端；令牌输出不得复制到工单或日志）：

```bash
docker compose up -d --build
# 未注入 NOVEL_INIT_TOKEN 时，在受控终端读取生成令牌：
docker compose exec novel-agent node -e "process.stdout.write(require('node:fs').readFileSync('/app/data/.init-token', 'utf8'))"
# 浏览器打开默认回环入口 http://127.0.0.1:3001/init，完成配置后：
docker compose restart
```

若预先配置了可信 HTTPS origin，须改用对应真实 HTTPS 代理入口；HTTP 回环入口不再匹配。如果使用非默认端口，须保持访问 Host 端口与服务监听端口一致，或使用配置好的精确 HTTPS 代理来源。

## 服务端：已有数据或离线引导，再启动

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

[Compose](../compose.yaml) 的 build arg 与运行时环境均使用 `${CoreModel:-server}`，因此 Compose 默认为 server，不是原生运行的默认 local。全新 server 数据卷首次 `docker compose up` 可进入隔离 Init；必须完成持有者令牌验证和配置、人工重启后才启用正常业务。已有数据继续使用离线 CLI，不自动认领或迁移。编译后 CLI 命令、非 root / 只读根与权限要求见[安全指南](security-hardening.md#本机-docker-操作与离线引导)。使用独立命名数据卷和备份卷，不能删除唯一副本。

**容器 local 仅监听容器内部 `127.0.0.1`。宿主机发布端口不能访问该监听地址；不要把 `CoreModel=local` 加端口映射宣传为可用的本机 Docker 方案。** 建议本机用户原生 local；需要容器外浏览器入口时使用符合全部前置条件的 server 与真实 HTTPS 代理。

当前实现环境缺少可用 Docker Engine，未实际构建镜像或运行容器；配置静态检查不代表目标宿主机验收。镜像不含 Chromium。模式检查、HTTP 防护和本地有界审计不是 OS 内核防护增强、不可篡改集中审计、认证或公网生产安全保证；单实例、非 HA 及外部服务独立验收边界保持不变。当前维护的预发布仍为 `v0.0.5a`（package SemVer `0.0.5-a`），不另增版本号。本次同标签 / 资产替换经明确授权；旧下载和校验值不代表替换后的资产，请重新下载并以[更新记录](../CHANGELOG.md) / [GitHub Releases](https://github.com/wuxinTLH/novel-agent/releases)与[当前发布验证](release-validation-v0.0.5a.md)为准，历史报告不作为当前验收。
