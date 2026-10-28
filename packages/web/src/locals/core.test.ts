import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOCALE,
  createTranslator,
  dictionaries,
  interpolate,
  normalizeLocale,
  translate,
} from './core';
import { LOCALE_STORAGE_KEY, createLocaleStore } from './store';

test('Chinese and English catalogs match exactly; default is Chinese', () => {
  assert.equal(DEFAULT_LOCALE, 'zh-CN');
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries['zh-CN']).sort());
  for (const [key, value] of Object.entries(dictionaries['zh-CN'])) assert.equal(key, value);
  for (const value of Object.values(dictionaries.en)) assert.ok(value.length > 0);
});

test('normalizes browser language tags conservatively', () => {
  for (const value of ['en', 'EN', 'en-US', 'en_GB', ' EN-AU ']) assert.equal(normalizeLocale(value), 'en');
  for (const value of ['zh', 'zh-CN', 'zh-Hant-TW', 'fr-FR', '', 'english', 'en--US', null, undefined, 42])
    assert.equal(normalizeLocale(value), 'zh-CN');
});

test('interpolates named values without misinterpreting literal replacement text', () => {
  assert.equal(translate('en-US', '你好，{name}', { name: '$& {other}' }), 'Hello, $& {other}');
  assert.equal(translate('zh-CN', '你好，{name}', { name: '小明' }), '你好，小明');
  assert.equal(interpolate('Item {count}, {missing}', { count: 0 }), 'Item 0, {missing}');
  assert.equal(createTranslator('en')('已启用 {count}/5 项', { count: 2 }), '2/5 features enabled');
});

test('falls back to Chinese for missing English keys, then raw unknown phrases', () => {
  assert.equal(translate('en', '账户功能配置', undefined, {}), '账户功能配置');
  assert.equal(translate('en', '未登记的文案 {name}', { name: '甲' }), '未登记的文案 甲');
  assert.equal(translate('en', '账户功能配置'), 'Account feature configuration');
  assert.equal(translate('en', '__proto__'), '__proto__');
});

test('locale store persists, notifies, syncs html.lang and survives storage denial', () => {
  const saved = new Map<string, string>();
  const html = { lang: 'zh-CN' };
  const handlers = new Map<string, (event: { key: string | null; storageArea?: unknown }) => void>();
  const storage = {
    getItem(key: string) {
      return saved.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      saved.set(key, value);
    },
  };
  const browser = {
    document: { documentElement: html },
    localStorage: storage,
    addEventListener(name: string, handler: (event: { key: string | null; storageArea?: unknown }) => void) {
      handlers.set(name, handler);
    },
    removeEventListener(name: string) {
      handlers.delete(name);
    },
  };
  const store = createLocaleStore(() => browser as unknown as Window);
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  assert.equal(store.getSnapshot(), 'zh-CN');
  store.setLocale('en-US');
  assert.equal(saved.get(LOCALE_STORAGE_KEY), 'en');
  assert.equal(html.lang, 'en');
  assert.equal(calls, 1);
  store.setLocale('en');
  assert.equal(calls, 1);
  saved.set(LOCALE_STORAGE_KEY, 'zh-TW');
  handlers.get('storage')?.({ key: LOCALE_STORAGE_KEY, storageArea: storage });
  assert.equal(store.getSnapshot(), 'zh-CN');
  assert.equal(calls, 2);
  unsubscribe();
  assert.equal(handlers.size, 0);
  const denied = createLocaleStore(
    () =>
      ({
        document: { documentElement: html },
        get localStorage() {
          throw Error('blocked');
        },
      }) as unknown as Window,
  );
  denied.setLocale('en');
  assert.equal(denied.getSnapshot(), 'en');
  assert.equal(html.lang, 'en');
  const writesDenied = createLocaleStore(
    () =>
      ({
        ...browser,
        localStorage: {
          getItem() {
            return null;
          },
          setItem() {
            throw Error('quota');
          },
        },
      }) as unknown as Window,
  );
  writesDenied.setLocale('en');
  const stop = writesDenied.subscribe(() => {});
  assert.equal(writesDenied.getSnapshot(), 'en');
  stop();
  const persisted = createLocaleStore(
    () =>
      ({
        ...browser,
        localStorage: {
          getItem() {
            return 'en_GB';
          },
        },
      }) as unknown as Window,
  );
  assert.equal(persisted.getSnapshot(), 'en');
  assert.equal(html.lang, 'en');
  const ssr = createLocaleStore(() => undefined);
  assert.equal(ssr.getSnapshot(), 'zh-CN');
  ssr.setLocale('en');
  assert.equal(ssr.getSnapshot(), 'en');
});
