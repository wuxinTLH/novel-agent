import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';

type Job = {
  id: string;
  kind: 'backup' | 'validate' | 'restore-plan';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  progress: number;
  createdAt: string;
  backupId?: string;
  cancelRequested: boolean;
  errorCode?: string;
  result?: {
    fileCount: number;
    profileCount: number;
    externalKeysRequired: boolean;
    offlineRequired: boolean;
    validation: 'integrity-only';
  };
};
type Status = { backupAvailable: boolean; maxQueued: number; maxBackups: number; jobs: Job[] };
const root = '/admin/online-maintenance';
const labels = { backup: '全应用备份', validate: '备份完整性校验', 'restore-plan': '离线恢复计划' };
const states = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '重启中断（不自动重试）',
};

/** Parent renders inside the existing administrator-only maintenance panel. Uses the
 * shared API client, including local admin/authenticated CSRF credentials. */
export default function OnlineMaintenance() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [backupId, setBackupId] = useState('');
  const mounted = useRef(false);
  const gate = useRef(false);
  const reload = async (signal?: AbortSignal) => {
    const result = await api<Status>(root, { signal });
    if (mounted.current && !signal?.aborted) {
      setStatus(result);
      setError('');
    }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await reload(controller.signal);
      } catch {
        if (!controller.signal.aborted) setError('无法读取维护任务；任务可能仍在执行，请重新核对。');
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    };
    void poll();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const mutate = async (url: string, body?: unknown) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await api(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      await reload();
    } catch {
      if (mounted.current) setError('请求未确认完成。请先查看任务列表，不要重复提交。');
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="在线维护任务" className="administration-section">
      <h3>在线维护任务</h3>
      <p>
        作用域：全部租户、控制面与全部已配置业务数据库，而非当前用户。备份期间暂停其他请求、排空并关闭租户运行时；完成后恢复接入。
      </p>
      <p>
        备份含密码、密钥和浏览器会话，仅存放于服务端受管目录；不提供浏览器下载或任意路径访问。外部密钥需独立安全保管。不是整个数据库
        dump。
      </p>
      <p>
        <strong>恢复与迁移必须停服。</strong>
        在线只做备份完整性校验和离线计划，不连接备份内数据库、不写恢复目标、不保证业务语义或密钥可解密。
      </p>
      {error && (
        <p role="alert" className="administration-feedback is-error">
          {error}
        </p>
      )}
      {!status && <p role="status">正在读取任务…</p>}
      {status && (
        <>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            我了解全部租户会短暂停顿，且备份包含敏感材料。
          </label>
          <button
            type="button"
            disabled={busy || !acknowledged || !status.backupAvailable}
            onClick={() => {
              void mutate(root + '/tasks', { kind: 'backup', confirmSecrets: true });
            }}
          >
            创建全应用备份任务
          </button>
          {!status.backupAvailable && (
            <p>运行时尚未提供可靠的全局静默屏障，在线备份不可用。请使用停服 CLI。</p>
          )}
          <p>
            最多排队 {status.maxQueued} 项；最多保留 {status.maxBackups}{' '}
            个备份/未完成产物，达到容量后须由主机管理员安全整理。
          </p>
          <label>
            受管备份 ID{' '}
            <input
              value={backupId}
              onChange={(event) => setBackupId(event.target.value)}
              placeholder="选择已完成备份或填写 UUID"
            />
          </label>
          <button
            type="button"
            disabled={busy || !backupId}
            onClick={() => {
              void mutate(root + '/tasks', { kind: 'validate', backupId });
            }}
          >
            校验完整性
          </button>
          <button
            type="button"
            disabled={busy || !backupId}
            onClick={() => {
              void mutate(root + '/tasks', { kind: 'restore-plan', backupId });
            }}
          >
            生成离线恢复计划
          </button>
          <ol aria-label="维护任务历史">
            {status.jobs.map((job) => (
              <li key={job.id}>
                <h4>
                  {labels[job.kind]} · {states[job.state]}
                </h4>
                <p>
                  任务 {job.id} · {new Date(job.createdAt).toLocaleString()} · 阶段 {job.phase}
                </p>
                <progress max={100} value={job.progress} aria-label="阶段进度" />{' '}
                <span>{job.progress}%（按阶段估计）</span>
                {job.backupId && (
                  <p>
                    备份 ID <code>{job.backupId}</code>{' '}
                    <button type="button" onClick={() => setBackupId(job.backupId!)}>
                      选用此备份
                    </button>
                  </p>
                )}
                {job.errorCode && (
                  <p role="status">安全错误代码：{job.errorCode}。本页不显示原始错误或本地路径。</p>
                )}
                {job.result && (
                  <div>
                    <p>
                      完整性校验通过：{job.result.fileCount} 个文件，{job.result.profileCount}{' '}
                      个业务数据库配置。外部密钥
                      {job.result.externalKeysRequired ? '需要独立提供' : '未在清单标记'}。
                    </p>
                    {job.kind === 'restore-plan' && (
                      <ol>
                        <li>安排停服窗口，停止所有共享数据库运行时；独立保存当前完整备份与外部密钥。</li>
                        <li>由主机管理员定位受管备份，准备新/空数据目录及显式可信的空数据库目标。</li>
                        <li>
                          使用离线 restore CLI；校验 owner/profile
                          映射、业务布局和密钥。遇恢复日志必须人工协调，不自动删除日志或覆盖现有数据。
                        </li>
                        <li>核对恢复结果并撤销旧会话后再启动服务。在线计划没有执行任何恢复。</li>
                      </ol>
                    )}
                  </div>
                )}
                {['queued', 'running'].includes(job.state) && (
                  <button
                    type="button"
                    disabled={busy || job.cancelRequested || job.phase === 'committing'}
                    onClick={() => {
                      void mutate(root + '/tasks/' + encodeURIComponent(job.id) + '/cancel');
                    }}
                  >
                    {job.cancelRequested
                      ? '取消已请求，等待释放屏障'
                      : job.phase === 'committing'
                        ? '已进入提交，不能取消'
                        : '提交前取消'}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
