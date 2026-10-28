import { useLocale } from './useLocale';
import './language-switcher.scss';

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <label className={`language-switcher ${className}`.trim()}>
      <span className="language-switcher__label">{t('语言')}</span>
      <select aria-label={t('语言')} value={locale} onChange={(event) => setLocale(event.target.value)}>
        <option value="zh-CN" lang="zh-CN">
          中文
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}

export default LanguageSwitcher;
