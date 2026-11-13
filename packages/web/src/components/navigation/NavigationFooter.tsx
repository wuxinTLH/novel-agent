import type { SiteAppearance } from '../../../../../shared/site-appearance';
import { navigationStyleVariables } from './siteAppearance';
import { useSiteAppearance } from './useSiteAppearance';

export default function NavigationFooter({ appearance }: { appearance?: SiteAppearance }) {
  const site = useSiteAppearance();
  const value = appearance ?? site;
  return (
    <footer className="navigation-footer" style={navigationStyleVariables(value?.footer)}>
      <a href="https://github.com/wuxinTLH/novel-agent" target="_blank" rel="noopener noreferrer">© SakuraMikku</a>
      {value?.companyName.trim() && <span className="navigation-company">© {value.companyName}</span>}
    </footer>
  );
}
