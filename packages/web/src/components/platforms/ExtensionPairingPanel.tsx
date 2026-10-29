import { useEffect, useRef, useState } from 'react';
import type { ExtensionPairing } from '../../../../../shared/platforms';
import { api, ApiError } from '../../services/api';

export default function ExtensionPairingPanel({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const base = `/projects/${encodeURIComponent(projectId)}/platform-extension-pairings`;
  const [extensionId, setExtensionId] = useState('');
  const [pairings, setPairings] = useState<ExtensionPairing[]>([]);
  const [challenge, setChallenge] = useState<{ id: string; value: string }>();
  const [verified, setVerified] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; pending.current = false;
    setExtensionId(''); setChallenge(undefined); setVerified(''); setPairings([]); setUnsupported(false); setBusy(false); setLoading(true); setError('');
    void api<ExtensionPairing[]>(base, { signal: controller.signal }).then(setPairings).catch(failure => {
      if (controller.signal.aborted) return;
      setUnsupported(failure instanceof ApiError && failure.code === 'EXTENSION_AUTH_MODE_UNSUPPORTED');
      setError(failure instanceof Error ? failure.message : '配对状态读取失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base]);
  async function act(path = '', method = 'GET', body?: object) {
    const controller = lifetime.current;
    if (pending.current || loading || (disabled && method !== 'GET') || !controller || controller.signal.aborted) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (method === 'GET') setPairings(await api<ExtensionPairing[]>(base, { signal: controller.signal }));
      else {
        const result = await api<ExtensionPairing>(base + path, { method, signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (method === 'POST' && !path) setChallenge({ id: result.id, value: result.challenge });
        else { setChallenge(undefined); setVerified(''); }
        setPairings(await api<ExtensionPairing[]>(base, { signal: controller.signal }));
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setUnsupported(failure instanceof ApiError && failure.code === 'EXTENSION_AUTH_MODE_UNSUPPORTED');
        setError(failure instanceof Error ? failure.message : '配对操作未完成，请刷新状态');
      }
    } finally { if (!controller.signal.aborted) { pending.current = false; setBusy(false); } }
  }
  return <section className="platform-card" aria-busy={loading || busy}>
    <h2>浏览器扩展配对</h2>
    <p className="platform-help">仅支持本机 127.0.0.1:3001 的单用户模式。配对不核验作者身份；作品读取、草稿保存、提交审核和正式发布均不可用。</p>
    <p className="platform-help">在浏览器扩展管理页加载项目 extensions/platform-bridge 目录，将 popup 显示的扩展 ID 填入下方。打开番茄作者后台标签页后，在扩展中输入配对码并批准，再返回此处核对并确认。</p>
    {error && <p className="platform-error" role="alert">{error}</p>}
    {(loading || busy) && <p role="status">{loading ? '正在读取配对状态…' : '正在处理配对操作…'}</p>}
    {!loading && !error && !pairings.some(item => item.status !== 'closed') && <p className="platform-help">暂无有效配对。</p>}
    {!unsupported && <>
      <div className="platform-form"><label>扩展 ID<input disabled={disabled || busy || loading} value={extensionId} maxLength={32} autoComplete="off" spellCheck={false} onChange={event => setExtensionId(event.target.value.trim())} placeholder="32 位 a–p 字母" /></label>
        <button className="button secondary" type="button" disabled={disabled || busy || loading || !/^[a-p]{32}$/.test(extensionId)} onClick={() => void act('', 'POST', { extensionId })}>生成两分钟配对码（撤销旧配对）</button>
        <button className="button secondary" type="button" disabled={busy || loading} onClick={() => void act()}>刷新扩展批准状态</button>
      </div>
      {challenge && <p className="platform-notice">仅此处显示一次，请复制到扩展（不保存到浏览器本地）：<br /><code style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>{challenge.value}</code></p>}
      {pairings.filter(item => item.status !== 'closed').map(item => <article className="platform-record" key={item.id}>
        <p>来源：<code>{item.extensionOrigin}</code><br />标签页：{item.tabId ?? '等待扩展批准'}<br />到期：{new Date(item.expiresAt).toLocaleString('zh-CN')}</p>
        <p>{item.message}</p>
        {item.status === 'claimed' && <><label><input type="checkbox" disabled={disabled || busy || loading} checked={verified === item.id} onChange={event => setVerified(event.target.checked ? item.id : '')} />我已与扩展 popup 核对来源 ID 和标签页编号，批准此项目配对</label>
          <button className="button primary" type="button" disabled={disabled || busy || loading || verified !== item.id} onClick={() => void act(`/${item.id}/confirm`, 'POST', {})}>确认配对，再回扩展点击完成</button></>}
        {item.sessionId && <p className="platform-notice">已配对；账号未核验，作品、草稿、送审和发布权限均未开放。</p>}
        <button className="button secondary" type="button" disabled={disabled || busy || loading} onClick={() => void act(`/${item.id}`, 'DELETE')}>撤销此配对及会话</button>
      </article>)}
    </>}
  </section>;
}
