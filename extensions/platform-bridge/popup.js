document.getElementById('extension-id').textContent = chrome.runtime.id;
const result = document.getElementById('result');
for (const action of ['claim', 'finish', 'status', 'disconnect']) {
  document.getElementById(action).addEventListener('click', async () => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try {
      const message = action === 'claim' ? { action, approved: document.getElementById('approval').checked, challenge: document.getElementById('challenge').value.trim() } : { action };
      const response = await chrome.runtime.sendMessage(message);
      document.getElementById('challenge').value = '';
      result.textContent = response.error || [response.message, response.projectId ? `项目：${response.projectId}` : '', response.tabId !== undefined ? `标签页：${response.tabId}` : '', response.expiresAt ? `到期：${response.expiresAt}` : ''].filter(Boolean).join('\n');
    } catch { result.textContent = '扩展操作失败，请检查扩展管理页和本机服务。'; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
