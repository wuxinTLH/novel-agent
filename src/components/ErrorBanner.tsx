import { X } from 'lucide-react';
import { ApiError } from '../api';

export function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '操作失败，请稍后再试。';
  if (!(error instanceof ApiError)) return message;
  const guidance =
    error.code === 'REQUEST_TIMEOUT' || error.status === 524 || /timeout/i.test(error.code || '')
      ? '请求等待超时。已保存书稿不会因此丢失；请查看运行记录和可恢复稿，再决定是否重试。'
      : error.code === 'NETWORK_ERROR' || error.code === 'RUN_RESULT_UNKNOWN'
        ? '连接中断，提交结果可能已生效。请先核对运行状态，不要重复启动。'
        : error.status === 409
          ? '当前版本或运行状态已变化。请刷新核对；未保存的文字请先导出。'
          : /empty/i.test(error.code || '')
            ? '模型未返回有效正文。请检查模型与协议配置，已有内容会保留。'
            : error.status === 401 || error.status === 403
              ? '请检查本地会话或模型凭据，然后手动重新操作。'
              : '';
  return [
    message,
    guidance,
    error.requestId ? `请求编号：${error.requestId}` : '',
    error.runId ? `运行编号：${error.runId}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export default function ErrorBanner({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{errorMessage(error)}</span>
      {onClose && (
        <button type="button" aria-label="关闭错误" onClick={onClose}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}
