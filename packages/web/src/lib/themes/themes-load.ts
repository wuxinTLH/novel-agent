export interface RegisteredTheme {
  id: string;
  name: string;
  css: string;
}
export interface ThemeRegistry {
  version: 1;
  defaultTheme: string;
  themes: RegisteredTheme[];
}
const themeId = /^theme-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The registry is data, never executable code or an arbitrary remote stylesheet URL. */
export function parseThemeRegistry(value: unknown): ThemeRegistry {
  if (!value || typeof value !== 'object') throw new Error('主题注册表格式无效');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.themes) || !input.themes.length || input.themes.length > 100) {
    throw new Error('主题注册表版本或主题数量无效');
  }
  const ids = new Set<string>();
  const themes = input.themes.map((entry: unknown): RegisteredTheme => {
    if (!entry || typeof entry !== 'object') throw new Error('主题注册项无效');
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || !themeId.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
      || typeof item.css !== 'string' || !/^theme-[a-z0-9]+(?:-[a-z0-9]+)*\.css$/.test(item.css)) {
      throw new Error('主题标识、名称或本地 CSS 路径无效（标识须为 theme-xxx 且不可重复）');
    }
    ids.add(item.id);
    return { id: item.id, name: item.name.trim(), css: item.css };
  });
  if (typeof input.defaultTheme !== 'string' || !ids.has(input.defaultTheme)) throw new Error('默认主题未注册');
  return { version: 1, defaultTheme: input.defaultTheme, themes };
}

/** Reloadable at runtime: public/themes is copied unchanged into the production build. */
export async function themesLoad(fetcher: typeof fetch = fetch): Promise<ThemeRegistry> {
  const response = await fetcher('/themes/themes.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取主题注册表失败（${response.status}）`);
  return parseThemeRegistry(await response.json());
}

export function resolveTheme(registry: ThemeRegistry, saved: string | null): RegisteredTheme {
  const legacy = saved && !saved.startsWith('theme-') ? `theme-${saved}` : saved;
  return registry.themes.find((theme) => theme.id === legacy)
    ?? registry.themes.find((theme) => theme.id === registry.defaultTheme)!;
}

export type InstallTheme = (theme: RegisteredTheme) => Promise<() => void>;
export function installThemeStyles(theme: RegisteredTheme): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/themes/${theme.css}`;
    const timer = window.setTimeout(() => fail(), 10000);
    const clear = () => { window.clearTimeout(timer); link.onload = null; link.onerror = null; };
    const fail = () => { clear(); link.remove(); reject(new Error(`主题「${theme.name}」样式加载失败`)); };
    link.onerror = fail;
    link.onload = () => { clear(); resolve(() => link.remove()); };
    document.head.append(link);
  });
}

/** Commit only fully loaded resources; stale requests cannot undo a newer selection. */
export class ThemeLoader {
  private generation = 0;
  private removeCurrent?: () => void;
  constructor(private install: InstallTheme = installThemeStyles) {}
  async select(theme: RegisteredTheme, commit: (theme: RegisteredTheme) => void): Promise<boolean> {
    const generation = ++this.generation;
    let remove: () => void;
    try { remove = await this.install(theme); }
    catch (error) { if (generation !== this.generation) return false; throw error; }
    if (generation !== this.generation) { remove(); return false; }
    commit(theme);
    this.removeCurrent?.();
    this.removeCurrent = remove;
    return true;
  }
  dispose() { ++this.generation; this.removeCurrent?.(); this.removeCurrent = undefined; }
}
