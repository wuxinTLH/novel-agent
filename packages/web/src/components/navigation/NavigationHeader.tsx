import type { ReactNode } from 'react';
import { CircleHelp, Settings2 } from 'lucide-react';
import { LanguageSwitcher, useLocale } from '../../locals';
import type { NavigationStyle } from '../../../../../shared/site-appearance';
import { isNavigationStyle, navigationStyleVariables } from './siteAppearance';
import { useSiteAppearance } from './useSiteAppearance';

export type NavigationHeaderProps = {
  breadcrumbs: ReactNode;
  themeControl?: ReactNode;
  actions?: ReactNode;
  running?: boolean;
  avatarUrl?: string;
  onSettings: () => void;
  onHelp: () => void;
  onProfile: () => void;
  appearance?: NavigationStyle;
};
/** Shared shell controls; navigation callbacks remain owned by the workspace draft guard. */
export default function NavigationHeader({ breadcrumbs, themeControl, actions, running, avatarUrl, onSettings, onHelp, onProfile, appearance }: NavigationHeaderProps) {
  const { t } = useLocale();
  const site = useSiteAppearance();
  const candidate = appearance ?? site?.header;
  const style = isNavigationStyle(candidate) ? candidate : undefined;
  return (
    <header className="topbar navigation-header" data-custom-background={!!style?.backgroundColor} data-custom-border={!!style?.borderColor} style={navigationStyleVariables(style)}>
      <nav className="breadcrumbs" aria-label={t('当前位置')}>{breadcrumbs}</nav>
      <div className="topbar-right">
        <LanguageSwitcher />
        {themeControl}
        <button type="button" className="icon-button quick-settings" aria-label={t('模型设置')} onClick={onSettings}>
          <Settings2 size={18} />
        </button>
        <span className="save-indicator"><span className="green-dot" />{running ? t('工作流运行中') : t('已保存至本地')}</span>
        <button type="button" className="icon-button help-trigger" aria-label={t('使用指南')} aria-haspopup="dialog" onClick={event => { event.preventDefault(); event.stopPropagation(); onHelp(); }}>
          <CircleHelp size={18} />
        </button>
        <button type="button" className="top-avatar-button" aria-label={t('自定义本地头像')} aria-haspopup="dialog" onClick={event => { event.preventDefault(); event.stopPropagation(); onProfile(); }}>
          {avatarUrl ? <img className="top-avatar" src={avatarUrl} alt={t('本地头像')} /> : <span className="top-avatar">N</span>}
        </button>
        {actions}
      </div>
    </header>
  );
}
