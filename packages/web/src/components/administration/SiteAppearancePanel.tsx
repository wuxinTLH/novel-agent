import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { NavigationStyle, SiteAppearance } from '../../../../../shared/site-appearance';
import { useLocale } from '../../locals';
import { api, ApiError } from '../../services/api';
import { useConfirm } from '../common/AppDialog';
import { fallbackAppearance, isSiteAppearance, navigationStyleVariables } from '../navigation/siteAppearance';
import { publishSiteAppearance } from '../navigation/useSiteAppearance';
import './SiteAppearancePanel.scss';

const colorFields = [
  ['backgroundColor', '背景颜色'], ['textColor', '文字颜色'], ['accentColor', '强调颜色'], ['borderColor', '边框颜色'],
] as const;
export default function SiteAppearancePanel({ onBusy, onDirty }: { onBusy: (value: boolean) => void; onDirty: (value: boolean) => void }) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<SiteAppearance>();
  const [draft, setDraft] = useState<SiteAppearance>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [expired, setExpired] = useState(false);
  const [reload, setReload] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const invalid = useRef(false);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    invalid.current = false;
    const abort = () => {
      invalid.current = true;
      controller.current?.abort();
      setExpired(true); setBusy(false); onBusy(false);
      setError(t('会话已切换，请关闭并重新打开管理控制台。'));
    };
    const storage = (event: StorageEvent) => { if (event.key === 'novel-auth-identity' || event.key === null) abort(); };
    window.addEventListener('novel-auth-expired', abort);
    window.addEventListener('storage', storage);
    return () => {
      invalid.current = true;
      controller.current?.abort();
      onBusy(false); onDirty(false);
      window.removeEventListener('novel-auth-expired', abort);
      window.removeEventListener('storage', storage);
    };
  }, [onBusy, onDirty]);
  useEffect(() => {
    if (invalid.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true); onBusy(true); setError(''); setNotice('');
    void api<unknown>('/admin/site-appearance', { signal: request.signal }).then(value => {
      if (request.signal.aborted || invalid.current) return;
      if (!isSiteAppearance(value)) throw new Error('Invalid appearance');
      setSaved(value); setDraft(value); setConflict(false);
    }).catch(() => { if (!request.signal.aborted && !invalid.current) setError(t('无法读取站点外观，请重新加载。当前主题与作者署名不受影响。')); })
      .finally(() => { if (!request.signal.aborted && !invalid.current) { setBusy(false); onBusy(false); } });
    return () => request.abort();
  }, [reload, onBusy]);
  const updateStyle = (section: 'header' | 'footer', key: keyof NavigationStyle, value: string | number) => {
    setNotice('');
    setDraft(current => current && ({ ...current, [section]: { ...current[section], [key]: value } }));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || invalid.current || conflict || !draft) return;
    if (!isSiteAppearance(draft)) { setError(t('请输入六位十六进制颜色或留空，字号 12–24，间距 0–32。')); return; }
    const request = new AbortController();
    controller.current = request;
    setBusy(true); onBusy(true); setError(''); setNotice('');
    try {
      const value = await api<unknown>('/admin/site-appearance', {
        method: 'PUT', signal: request.signal,
        body: JSON.stringify({ expectedRevision: draft.revision, companyName: draft.companyName, header: draft.header, footer: draft.footer }),
      });
      if (request.signal.aborted || invalid.current) return;
      if (!isSiteAppearance(value)) throw new Error('Invalid appearance');
      setSaved(value); setDraft(value); publishSiteAppearance(value); setNotice(t('外观已保存'));
    } catch (reason) {
      if (request.signal.aborted || invalid.current) return;
      const stale = reason instanceof ApiError && reason.status === 409;
      setConflict(stale); setError(t(stale ? '外观已被其他管理员修改。编辑内容已保留，请重新加载后再保存；不会自动覆盖。' : '外观保存失败，编辑内容已保留。'));
    } finally {
      if (!request.signal.aborted && !invalid.current) { setBusy(false); onBusy(false); }
    }
  };
  return <form className="site-appearance-panel" onSubmit={event => { void save(event); }}>
    <h3>{t('站点外观')}</h3><p>{t('自定义全局页眉与页脚。空颜色继承当前主题；作者署名始终保留。')}</p>
    {error && <p role="alert" className="administration-feedback is-error">{error}</p>}
    {notice && <p role="status" className="administration-feedback">{notice}</p>}
    {busy && <p role="status">{t('正在读取服务端状态…')}</p>}
    <button type="button" disabled={busy || expired} onClick={async () => {
      if (dirty && !(await confirm(t('重新载入将丢弃尚未保存的外观编辑，确定继续吗？')))) return;
      if (!invalid.current) setReload(value => value + 1);
    }}>{t('重新载入外观')}</button>
    {draft && <>
      <fieldset disabled={busy || expired}>
        <label>{t('公司名称（可选）')}<input data-testid="appearance-company" maxLength={120} value={draft.companyName} onChange={event => setDraft({ ...draft, companyName: event.target.value })} /></label>
      </fieldset>
      {(['header', 'footer'] as const).map(section => <fieldset key={section} disabled={busy || expired}>
        <legend>{t(section === 'header' ? '页眉外观' : '页脚外观')}</legend>
        <div className="appearance-fields">
          {colorFields.map(([key, label]) => <label key={key}>{t(label)}
            <span className="appearance-color-control">
              <input data-testid={`appearance-${section}-${key}`} value={draft[section][key]} placeholder={t('继承主题')} pattern="#[0-9a-fA-F]{6}|" onChange={event => updateStyle(section, key, event.target.value)} />
              <input type="color" aria-label={`${t(section === 'header' ? '页眉外观' : '页脚外观')} ${t(label)}`} data-testid={`appearance-${section}-${key}-picker`} value={/^#[\da-f]{6}$/i.test(draft[section][key]) ? draft[section][key] : '#808080'} onChange={event => updateStyle(section, key, event.target.value)} />
              <button type="button" onClick={() => updateStyle(section, key, '')}>{t('继承主题')}</button>
            </span>
          </label>)}
          <label>{t('字体大小')}<input type="number" min={12} max={24} step={1} required data-testid={`appearance-${section}-fontSize`} value={draft[section].fontSize} onChange={event => updateStyle(section, 'fontSize', event.target.valueAsNumber)} /></label>
          <label>{t('垂直间距')}<input type="number" min={0} max={32} step={1} required data-testid={`appearance-${section}-paddingY`} value={draft[section].paddingY} onChange={event => updateStyle(section, 'paddingY', event.target.valueAsNumber)} /></label>
        </div>
        <div className="appearance-preview" data-testid={`appearance-preview-${section}`} style={navigationStyleVariables(draft[section])} aria-label={t('外观预览')}>
          {section === 'header' ? <><strong>{t('当前位置')}</strong> · <span>{t('全部作品')}</span></> : <><a href="https://github.com/wuxinTLH/novel-agent" target="_blank" rel="noopener noreferrer">© SakuraMikku</a>{draft.companyName.trim() && <span>© {draft.companyName}</span>}</>}
        </div>
      </fieldset>)}
      <div className="appearance-actions">
        <button type="button" disabled={busy || expired} onClick={() => setDraft({ ...fallbackAppearance, revision: draft.revision })}>{t('重置外观')}</button>
        <button type="submit" disabled={busy || expired || conflict || !dirty}>{t('保存外观')}</button>
      </div>
    </>}
  </form>;
}
