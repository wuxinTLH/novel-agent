---
name: novel-storage-performance
description: 优化 Novel Agent JSON/SQL 存储、Worker 桥、CAS、并发与迁移流程；以可重复基准验证性能，同时保留同步提交和租户隔离。
---
# 存储性能与维护

路径相对仓库根目录。先读 `docs/services.md` 的存储说明、`shared/storage.ts`、`packages/server/src/infrastructure/storage/` 下相关实现与测试，以及 `packages/server/src/features/administration/maintenance.ts`。

## 优化约束

1. 先确定后端、数据规模、owner 数、并发、读写比例、事务数和指标；在临时数据上复现，不打开真实 DATA_DIR、备份或数据库凭据。
2. 同步返回必须等待实际 COMMIT，不用 write-behind 假装加速。canonical entity tables、document 重建、revision、receipt 和 CAS 必须保持同事务一致性。
3. 保留每 owner 队列、snapshot/import 独占屏障、固定 owner 的 Worker 和超时处理。提交结果未知时失败关闭，不能回退 JSON 或重放可能已提交的写入。
4. 连接池、批处理、索引或序列化优化须覆盖回滚、并发 CAS 冲突、关闭/重启与超时；不得突破单应用实例/本地锁边界，不把连接池描述为 HA。
5. 迁移前备份且停止所有共享运行时；目标为空、可信且隔离。备份可能包含秘密，不通过网页下载、不写入日志；真实迁移/恢复必须单独获得授权。

## 验证

执行相关窄测试，例如：

```sh
node --import tsx --test packages/server/src/infrastructure/storage/document-storage.test.ts packages/server/src/infrastructure/storage/relational-storage.test.ts packages/server/src/infrastructure/storage/relational-storage-concurrency.test.ts packages/server/src/infrastructure/storage/pooled-storage-bridge.test.ts packages/server/src/features/administration/maintenance.test.ts
npm run typecheck
```

运行前读取 `scripts/benchmark-storage.ts`；`node --import tsx scripts/benchmark-storage.ts` 是模拟基准，不是真实 SQL 吞吐。默认 4 连接、80 操作、3 轮不是生产容量证据。对比记录环境、输入、耗时分布、错误率、提交/查询次数和内存，报告测量边界。

真实 PostgreSQL 测试 `scripts/test-relational-storage-live.ts` 会创建/删除随机数据库，仅在明确授权且连接参数由外部安全提供时执行；不要默认设置 `STORAGE_LIVE_ALLOW_CREATE_DATABASE=1`。不得将模拟测试外推为 MySQL/SQL Server 在线兼容性或生产性能已验证。
