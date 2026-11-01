---
name: novel-workflow-consistency
description: 修改 Novel Agent 的工作流图、并发调度、生成与模型协议、章节候选采纳或取消恢复时，维护执行一致性并验证性能改动。
---
# 工作流与生成一致性

## 定位

所有项目相对路径以仓库根目录为基准（不是本 Skill 目录）。先读取：
- `packages/server/src/features/workflow/README.md`、`packages/server/src/features/chapters/README.md`、`packages/server/src/features/models/README.md`。
- `shared/workflow-scheduler.ts`、`shared/generation.ts`、`shared/model-runtime.ts`、`shared/types.ts` 和当前改动涉及的实现/测试。
- 调度集成说明：`shared/workflow-scheduler.integration.md`；通过 glob 定位 features/workflow、features/chapters 下的 `.test.ts`。

## 修改步骤

1. 从共享契约追踪前端请求、后端验证、Runner、持久化与 UI 状态；明确作品、workflow、run、chapter revision 的归属。
2. 列出变更前后的执行状态与失败路径；仅独立节点可以并行。保持依赖拓扑、可配置并发上限（当前 1–8）与章节写入串行，不将限流等同于取消。
3. 世界观流程只保存世界观，不生成章节；演示输出不能冒充真实模型。节点指定模型无效时应明确报错，不能静默换全局模型。
4. 保留重复提交幂等、取消传播、断连与恢复行为；验证中途模型/持久化失败，不让 UI 成功早于正式保存。
5. 重生成保留候选/恢复稿；采用前校验目标章节版本。全自动接续仅在完整真实工作流成功、审校和硬性校验通过且版本匹配后触发，单节点或演示不可发布。
6. 模型优化先使用本地 stub：覆盖 Chat Completions、Responses、Anthropic 的实际受影响协议、超时、取消、无效响应、流式分片边界；不默认触发付费 API。
7. 性能优化记录输入规模、并发、调用次数、耗时与错误率；同输入/模型策略对比，不靠省略审校或增大默认并发制造加速。

## 验证

先运行 `node --import tsx --test shared/workflow-scheduler.test.ts shared/model-runtime.test.ts` 和相关 feature 的明确测试路径，再运行 `npm run typecheck`。跨端/持久化变更扩大至 `npm test` 与 `npm run build`。如需生产冒烟，先阅读 `scripts/smoke.mjs` 并确认临时数据隔离，再执行 `npm run smoke`。

至少覆盖：环/缺失依赖、并发上限、运行中编辑、取消、保存失败、候选版本冲突、两作品/两工作流互不污染。报告区分模拟验证、真实模型质量和真实平台验收；后两者未经授权不执行。
