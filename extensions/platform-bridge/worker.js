import { base, secretPattern, validateMessage, isAuthorTab, isPopupSender } from './protocol.js';

// No content scripts, externally_connectable, web page messages, cookies or remote code.
// storage.session survives worker suspension but is cleared on browser restart.
const storageReady = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const key = 'pairing';
let busy = false;
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function request(route, method, body, token) {
  const response = await fetch(`${base}${route}`, {
    method, credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('本机服务未返回有效响应');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error('本机响应超出限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok) {
    if ([401, 403, 410].includes(response.status)) await chrome.storage.session.remove(key);
    throw new Error(typeof data.error === 'string' ? data.error.slice(0, 300) : '本机请求失败');
  }
  return data;
}
async function currentTab(expectedId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isAuthorTab(tab) || (expectedId !== undefined && tab.id !== expectedId)) throw new Error('请在最初配对的番茄作者后台标签页操作');
  return tab;
}
async function perform(message) {
  validateMessage(message);
  await storageReady;
  const stored = (await chrome.storage.session.get(key))[key];
  if (message.action === 'claim') {
    if (stored) throw new Error('请先断开现有配对；如配对响应丢失，请在应用撤销后重新生成配对码');
    const tab = await currentTab();
    const claim = await request('/claim', 'POST', { challenge: message.challenge, tabId: tab.id, approved: true });
    if (!secretPattern.test(claim.claimToken) || typeof claim.pairingId !== 'string' || !/^[a-f0-9-]{36}$/.test(claim.pairingId) || typeof claim.projectId !== 'string' || claim.projectId.length > 200 || !Number.isFinite(Date.parse(claim.expiresAt))) throw new Error('配对响应格式无效，请在应用撤销');
    await chrome.storage.session.set({ [key]: { ...claim, tabId: tab.id, token: randomToken() } });
    return { paired: false, tabId: tab.id, projectId: claim.projectId, message: '已批准。请返回应用核对扩展 ID 和标签页编号并确认，再点击完成配对。' };
  }
  if (!stored) return { paired: false, message: '尚未配对。' };
  if (message.action === 'disconnect') {
    try { if (stored.sessionId) await request('/session', 'DELETE', undefined, stored.token); }
    finally { await chrome.storage.session.remove(key); }
    return { paired: false, message: '本机凭据已清除。未完成的配对须在应用撤销；网络失败时已有服务端会话最多 30 分钟后到期。' };
  }
  await currentTab(stored.tabId);
  if (message.action === 'finish') {
    // Persist the SAME token before sending, making a lost finish response recoverable.
    const state = await request('/finish', 'POST', { pairingId: stored.pairingId, claimToken: stored.claimToken, token: stored.token });
    if (state.projectId !== stored.projectId || state.tabId !== stored.tabId || state.extensionOrigin !== chrome.runtime.getURL('').replace(/\/$/, '') || state.paired !== true || state.accountVerified !== false || state.listWorks !== false || state.saveDraft !== false || typeof state.id !== 'string') throw new Error('会话响应不匹配');
    await chrome.storage.session.set({ [key]: { ...stored, sessionId: state.id } });
  } else if (!stored.sessionId) return { paired: false, projectId: stored.projectId, tabId: stored.tabId, message: '等待应用确认后点击完成配对。' };
  const report = await request('/capabilities', 'GET', undefined, stored.token);
  if (report.projectId !== stored.projectId || report.tabId !== stored.tabId || report.paired !== true || ['accountVerified', 'listWorks', 'saveDraft', 'submitReview', 'publishChapter'].some(name => report[name] !== false)) throw new Error('能力回报不匹配；请断开并检查本机版本');
  return { paired: true, projectId: report.projectId, tabId: report.tabId, expiresAt: report.expiresAt, message: '仅配对成功；账号未核验，作品读取、草稿保存、提交审核和正式发布均不可用。' };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!isPopupSender(sender, chrome.runtime.id)) { reply({ error: '来源被拒绝' }); return false; }
  if (busy) { reply({ error: '请等待当前操作结束' }); return false; }
  busy = true;
  perform(message).then(reply, () => reply({ error: '操作未完成。请检查番茄作者标签页、本机服务和应用确认状态；必要时在应用撤销并重新配对。' })).finally(() => { busy = false; });
  return true;
});
