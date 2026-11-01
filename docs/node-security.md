# Node.js 安全基线

## 修复范围

本次将受支持范围收紧为 `^22.23.4 || ^24.22.2`，推荐开发运行时为 **24.22.2**，Docker 构建及运行阶段固定为 `node:22.23.4-bookworm-slim`。这不是永远安全的版本承诺：后续必须继续跟踪官方安全公告，在流水线核验镜像标签、摘要与实际 `node --version`。

依据官方 [October security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)、[22.23.4](https://nodejs.org/en/blog/release/v22.23.4)、[24.22.1](https://nodejs.org/en/blog/release/v24.22.1) 和 [24.22.2](https://nodejs.org/en/blog/release/v24.22.2)。公告安全修复起点为 22.23.4 / 24.22.1；项目对 24.x 采用后续补丁 24.22.2。

公告涉及 DNS NUL 截断（CVE-2026-105482）、TLS 非规范 IP 校验（CVE-2026-106069、CVE-2026-106072）、Brotli 越界写（CVE-2026-111497）、HTTP keep-alive 响应混淆（CVE-2026-105481）、自定义快照随机缓存（CVE-2026-106074）和 Permission Model 绕过（CVE-2026-106073）。24/26 分支还修复全角数字 TLS 回归（CVE-2026-105483）；不能仅凭主版本断言旧 24.11.1 包含该回归。具体可利用性取决于平台、引入补丁和应用使用路径，不能以未直接调用 API 为由代替升级。

## 项目保护

- 根包 `engines`、锁文件及共享运行时策略保持一致；`.node-version` / `.nvmrc` 提供版本管理器默认值。
- 服务入口在读取环境文件、获取数据锁和创建业务数据前检查运行时，不支持的版本抛出 `NODE_RUNTIME_UNSUPPORTED`。这不替代升级 Node 本身，也不把应用启动检查当作进程/操作系统沙箱。静态 ESM 依赖仍先求值；管理 CLI、构建和测试也必须主动使用安全 Node。
- 运行时测试覆盖补丁边界、非支持主版本、预发布和格式错误，并检查根包/锁文件策略同步。
- 本次官方 npm registry 的 `npm audit --json --ignore-scripts` 检查为 **0 个已知依赖漏洞（443 个依赖）**。依赖审计不检查 Node 二进制、系统库、容器漏洞或未知漏洞；未使用 `npm audit fix --force`，没有无依据升级应用依赖。

## 本机隔离运行时

按用户选择，仅在忽略目录 `.cache/node-v24.22.2-win-x64/` 放置官方 Windows x64 `node.exe`，不修改系统安装或全局 PATH。**本次发布准备已完成断点续传、SHA-256 校验并确认输出 `v24.22.2`；该本机文件不包含在发布包内。**来源：<https://nodejs.org/dist/v24.22.2/win-x64/node.exe>，SHA-256 与官方 [SHASUMS256.txt](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt) 比较：

```text
1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9
```

哈希核对不是独立签名验证。不要在校验失败时执行文件；不要提交二进制或浏览器登录资料。下列 PowerShell 命令只影响当前终端及其子进程，先确认文件确实下载并校验成功：

```powershell
$env:PATH = "$PWD\.cache\node-v24.22.2-win-x64;$env:PATH"
node --version
npm run typecheck
npm test
npm run build
```

npm 启动器若绑定系统 Node，应直接用安全二进制执行 npm 的 `npm-cli.js`，并确认子进程实际版本。已有服务、其他终端和当前 DSH 仍可能运行旧 Node；要消除它们的运行时风险，需要另行升级其实际 Node 并重启进程。此项目内隔离安装不宣称系统已修复。

## 容器更新

```sh
docker compose build --pull
docker compose run --rm --no-deps novel-agent node --version
```

核验输出为 22.23.4 或经复核的新安全版本，并在正式流水线固定可信 digest、扫描镜像。新镜像不会修复旧容器；完成正常备份/停机流程后重新部署。不要为测试使用真实数据卷、触发短信/付费模型/远端发布，或降低非 root、只读根、seccomp 等既有隔离配置。未执行镜像构建时，不应将 Docker 配置变更描述成已部署修复。
