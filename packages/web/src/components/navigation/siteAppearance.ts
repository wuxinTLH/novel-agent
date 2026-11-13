import type { CSSProperties } from 'react';
import type { NavigationStyle, SiteAppearance } from '../../../../../shared/site-appearance';

export const inheritedNavigationStyle: NavigationStyle = {
  backgroundColor: '', textColor: '', accentColor: '', borderColor: '', fontSize: 14, paddingY: 16,
};
export const fallbackAppearance: SiteAppearance = {
  version: 1, revision: 0, companyName: '',
  header: { ...inheritedNavigationStyle }, footer: { ...inheritedNavigationStyle },
};
const colors = ['backgroundColor', 'textColor', 'accentColor', 'borderColor'] as const;
export function isNavigationStyle(value: unknown): value is NavigationStyle {
  if (!value || typeof value !== 'object') return false;
  const style = value as Record<string, unknown>;
  return colors.every(key => typeof style[key] === 'string' && (style[key] === '' || /^#[\da-f]{6}$/i.test(style[key] as string))) &&
    typeof style.fontSize === 'number' && Number.isInteger(style.fontSize) && style.fontSize >= 12 && style.fontSize <= 24 &&
    typeof style.paddingY === 'number' && Number.isInteger(style.paddingY) && style.paddingY >= 0 && style.paddingY <= 32;
}
export function isSiteAppearance(value: unknown): value is SiteAppearance {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && Number.isSafeInteger(item.revision) && (item.revision as number) >= 0 &&
    typeof item.companyName === 'string' && item.companyName.length <= 120 &&
    isNavigationStyle(item.header) && isNavigationStyle(item.footer);
}
/** Only allowlisted, validated scalar values become CSS variables; never spread server properties. */
export function navigationStyleVariables(style?: NavigationStyle): CSSProperties {
  if (!isNavigationStyle(style)) return {};
  return {
    '--navigation-background': style.backgroundColor || 'var(--panel)',
    '--navigation-text': style.textColor || 'var(--text)',
    '--navigation-accent': style.accentColor || 'var(--accent)',
    '--navigation-border': style.borderColor || 'var(--border)',
    '--navigation-font-size': `${style.fontSize}px`,
    '--navigation-padding-y': `${style.paddingY}px`,
  } as CSSProperties;
}
