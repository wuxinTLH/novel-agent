import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LanguageSwitcher, useLocale, type TranslationKey, type Translator } from '../../locals';
import { InitRequestError, relevantFields, validInitDraft, initialValues, initRequest, parseInitConfig, parseInitStatus, submissionValues, type InitConfig, type InitRequest } from './server-init';
import { composeInitPhone, type InitPhoneCode } from '../../../../../shared/init-phone';
import ServerInitDatabaseFields from './ServerInitDatabaseFields';
import { databaseSubmission, initialDatabaseDraft } from './init-database';
import './server-init.scss';

const fieldLabels: Record<string, TranslationKey> = {
  NOVEL_TRUSTED_PUBLIC_ORIGIN: '可信 HTTPS 来源', MODEL_SECRETS_KEY: '模型凭据加密密钥', PLATFORM_SECRETS_KEY: '平台凭据加密密钥',
  NOVEL_SMS_PROVIDER: '短信供应商（aliyun / tencent）', NOVEL_SMS_ALIYUN_ACCESS_KEY_ID: '阿里云访问密钥 ID', NOVEL_SMS_ALIYUN_ACCESS_KEY_SECRET: '阿里云访问密钥 Secret',
  NOVEL_SMS_ALIYUN_SIGN_NAME: '阿里云短信签名', NOVEL_SMS_ALIYUN_TEMPLATE_CODE: '阿里云短信模板', NOVEL_SMS_TENCENT_SECRET_ID: '腾讯云 Secret ID',
  NOVEL_SMS_TENCENT_SECRET_KEY: '腾讯云 Secret Key', NOVEL_SMS_TENCENT_SDK_APP_ID: '腾讯云短信应用 ID', NOVEL_SMS_TENCENT_SIGN_NAME: '腾讯云短信签名', NOVEL_SMS_TENCENT_TEMPLATE_ID: '腾讯云短信模板',
};
type Phase = 'pending' | 'error' | 'required' | 'ready' | 'restart';
export default function ServerInitGate({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return <ServerInitForm requestInit={initRequest} t={t} languageControl={<LanguageSwitcher />}>{children}</ServerInitForm>;
}

/** The demo injects every request and translation; it never mounts the persistent locale hook. */
export function ServerInitForm({ children, requestInit, t, languageControl, testMode = false, controls }: {
  children: ReactNode; requestInit: InitRequest; t: Translator; languageControl: ReactNode; testMode?: boolean; controls?: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>('pending');
  const [revision, setRevision] = useState(0);
  const [token, setToken] = useState(testMode ? 'init-test-dummy-token' : '');
  const [config, setConfig] = useState<InitConfig | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [database, setDatabase] = useState(initialDatabaseDraft);
  const [databaseTouched, setDatabaseTouched] = useState(false);
  const [username, setUsername] = useState('');
  const [phoneCode, setPhoneCode] = useState<InitPhoneCode>('+86');
  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const e164Phone = composeInitPhone(phoneCode, phone);
  const phoneInvalid = phoneTouched && !e164Phone;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'request' | 'uncertain' | 'invalid' | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const clearSecrets = () => { setToken(''); setPassword(''); setValues({}); setConfig(null); setDatabase(initialDatabaseDraft()); setDatabaseTouched(false); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setPhase('pending');
    void requestInit('status', { signal: controller.signal }).then(parseInitStatus).then((status) => {
      if (!current) return;
      if (status.restartRequired) { clearSecrets(); setPhase('restart'); }
      else if (status.required) setPhase('required');
      else { clearSecrets(); setPhase('ready'); }
    }).catch(() => { if (current) setPhase('error'); });
    return () => { current = false; controller.abort(); };
  }, [revision, requestInit]);
  async function loadConfig(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !token.trim()) return;
    lock.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); request.current = controller;
    try {
      const next = parseInitConfig(await requestInit('config', { token: token.trim(), signal: controller.signal }));
      if (alive.current) { setConfig(next); setValues(initialValues(next)); setDatabase(initialDatabaseDraft(next.database)); setDatabaseTouched(false); }
    } catch { if (alive.current) setError('request'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function complete(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !config || phase !== 'required' || error === 'uncertain') return;
    setDatabaseTouched(true);
    const submittedDatabase = databaseSubmission(database, config.database);
    if (!submittedDatabase) return;
    setPhoneTouched(true);
    if (!e164Phone) return;
    if (!validInitDraft(config, values, username, e164Phone, password)) { setError('invalid'); return; }
    lock.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); request.current = controller;
    try {
      const status = parseInitStatus(await requestInit('complete', { token: token.trim(), signal: controller.signal,
        body: { values: submissionValues(config, values), username, phone: e164Phone, password, database: submittedDatabase } }));
      if (!status.restartRequired) throw new Error('INIT_INVALID_RESPONSE');
      if (alive.current) { clearSecrets(); setPhase('restart'); }
    } catch (failure) { if (alive.current) setError(failure instanceof InitRequestError && failure.status >= 400 && failure.status < 500 ? 'request' : 'uncertain'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  if (phase === 'ready') return children;
  return <main className="server-init" data-testid="server-init-gate" aria-busy={busy || phase === 'pending'}>
    <section className="server-init__card" aria-labelledby="server-init-title">
      <header><h1 id="server-init-title">{t(testMode ? '初始化测试页（不生效）' : '服务器首次初始化')}</h1>{languageControl}</header>
      {controls}
      {phase === 'pending' && <p role="status">{t('正在检查初始化状态…')}</p>}
      {phase === 'error' && <p role="alert">{t('无法确认初始化状态；业务页面保持关闭。')}</p>}
      {phase === 'restart' && <div role="status" data-testid="init-restart-required"><h2 data-testid={testMode ? 'init-test-success' : undefined}>{t(testMode ? '模拟初始化成功；实际配置未生效。' : '初始化已保存，需要管理员重启服务。')}</h2><p>{t(testMode ? '未保存配置、未创建账号、未登录，也无需重启服务；可重置后再次测试。' : '不会自动登录或自动重启；重启后请刷新状态。')}</p><p>{t('SQL 未初始化、未激活；当前存储仍为本地 JSON。')}</p></div>}
      {phase === 'required' && <>
        <p>{t(testMode ? '下方仅为虚构的部分配置；缺失项留空，沿用正式表单验证。请勿输入真实密钥或密码。' : 'Docker 配置来自环境变量，不会访问 Docker socket；缺失项留空，请补充。')}</p>
        <p className="server-init__notice">{t('未配置 HTTPS origin 时，仅通过受控宿主机回环入口初始化；生产必须部署真实 HTTPS 代理并阻断后端直连。')}</p>
        <form onSubmit={loadConfig}>
          <label htmlFor="init-token">{t('初始化令牌')}</label>
          <input id="init-token" data-testid="init-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy} required onChange={(event) => { setToken(event.target.value); setConfig(null); setValues({}); }} aria-describedby="init-token-help" />
          <p id="init-token-help">{t(testMode ? '已预填虚构测试令牌 init-test-dummy-token；无需读取真实令牌。' : '从 DATA_DIR/.init-token 获取令牌；Docker 可通过 NOVEL_INIT_TOKEN 注入。')} {t('令牌仅保存在本页内存中，不会写入网址或浏览器存储。')}</p>
          <button type="submit" data-testid="init-load-config" disabled={busy || !token.trim()}>{t('读取初始化配置')}</button>
        </form>
        {config && <form onSubmit={complete} autoComplete="off">
          <fieldset disabled={busy}><legend>{t('初始化配置')}</legend>
            <p>{t('只需补齐所选短信供应商的配置。')}</p>
            {relevantFields(config, values).map((field) => <div className="server-init__field" key={field.key}>
              <label htmlFor={'init-field-' + field.key}>{fieldLabels[field.key] ? t(fieldLabels[field.key]) : field.key}</label>
              <code>{field.key}</code>
              <input id={'init-field-' + field.key} data-testid={'init-field-' + field.key} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} readOnly={field.readOnly} value={values[field.key] ?? ''} onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))} aria-describedby={'init-hint-' + field.key} />
              <small id={'init-hint-' + field.key}>{field.readOnly ? t('环境配置优先（只读）') : t('未配置，请添加')}{field.secret && field.configured ? ' · ' + t('已配置（秘密不回显）') : ''}</small>
            </div>)}
          </fieldset>
          <fieldset disabled={busy} className="server-init__database"><ServerInitDatabaseFields config={config.database} value={database} onChange={setDatabase} t={t} invalid={databaseTouched && !databaseSubmission(database, config.database)} /></fieldset>
          <fieldset disabled={busy}><legend>{t('首个超级管理员')}</legend>
            <label htmlFor="init-username">{t('管理员用户名')}</label><input id="init-username" data-testid="init-username" required autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor="init-phone-code">{t('国家/地区及区号')}</label>
            <select id="init-phone-code" data-testid="init-phone-code" value={phoneCode} onChange={(event) => setPhoneCode(event.target.value as InitPhoneCode)} aria-describedby="init-phone-help">
              <option value="+86">{t('中国大陆（+86）')}</option>
              <option value="+1">{t('北美编号计划（+1）')}</option>
            </select>
            <label htmlFor="init-phone">{t('管理员手机号（不含区号）')}</label>
            <input id="init-phone" data-testid="init-phone" type="tel" inputMode="numeric" aria-required="true" autoComplete="tel-national" placeholder={phoneCode === '+86' ? '13800138000' : '2025550123'} value={phone} onChange={(event) => setPhone(event.target.value)} onBlur={() => setPhoneTouched(true)} aria-invalid={phoneInvalid} aria-describedby={phoneInvalid ? 'init-phone-help init-phone-error' : 'init-phone-help'} />
            <small id="init-phone-help">{t('仅支持中国大陆手机（+86）和北美编号计划（+1）。只输入本地号码数字，不含区号、空格或横线；提交时自动合成 E.164。')}</small>
            {phoneInvalid && <p id="init-phone-error" role="alert">{t(phoneCode === '+86' ? '请输入 11 位中国大陆手机号，以 13–19 开头，例如 13800138000。' : '请输入 10 位北美号码，区号及交换码首位须为 2–9，例如 2025550123。')}</p>}
            <label htmlFor="init-password">{t('管理员密码')}</label><input id="init-password" data-testid="init-password" type="password" required minLength={15} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="init-password-help" /><small id="init-password-help">{t('密码至少 15 个字符；使用独立高强度密码。')}</small>
          </fieldset>
          <button type="submit" data-testid="init-complete" disabled={busy || error === 'uncertain'}>{t(busy ? '正在处理…' : '完成初始化')}</button>
        </form>}
        {error && <p role="alert">{t(error === 'uncertain' ? '提交结果未确认；请先刷新状态核对，不要重复提交。' : error === 'invalid' ? '请补齐必填项：精确 HTTPS 来源、两个不同且至少 32 字符的密钥、所选短信供应商配置及管理员账号。' : '初始化请求失败；请检查令牌、配置及连接后重试。')}</p>}
      </>}
      <button type="button" data-testid="init-refresh-status" disabled={busy || phase === 'pending'} onClick={() => { setError(null); setRevision((value) => value + 1); }}>{t('刷新初始化状态')}</button>
    </section>
  </main>;
}
