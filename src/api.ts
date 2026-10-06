let csrfToken: string | undefined;
let sessionRequest: Promise<string> | undefined;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    const data = details as
      { code?: string; retryable?: boolean; requestId?: string; runId?: string } | undefined;
    this.code = data?.code;
    this.retryable = data?.retryable;
    this.requestId = data?.requestId;
    this.runId = data?.runId;
  }
  code?: string;
  retryable?: boolean;
  requestId?: string;
  runId?: string;
}
export type ApiOptions = RequestInit & { timeoutMs?: number };
async function mutationToken() {
  if (csrfToken) return csrfToken;
  if (!sessionRequest) {
    sessionRequest = api<{ csrfToken: string }>('/platforms/session')
      .then((session) => {
        if (!session.csrfToken) throw new Error('无法取得本地会话凭据，请刷新页面后重试。');
        csrfToken = session.csrfToken;
        return csrfToken;
      })
      .finally(() => {
        sessionRequest = undefined;
      });
  }
  return sessionRequest;
}
export async function api<T>(url: string, options: ApiOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (mutation && !headers.has('X-Platform-CSRF')) headers.set('X-Platform-CSRF', await mutationToken());
  if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  const timeoutMs = options.timeoutMs ?? (mutation ? 30_000 : 15_000);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  let response: Response;
  let text: string;
  try {
    response = await fetch('/api' + url, {
      ...options,
      signal: controller.signal,
      headers,
      credentials: 'same-origin',
    });
    text = await response.text();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const timedOut =
      controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError';
    throw new ApiError(
      timedOut
        ? '请求超时，服务端可能仍在处理。请先核对运行状态。'
        : '网络连接中断，请先核对运行状态后再操作。',
      timedOut ? 524 : 0,
      { code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', retryable: true },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      response.ok ? '服务器返回了无法读取的数据。' : `请求失败（${response.status}），请检查本地服务。`,
      response.status,
    );
  }
  if (!response.ok) {
    const data = body as
      { error?: unknown; code?: string; retryable?: boolean; requestId?: string; runId?: string } | undefined;
    if (response.status === 403 && mutation) csrfToken = undefined;
    const message = typeof data?.error === 'string' ? data.error : '请求失败，请稍后重试。';
    throw new ApiError(
      message +
        (response.status === 403 && mutation
          ? ' 本地会话可能已过期，请刷新页面或再次操作；未自动重试写入。'
          : ''),
      response.status,
      {
        ...data,
        requestId: data?.requestId || response.headers.get('X-Request-Id') || undefined,
        runId: data?.runId || response.headers.get('X-Run-Id') || undefined,
      },
    );
  }
  if (url === '/platforms/session') {
    const token = (body as { csrfToken?: string } | undefined)?.csrfToken;
    if (token) csrfToken = token;
  }
  return body as T;
}
export function download(name: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[<>:"/\\|?*]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
