import assert from 'node:assert/strict';
import test from 'node:test';
// The CLI deliberately stays plain ESM so it also runs without the tsx loader.
// @ts-expect-error JavaScript audit helper has no declaration file; tested below as a public interface.
import { auditCatalogs, auditRepository, auditSource } from '../../../../scripts/audit-locale.mjs';

const catalogs = {
  main: { zh: { '你好': '你好', '数量 {count}': '数量 {count}', English: 'English' },
    en: { '你好': 'Hello', '数量 {count}': 'Count {count}', English: 'English' } },
  runtime: { zh: { '失败': '失败' }, en: { '失败': 'Failed' } },
};
const categories = (report: { violations: { category: string }[] }) =>
  report.violations.map((item) => item.category);

test('AST guard rejects visible Han text, attributes, expressions and copy bypass', () => {
  const source = `const view = <><div title="标题" placeholder={'请输入'} aria-label={ok ? '打开' : '关闭'}
    alt={\`封面\`} description="描述" label="标签">可见中文{'直接中文'}{ok && '保存'}{t('你好')}</div>
    <Panel tooltip="工具提示" />{copy('中文', 'English')}</>;`;
  const report = auditSource(source, 'fixture.tsx', catalogs);
  assert.ok(categories(report).includes('jsx-text'));
  assert.ok(categories(report).includes('jsx-expression'));
  assert.equal(categories(report).filter((category: string) => category === 'jsx-visible-attribute').length, 8);
  assert.ok(categories(report).includes('copy-bypass'));
  assert.ok(!categories(report).includes('missing-translation-key'));
});

test('AppDialog hook bindings guard fixed option copy without treating business objects as dialogs', () => {
  const source = `import { useConfirm, useConfirm as useConfirmation } from '../common/AppDialog';
    const confirmDialog = useConfirm(); const confirm = useConfirm(); const showConfirmation = useConfirmation();
    confirmDialog('裸消息', { title: '裸标题', confirmText: ok ? '确认操作' : '重试', cancelText: '取消操作' });
    confirm(t('你好'), { title: t('你好'), confirmText: t('你好'), cancelText: t('你好') });
    showConfirmation(t('你好'), { title: \`裸标题模板\` });
    business.save({ title: '中文业务名称', confirmText: '中文业务字段' });
    unrelatedConfirm('中文业务参数', { title: '中文业务标题' });`;
  const report = auditSource(source, 'fixture.ts', catalogs);
  assert.equal(categories(report).filter((category: string) => category === 'dialog-message').length, 1);
  assert.equal(categories(report).filter((category: string) => category === 'dialog-visible-option').length, 5);
  assert.equal(report.violations.length, 6);
  assert.ok(report.review.some((item: { text: string }) => item.text === '中文业务名称'));
  const unrelated = auditSource(`import { useConfirm } from './business'; const confirm = useConfirm();
    confirm('业务数据', { title: '业务标题' });`, 'fixture.ts', catalogs);
  assert.deepEqual(unrelated.violations, []);
});

test('business enums, prompts, regex, comparisons and user data are review, not blanket errors', () => {
  const source = `type Kind = '玄幻'; const prompt = '请根据用户内容写作'; const pattern = /第[一二三]章/u;
    const view = <div>{record.title}{kind === '玄幻' ? record.content : userInput}</div>;
    const configuration = { label: '需人工判断的标签' };`;
  const report = auditSource(source, 'fixture.tsx', catalogs);
  assert.deepEqual(report.violations, []);
  for (const category of ['type-or-business-enum', 'regex', 'comparison-or-business-enum', 'data-or-display-config'])
    assert.ok(report.review.some((item: { category: string }) => item.category === category), category);
  assert.ok(report.review.some((item: { text: string }) => item.text === '请根据用户内容写作'));
});

test('checks all literal keys including non-Han keys and runtime catalog separately', () => {
  const report = auditSource(`t('不存在'); t('Missing English key'); t('English'); runtimeT('失败');
    t('失败'); t('数量 {count}', { count: 2 });`, 'fixture.ts', catalogs);
  assert.equal(categories(report).filter((category: string) => category === 'missing-translation-key').length, 3);
  assert.equal(report.translations.length, 6);
});

test('dynamic keys retain Han fragments for review; conditional keys and nested t are checked', () => {
  const report = auditSource("t(ok ? '你好' : '缺少'); t(`前缀${record.title}`); t(t('你好'));", 'fixture.ts', catalogs);
  assert.ok(categories(report).includes('missing-translation-key'));
  assert.ok(categories(report).includes('nested-translation-key'));
  assert.ok(report.review.some((item: { text: string }) => item.text === '前缀'));
  assert.ok(report.review.some((item: { text: string }) => item.text === '缺少'));
});

test('requires literal placeholder values but reports opaque/spread values for review', () => {
  const report = auditSource(`t('数量 {count}'); t('数量 {count}', {}); t('数量 {count}', { count });
    t('数量 {count}', values); t('数量 {count}', { ...values });`, 'fixture.ts', catalogs);
  assert.equal(categories(report).filter((category: string) => category === 'missing-interpolation-value').length, 2);
  assert.ok(report.review.some((item: { category: string }) => item.category === 'dynamic-interpolation-values'));
  assert.ok(report.review.some((item: { category: string }) => item.category === 'interpolation-values-spread'));
});

test('catalog guard enforces parity, English without Han and exact placeholder multiplicity', () => {
  const errors = auditCatalogs({ fixture: {
    zh: { missing: '缺少', han: '含中文', value: '{count} {count}', empty: '空' },
    en: { extra: 'Extra', han: 'English 中文', value: '{count}', empty: '' },
  } });
  for (const category of ['dictionary-key-parity', 'dictionary-english-han',
    'dictionary-placeholder-parity', 'dictionary-invalid-value'])
    assert.ok(errors.some((item: { category: string }) => item.category === category), category);
});

test('newlines never exempt source; AST diagnostics include current positions', () => {
  const first = auditSource('const view = <p>中文</p>;', 'fixture.tsx', catalogs);
  const moved = auditSource('\n\nconst view = <p>中文</p>;', 'fixture.tsx', catalogs);
  assert.equal(first.violations.length, moved.violations.length);
  assert.equal(moved.violations[0].line, first.violations[0].line + 2);
});

test('all frontend TS/TSX meets the static locale guard (supplementary, not full i18n proof)', () => {
  const report = auditRepository();
  assert.ok(report.files > 0, 'source traversal must not silently scan zero files');
  assert.ok(report.translations.length > 0, 'literal translation calls must be discovered');
  assert.deepEqual(report.violations, [],
    `Run node scripts/audit-locale.mjs for violations and classified manual-review inventory.\n${JSON.stringify(report.violations, null, 2)}`);
});
