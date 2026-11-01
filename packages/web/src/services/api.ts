let csrfToken: string | undefined;
let sessionRequest: Promise<string> | undefined;
let authCsrfToken: string | undefined;
let authCsrfRequest: Promise<string> | undefined;
let identityEpoch = 0;
let csrfEpoch = 0;
let refreshRequest: Promise<boolean> | undefined;
let refreshGeneration = 0;
let adminCsrfToken: string | undefined;
let adminCsrfRequest: Promise<{ mode: string; csrfToken?: string }> | undefined;
async function adminMutationToken() {
  if (adminCsrfToken) return { mode: 'local', csrfToken: adminCsrfToken };
  if (!adminCsrfRequest) {
    const epoch = identityEpoch;
    const tokenEpoch = csrfEpoch;
    adminCsrfRequest = api<{ mode: string; csrfToken?: string }>('/admin/session')
      .then((session) => {
        if (epoch !== identityEpoch || tokenEpoch !== csrfEpoch)
          throw new Error('用户会话已切换，请重新操作。');
        adminCsrfToken = session.csrfToken;
        return session;
      })
      .finally(() => {
        if (epoch === identityEpoch && tokenEpoch === csrfEpoch) adminCsrfRequest = undefined;
      });
  }
  return adminCsrfRequest;
}

/** Invalidate both token domains; old in-flight responses may not repopulate them. */
export function resetApiSession() {
  identityEpoch += 1;
  csrfEpoch += 1;
  refreshRequest = undefined;
  csrfToken = undefined;
  sessionRequest = undefined;
  authCsrfToken = undefined;
  authCsrfRequest = undefined;
  adminCsrfToken = undefined;
  adminCsrfRequest = undefined;
}

async function authMutationToken() {
  if (authCsrfToken) return authCsrfToken;
  if (!authCsrfRequest) {
    const epoch = identityEpoch;
    const tokenEpoch = csrfEpoch;
    authCsrfRequest = apiRequest<{ authenticated: boolean; csrfToken?: string }>('/auth/session', {}, false)
      .then((session) =>
        session.authenticated && session.csrfToken
          ? { csrfToken: session.csrfToken }
          : api<{ csrfToken: string }>('/auth/csrf'),
      )
      .then((session) => {
        if (epoch !== identityEpoch || tokenEpoch !== csrfEpoch)
          throw new Error('用户会话已切换，请重新操作。');
        if (!session.csrfToken) throw new Error('无法取得登录会话凭据，请刷新后重试。');
        authCsrfToken = session.csrfToken;
        return session.csrfToken;
      })
      .finally(() => {
        if (epoch === identityEpoch && tokenEpoch === csrfEpoch) authCsrfRequest = undefined;
      });
  }
  return authCsrfRequest;
}

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
/** Refresh only when the server reports an existing, valid refresh cookie. */
async function refreshSession(): Promise<boolean> {
  if (refreshRequest) return refreshRequest;
  const epoch = identityEpoch;
  const request = (async () => {
    // A session CSRF token is not a prelogin nonce. Fetch a fresh nonce and its HttpOnly cookie.
    const { csrfToken: nonce } = await apiRequest<{ csrfToken: string }>('/auth/csrf', {}, false);
    if (epoch !== identityEpoch) return false;
    if (!nonce) throw new Error('无法取得登录会话凭据，请刷新后重试。');
    try {
      await apiRequest('/auth/refresh', { method: 'POST', headers: { 'x-csrf-token': nonce } }, false);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        if (epoch === identityEpoch) authCsrfToken = undefined;
        return false;
      }
      throw error;
    }
    if (epoch !== identityEpoch) return false;
    // Existing in-flight CSRF requests cannot restore credentials from the old session.
    csrfEpoch++;
    refreshGeneration++;
    csrfToken = authCsrfToken = adminCsrfToken = undefined;
    sessionRequest = authCsrfRequest = adminCsrfRequest = undefined;
    return true;
  })();
  refreshRequest = request;
  try {
    return await request;
  } finally {
    if (refreshRequest === request) refreshRequest = undefined;
  }
}
async function mutationToken() {
  if (csrfToken) return csrfToken;
  if (!sessionRequest) {
    const epoch = identityEpoch;
    const tokenEpoch = csrfEpoch;
    sessionRequest = api<{ csrfToken: string }>('/platforms/session')
      .then((session) => {
        if (epoch !== identityEpoch || tokenEpoch !== csrfEpoch)
          throw new Error('用户会话已切换，请重新操作。');
        if (!session.csrfToken) throw new Error('无法取得本地会话凭据，请刷新页面后重试。');
        csrfToken = session.csrfToken;
        return csrfToken;
      })
      .finally(() => {
        if (epoch === identityEpoch && tokenEpoch === csrfEpoch) sessionRequest = undefined;
      });
  }
  return sessionRequest;
}
export function api<T>(url: string, options: ApiOptions = {}): Promise<T> {
  return apiRequest<T>(url, options, true);
}
async function apiRequest<T>(url: string, options: ApiOptions, allowRefresh: boolean): Promise<T> {
  const generation = refreshGeneration;
  const epoch = identityEpoch;
  const tokenEpoch = csrfEpoch;
  const authRoute = url.startsWith('/auth/');
  const adminRoute = url.startsWith('/admin/');
  const method = (options.method || 'GET').toUpperCase();
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (mutation && authRoute && !headers.has('x-csrf-token'))
    headers.set('x-csrf-token', await authMutationToken());
  if (mutation && adminRoute) {
    const session = await adminMutationToken();
    if (session.mode === 'local' && session.csrfToken) headers.set('x-admin-csrf', session.csrfToken);
    else headers.set('x-csrf-token', await authMutationToken());
  }
  if (mutation && !authRoute && !adminRoute) {
    if (authCsrfToken && !headers.has('x-csrf-token')) headers.set('x-csrf-token', authCsrfToken);
    if (!headers.has('X-Platform-CSRF')) headers.set('X-Platform-CSRF', await mutationToken());
  }
  if (epoch !== identityEpoch) throw new Error('用户会话已切换，请重新操作。');
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
      ...(authRoute ? { cache: 'no-store' as const } : {}),
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
    if (response.status === 403 && mutation && epoch === identityEpoch && tokenEpoch === csrfEpoch) {
      if (authRoute || adminRoute) authCsrfToken = undefined;
      if (adminRoute) adminCsrfToken = undefined;
      if (!authRoute && !adminRoute) csrfToken = undefined;
    }
    if (
      response.status === 401 &&
      !authRoute &&
      epoch === identityEpoch &&
      allowRefresh &&
      method === 'GET'
    ) {
      if (generation !== refreshGeneration) return apiRequest<T>(url, options, false);
      // Session inspection is safe even in local/disabled mode; only the server's
      // refreshAvailable bit permits exchanging an existing refresh cookie.
      await apiRequest('/auth/session', {}, true);
      if (epoch !== identityEpoch) throw new Error('用户会话已切换，请重新操作。');
      if (generation !== refreshGeneration) return apiRequest<T>(url, options, false);
    }
    if (response.status === 401 && !authRoute && epoch === identityEpoch)
      window.dispatchEvent(new Event('novel-auth-expired'));
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
  if (epoch !== identityEpoch) throw new Error('用户会话已切换，请重新操作。');
  if (url === '/auth/session' && allowRefresh) {
    // A concurrent rotation may have completed while this older response was in flight.
    if (generation !== refreshGeneration) return apiRequest<T>(url, options, false);
    const session = body as { authenticated?: boolean; refreshAvailable?: boolean };
    if (session.authenticated === false && session.refreshAvailable === true) {
      if (await refreshSession()) {
        if (epoch !== identityEpoch) throw new Error('用户会话已切换，请重新操作。');
        return apiRequest<T>(url, options, false);
      }
    }
  }
  if (url === '/auth/session' || url === '/auth/csrf') {
    const token = (body as { csrfToken?: string } | undefined)?.csrfToken;
    if (token && tokenEpoch === csrfEpoch && (url !== '/auth/csrf' || !refreshRequest)) authCsrfToken = token;
  }
  if (url === '/auth/login' || url === '/auth/logout') resetApiSession();
  if (url === '/platforms/session') {
    const token = (body as { csrfToken?: string } | undefined)?.csrfToken;
    if (token && tokenEpoch === csrfEpoch) csrfToken = token;
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
