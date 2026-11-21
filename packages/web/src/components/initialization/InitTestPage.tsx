import { useEffect, useState } from 'react';
import { createTranslator, type Locale } from '../../locals/core';
import { ServerInitForm } from './ServerInitGate';
import { createInitTestSession } from './init-test';

const languageNames = { 'zh-CN': '中文', en: 'English' };

export default function InitTestPage() {
  const [locale, setLocale] = useState<Locale>('zh-CN');
  const [session, setSession] = useState(() => ({ ...createInitTestSession(), generation: 0 }));
  const t = createTranslator(locale);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <ServerInitForm key={session.generation} requestInit={session.request} t={t} testMode
    languageControl={<label>{t('语言')}<select data-testid="init-test-language" value={locale} onChange={(event) => setLocale(event.target.value === 'en' ? 'en' : 'zh-CN')}><option value="zh-CN">{languageNames['zh-CN']}</option><option value="en">{languageNames.en}</option></select></label>}
    controls={<aside className="server-init__test-banner" data-testid="init-test-banner" aria-label={t('仅测试，不生效')}>
      <h2>{t('仅测试，不生效')}</h2>
      <p>{t('所有操作仅在本页内存中模拟：不调用真实 API、不读取环境变量、不写浏览器存储、不保存配置、不创建账号。刷新页面或重置将清除测试内容。')}</p>
      <button type="button" data-testid="init-test-reset" onClick={() => setSession((previous) => ({ ...createInitTestSession(), generation: previous.generation + 1 }))}>{t('重置测试')}</button>
    </aside>}>{null}</ServerInitForm>;
}
