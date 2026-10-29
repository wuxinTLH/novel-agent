export const base = 'http://127.0.0.1:3001/api/platform-extension';
export const secretPattern = /^[a-f0-9]{64}$/;
export function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('无效消息');
  const keys = Object.keys(message).sort().join(',');
  if (message.action === 'claim' && keys === 'action,approved,challenge' && message.approved === true && typeof message.challenge === 'string' && secretPattern.test(message.challenge)) return;
  if (['finish', 'status', 'disconnect'].includes(message.action) && keys === 'action') return;
  throw new Error('不受支持的操作或参数');
}
export function isAuthorTab(tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0 || tab.id > 2147483647) return false;
  try {
    const url = new URL(tab.url);
    return url.origin === 'https://fanqienovel.com' && !url.username && !url.password && (url.pathname === '/main' || url.pathname.startsWith('/main/'));
  } catch { return false; }
}
export function isPopupSender(sender, extensionId) {
  return sender?.id === extensionId && sender.url === `chrome-extension://${extensionId}/popup.html` && !sender.tab;
}
