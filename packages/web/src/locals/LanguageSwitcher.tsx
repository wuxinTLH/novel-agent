import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useLocale } from './useLocale';
import './language-switcher.scss';

const languages = [{ value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }] as const;

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const selected = Math.max(0, languages.findIndex(item => item.value === locale));
  useEffect(() => {
    if (!open) return;
    options.current[selected]?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, selected]);
  return (
    <div ref={root} className={`language-switcher ${className}`.trim()}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <span id={`${id}-label`} className="language-switcher__label">{t('语言')}</span>
      <button ref={trigger} id={`${id}-trigger`} type="button" className="language-switcher__trigger"
        aria-label={`${t('语言')}: ${languages[selected].label}`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
        }}>
        <span lang={locale}>{languages[selected].label}</span><ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && <div id={`${id}-menu`} role="menu" aria-labelledby={`${id}-label`} className="language-switcher__menu"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
          const index = options.current.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? languages.length - 1
            : event.key === 'ArrowDown' ? (index + 1) % languages.length
            : event.key === 'ArrowUp' ? (index - 1 + languages.length) % languages.length : -1;
          if (next >= 0) { event.preventDefault(); options.current[next]?.focus(); }
        }}>
        {languages.map((item, index) => <button key={item.value} type="button" role="menuitemradio"
          aria-checked={locale === item.value} lang={item.value} tabIndex={-1}
          ref={element => { options.current[index] = element; }}
          onClick={() => { setLocale(item.value); setOpen(false); trigger.current?.focus(); }}>
          <span>{item.label}</span><Check size={14} aria-hidden="true" className={locale === item.value ? '' : 'language-switcher__unchecked'} />
        </button>)}
      </div>}
    </div>
  );
}

export default LanguageSwitcher;
