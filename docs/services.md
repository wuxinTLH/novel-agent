# models 服务与用户边界

## 组织方式

`server/index.ts` 仅负责环境、数据锁、服务装配、监听及关闭。业务按独立模块放在 `server/models/`，当前为同进程服务，不是需要分别部署的微服务。

- `context.ts`：Store、Runner、PlatformRuntime、模型提供方共享上下文，以及 FeatureService 接口。
- `application.ts` / `registry.ts`：显式注册、服务顺序、重复标识校验。
- `http.ts`：统一来源、CSRF、频率、请求体、安全头、静态资源及错误处理。扩展服务不得绕过该层。
- `model-provider.ts` / `model-settings.ts`：模型连接、密钥持久化及配置 API。
- `projects.ts`：小说管理、项目查找和运行中变更约束。
- `workflow.ts` / `workflow-support.ts` / `project-operations.ts`：工作流、节点、图校验、持久化失败回滚。
- `assets.ts`：设定、上传和设定输出采纳。
- `generation.ts` / `chapters.ts`：生成、要求、候选、幂等执行、取消及章节版本。
- `platform.ts`：平台连接、绑定、发布队列等已有平台子服务适配。
- `user.ts`：User 身份/数据目录边界，当前不启动认证。
- `sqlconnect.ts` / `sqlconnect-drivers.ts`：数据库连接及显式初始化，参见 `docs/sqlconnect.md`。

保留现有 API 路径和本地 JSON 数据格式，不自动重写数据。注册扩展使用 FeatureService，并在应用统一防护后装配。应用工厂只注册服务路由，不自动托管关闭钩子；自定义服务还须加入入口的关闭列表，在关闭时显式等待其 close 钩子。

## User 当前状态

`GET /api/services/user` 提供只读状态；默认 `enabled:false`。不提供虚假的登录接口，不接受 `X-User-Id`、查询参数或客户端自报用户作为认证凭据。现有用户仍访问原 DATA_DIR，不将现有小说或平台凭据移动到新目录。

UserService 接受将来的可信认证解析器。未启用时解析为原本地目录；启用后只接受解析器验证的主体，按稳定身份 SHA-256 映射到 `DATA_DIR/users/<hash>`，避免路径穿越。无凭据时失败关闭，不能回落到共享目录。

真正启用多用户 HTTP 前，必须为每个 UserScope 创建并缓存独立 Store、Runner、ModelSecretStore、PlatformRuntime、发布队列及上传路由；各组件全部使用该 scope.dataDir，并在登出和服务关闭时清理运行时。不得只设置一个开关或只过滤项目列表，否则平台账号/密钥仍会串用户。当前入口刻意不挂接该认证解析器，也没有把共享运行时宣称为多用户运行时。

## SQL 与迁移边界

SQLconnect 是可用的连接/建表基础设施，而非小说存储切换器。配置与初始化不会让现有 JSON 小说自动写入 SQL。将来切换存储需要专门 repository 实现、备份、迁移与恢复验证；当前界面和 API 均明确显示 `storage: local-json`。
