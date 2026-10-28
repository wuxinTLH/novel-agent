import { useEffect, useRef, useState } from 'react';
import type { AuthRole } from '../../../../../shared/auth';
import { hasPermission, type Permission } from '../../../../../shared/permissions';
import { api } from '../../services/api';
import '../../styles/online-maintenance.scss';

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

type MaintenanceAction = Job['kind'] | 'cancel';
const actionPermissions: Record<MaintenanceAction, Permission> = {
  backup: 'maintenance.backup',
  validate: 'maintenance.validate',
  'restore-plan': 'maintenance.restorePlan',
  cancel: 'maintenance.cancel',
};

/** Authenticated parents must pass the actual role; undefined retains local/legacy
 * superadmin controls. The server remains authoritative for every request. */
export default function OnlineMaintenance({ role }: { role?: AuthRole }) {
  const effectiveRole = role === undefined ? 'superadmin' : role;
  const canBackup = hasPermission(effectiveRole, 'maintenance.backup');
  const canValidate = hasPermission(effectiveRole, 'maintenance.validate');
  const canRestorePlan = hasPermission(effectiveRole, 'maintenance.restorePlan');
  const canCancel = hasPermission(effectiveRole, 'maintenance.cancel');
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [backupId, setBackupId] = useState('');
  const [manualBackupId, setManualBackupId] = useState('');
  const [useManualBackup, setUseManualBackup] = useState(false);
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
  const mutate = async (action: MaintenanceAction, id?: string) => {
    // Check again at submission, not just in the UI. Unknown actions/roles deny.
    if (!hasPermission(effectiveRole, actionPermissions[action])) {
      setError('当前角色无权执行此维护操作。');
      return;
    }
    if (gate.current) return;
    const url =
      action === 'cancel' ? root + '/tasks/' + encodeURIComponent(id ?? '') + '/cancel' : root + '/tasks';
    const body =
      action === 'cancel'
        ? undefined
        : action === 'backup'
          ? { kind: action, confirmSecrets: true }
          : { kind: action, backupId: id };
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
  const completedBackups = (status?.jobs ?? []).filter(
    (job) => job.kind === 'backup' && job.state === 'succeeded' && job.backupId,
  );
  const availableBackupIds = [...new Set(completedBackups.map((job) => job.backupId!))];
  const manualId = manualBackupId.trim();
  const validManualId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manualId);
  const selectedBackupId = useManualBackup
    ? validManualId
      ? manualId
      : ''
    : availableBackupIds.includes(backupId)
      ? backupId
      : '';
  const activeJobs = (status?.jobs ?? []).filter((job) => ['queued', 'running'].includes(job.state));
  // The status API returns manager.list(), which reverses stored history to newest first.
  const latestValidation = status?.jobs.find(
    (job) => job.kind === 'validate' && job.backupId === selectedBackupId,
  );
  return (
    <section aria-label="在线维护任务" className="administration-section online-maintenance">
      <header className="online-maintenance-heading">
        <div>
          <h3>备份与恢复准备</h3>
          <p>
            {canRestorePlan
              ? '备份全应用，校验完整性，再准备离线恢复。'
              : '备份全应用并校验完整性；离线恢复计划由具备权限的管理员准备。'}
          </p>
        </div>
        <span className="online-maintenance-badge">
          {canRestorePlan ? '仅备份与计划 · 不在线恢复' : '仅授权备份与校验 · 不在线恢复'}
        </span>
      </header>

      <div className="online-maintenance-boundary">
        <strong>恢复与迁移必须停服。</strong>
        <span>此页面不会写入恢复目标；创建备份会让全部租户短暂停顿。</span>
      </div>
      {error && (
        <p role="alert" className="administration-feedback is-error">
          {error}
        </p>
      )}
      {!status && (
        <p role="status" className="online-maintenance-empty">
          {error ? '任务状态暂不可用，操作尚未开放。页面将自动重试，请勿重复提交任务。' : '正在读取维护状态…'}
        </p>
      )}
      {status && (
        <>
          <dl className="online-maintenance-overview" aria-label="维护状态概览">
            <div>
              <dt>在线备份</dt>
              <dd>{status.backupAvailable ? '可创建' : '暂不可用'}</dd>
            </div>
            <div>
              <dt>进行中的任务</dt>
              <dd>
                {activeJobs.length}
                <small>含排队任务</small>
              </dd>
            </div>
            <div>
              <dt>可选成功备份</dt>
              <dd>
                {availableBackupIds.length}
                <small>来自最近任务</small>
              </dd>
            </div>
          </dl>
          <ol className="online-maintenance-steps" aria-label="备份与离线恢复准备步骤">
            {canBackup && (
              <li className="online-maintenance-step">
                <div className="online-maintenance-step-title">
                  <span aria-hidden="true">01</span>
                  <h4>创建全应用备份</h4>
                </div>
                <p>包含全部租户、控制面和已配置业务数据库，不只是当前用户。</p>
                <label className="online-maintenance-consent">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <span>我确认备份包含密码、密钥和浏览器会话等敏感资料，并同意全部租户全局短暂停顿。</span>
                </label>
                <button
                  className="is-primary"
                  type="button"
                  disabled={busy || !acknowledged || !status.backupAvailable}
                  onClick={() => {
                    void mutate('backup');
                  }}
                >
                  创建全应用备份
                </button>
                {!status.backupAvailable && (
                  <p className="online-maintenance-note">
                    缺少可靠的全局静默屏障，在线备份不可用。请使用停服 CLI。
                  </p>
                )}
              </li>
            )}
            {canValidate && (
              <li className="online-maintenance-step">
                <div className="online-maintenance-step-title">
                  <span aria-hidden="true">02</span>
                  <h4>选择备份并校验</h4>
                </div>
                <p>从成功任务选择备份，或使用已有受管备份 ID。仅校验完整性，不验证业务语义。</p>
                <label>
                  选择成功备份
                  <select
                    value={useManualBackup ? '' : selectedBackupId}
                    onChange={(event) => {
                      setUseManualBackup(false);
                      setBackupId(event.target.value);
                    }}
                  >
                    <option value="">
                      {availableBackupIds.length ? '请选择备份' : '暂无成功备份，请先完成第 1 步'}
                    </option>
                    {availableBackupIds.map((id) => {
                      const job = completedBackups.find((item) => item.backupId === id)!;
                      return (
                        <option key={id} value={id}>
                          {new Date(job.createdAt).toLocaleString()} · {id}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <details>
                  <summary>使用已有受管备份 ID</summary>
                  <label>
                    受管备份 UUID
                    <input
                      type="text"
                      value={manualBackupId}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={Boolean(manualId && !validManualId)}
                      aria-describedby="online-maintenance-manual-help"
                      onChange={(event) => {
                        setManualBackupId(event.target.value);
                        setUseManualBackup(true);
                      }}
                    />
                  </label>
                  <p id="online-maintenance-manual-help" className="online-maintenance-note">
                    {manualId && !validManualId ? '请输入完整 UUID。' : '用于不在最近任务记录中的已有备份。'}
                    前端仅检查格式，不代表备份有效；受管目录、存在性及完整性由服务端权威校验，不接受文件路径。
                  </p>
                </details>
                <button
                  type="button"
                  disabled={busy || !selectedBackupId}
                  onClick={() => {
                    void mutate('validate', selectedBackupId);
                  }}
                >
                  校验完整性
                </button>
                <p className="online-maintenance-note">
                  {selectedBackupId
                    ? latestValidation
                      ? `此备份最近校验：${states[latestValidation.state]}`
                      : '此备份尚无独立校验记录。'
                    : '选择后可提交校验任务。'}
                </p>
              </li>
            )}
            {canRestorePlan && (
              <li className="online-maintenance-step">
                <div className="online-maintenance-step-title">
                  <span aria-hidden="true">03</span>
                  <h4>生成离线恢复计划</h4>
                </div>
                <p>为所选备份生成停服操作指引。此操作绝不执行在线恢复。</p>
                <div className="online-maintenance-selection">
                  <small>当前备份</small>
                  {selectedBackupId ? <code>{selectedBackupId}</code> : <span>请先在第 2 步选择备份</span>}
                </div>
                <button
                  type="button"
                  disabled={busy || !selectedBackupId}
                  onClick={() => {
                    void mutate('restore-plan', selectedBackupId);
                  }}
                >
                  生成离线恢复计划
                </button>
                <p className="online-maintenance-note">
                  计划包含完整性检查，但不代表已恢复或可直接启动服务。
                </p>
              </li>
            )}
          </ol>

          <section className="online-maintenance-history" aria-label="最近维护任务">
            <header className="online-maintenance-heading">
              <h4>
                最近任务 <span className="online-maintenance-count">{status.jobs.length}</span>
              </h4>
              <small>每 2 秒自动更新 · 进度按阶段估计</small>
            </header>
            <p className="online-maintenance-note">
              请求未确认或任务失败时，先核对任务记录再决定下一步，请勿重复提交。重启中断的任务不会自动重试。
            </p>
            {status.jobs.length === 0 && (
              <p className="online-maintenance-empty">暂无任务。从创建全应用备份开始。</p>
            )}
            <ol className="online-maintenance-jobs" aria-label="维护任务历史">
              {status.jobs.map((job) => (
                <li key={job.id}>
                  <div className="online-maintenance-heading">
                    <h4>{labels[job.kind]}</h4>
                    <span className={`online-maintenance-badge is-${job.state}`}>{states[job.state]}</span>
                  </div>
                  <p className="online-maintenance-job-meta">
                    <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time> · 阶段{' '}
                    {job.phase}
                  </p>
                  <div className="online-maintenance-progress">
                    <progress max={100} value={job.progress} aria-label={`${labels[job.kind]}阶段进度`} />
                    <span>{job.progress}%</span>
                  </div>
                  <p className="online-maintenance-job-meta">
                    任务 <code>{job.id}</code>
                  </p>
                  {job.backupId && (
                    <div className="online-maintenance-job-backup">
                      <p>
                        备份 <code>{job.backupId}</code>
                      </p>
                      {canValidate && job.kind === 'backup' && job.state === 'succeeded' && (
                        <button
                          type="button"
                          onClick={() => {
                            setUseManualBackup(false);
                            setBackupId(job.backupId!);
                          }}
                        >
                          {selectedBackupId === job.backupId ? '已选用此备份' : '选用此备份'}
                        </button>
                      )}
                    </div>
                  )}
                  {job.errorCode && (
                    <p role="status">安全错误代码：{job.errorCode}。本页不显示原始错误或本地路径。</p>
                  )}
                  {job.result && (
                    <div className="online-maintenance-result">
                      <p>
                        完整性校验通过：{job.result.fileCount} 个文件，{job.result.profileCount}{' '}
                        个业务数据库配置。外部密钥
                        {job.result.externalKeysRequired ? '需要独立提供' : '未在清单标记'}。
                      </p>
                      {canRestorePlan && job.kind === 'restore-plan' && (
                        <details open>
                          <summary>离线恢复操作计划（必须停服）</summary>
                          <ol>
                            <li>安排停服窗口，停止所有共享数据库运行时；独立保存当前完整备份与外部密钥。</li>
                            <li>由主机管理员定位受管备份，准备新/空数据目录及显式可信的空数据库目标。</li>
                            <li>
                              使用离线 restore CLI；校验 owner/profile
                              映射、业务布局和密钥。遇恢复日志必须人工协调，不自动删除日志或覆盖现有数据。
                            </li>
                            <li>核对恢复结果并撤销旧会话后再启动服务。在线计划没有执行任何恢复。</li>
                          </ol>
                        </details>
                      )}
                    </div>
                  )}
                  {canCancel && ['queued', 'running'].includes(job.state) && (
                    <button
                      type="button"
                      disabled={busy || job.cancelRequested || job.phase === 'committing'}
                      onClick={() => {
                        void mutate('cancel', job.id);
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
          </section>
        </>
      )}
      <details className="online-maintenance-safety">
        <summary>安全边界与技术说明</summary>
        <div>
          <p>
            备份作用域为全部租户、控制面与全部已配置业务数据库。备份期间暂停其他请求、排空并关闭租户运行时，完成后恢复接入。
          </p>
          <p>
            备份含密码、密钥和浏览器会话，仅存放于服务端受管目录；不提供浏览器下载或任意路径访问。外部密钥需独立安全保管。这不是整个数据库
            dump。
          </p>
          <p>
            <strong>恢复与迁移必须停服。</strong>
            在线只做备份完整性校验和离线计划，不连接备份内数据库、不写恢复目标、不保证业务语义或密钥可解密。
          </p>
          <p>
            提交后请以任务列表为准；请求未确认完成不代表任务未创建，不要重复提交。失败或中断后先核对安全错误代码和任务状态，再由管理员判断是否重新创建任务。
          </p>
          {status && (
            <p>
              最多排队 {status.maxQueued} 项；最多保留 {status.maxBackups}{' '}
              个备份/未完成产物，达到容量后须由主机管理员安全整理。
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
