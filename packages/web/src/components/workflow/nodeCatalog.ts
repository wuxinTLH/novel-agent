import { NODE_PRESETS } from '../../../../../shared/node-presets';
import { createTranslator, type TranslationKey } from '../../locals/core';
import { getLocale } from '../../locals/store';
export const NODE_CATEGORIES = [
  { title: '设定与人物', groups: [
    { title: '世界设定', kinds: ['world', 'expand'] },
    { title: '人物塑造', kinds: ['character'] },
  ] },
  { title: '剧情设计', groups: [
    { title: '情节推进', kinds: ['outline', 'conflict'] },
    { title: '悬念与回收', kinds: ['foreshadow', 'twist'] },
    { title: '高潮节拍', kinds: ['climax'] },
  ] },
  { title: '章节创作', groups: [
    { title: '规划与成稿', kinds: ['plan', 'writer'] },
    { title: '文本润色', kinds: ['dialogue', 'scene'] },
  ] },
  { title: '审校与扩展', groups: [
    { title: '质量检查', kinds: ['audit', 'continuity'] },
    { title: '自由扩展', kinds: ['custom'] },
  ] },
];

/** Unknown extension kinds remain selectable instead of silently disappearing. */
export function nodeCatalog(presets: Record<string, { title: string; subtitle: string }>, query = '', label = (text: string) => createTranslator(getLocale())(text as TranslationKey)) {
  const needle = query.trim().toLocaleLowerCase();
  const known = new Set(NODE_CATEGORIES.flatMap(category => category.groups.flatMap(group => group.kinds)));
  const categories = [...NODE_CATEGORIES, { title: '其他节点', groups: [{ title: '扩展节点', kinds: Object.keys(presets).filter(kind => !known.has(kind)) }] }];
  return categories.map(category => ({ ...category, groups: category.groups.map(group => ({ ...group,
    kinds: group.kinds.filter(kind => {
      const preset = presets[kind];
      return preset && (!needle || [kind, preset.title, preset.subtitle, presetDisplayLabel(kind, 'title', preset.title, label), presetDisplayLabel(kind, 'subtitle', preset.subtitle, label), label(category.title), label(group.title)]
        .some(text => text.toLocaleLowerCase().includes(needle)));
    }),
  })).filter(group => group.kinds.length) })).filter(category => category.groups.length);
}

const templateStepLabels: Record<string, { title: string; subtitle: string }> = {
  lore: { title: '世界观解析', subtitle: '连接每一条故事线索' },
  outline: { title: '剧情编排', subtitle: '让故事有迹可循' },
  plan: { title: '章节规划', subtitle: '把灵感拆解为章节' },
  draft: { title: '正文生成', subtitle: '从第一句，走进故事' },
  review: { title: '一致性审校', subtitle: '守住故事的每处细节' },
  'world-draft': { title: '自写节点', subtitle: '根据资料写出世界观初稿' },
  'world-expand': { title: '扩写节点', subtitle: '在初稿上补充细节与边界' },
  'character-draft': { title: '人物编写', subtitle: '建立鲜活可信的人物档案' },
};

/** Match canonical template id/kind plus exact default text; never rewrite saved data. */
export function stepDisplayLabel(step: { id: string; kind?: string; title: string; subtitle: string }, field: 'title' | 'subtitle', label: (key: string) => string): string {
  const value = step[field];
  const boundary = step.kind === 'start' ? { title: '开始编写', subtitle: '工作流入口' }
    : step.kind === 'end' ? { title: '编写结束', subtitle: '工作流出口' } : undefined;
  if ((boundary || templateStepLabels[step.id])?.[field] === value) return label(value);
  return presetDisplayLabel(step.kind || '', field, value, label);
}

/** Only recognized system workflow names are mapped for display, never persisted. */
export function workflowDisplayName(name: string, label: (key: string) => string): string {
  return ['默认工作流', '世界观编写', '人物编写'].includes(name) ? label(name) : name;
}

/** Translate only recognized built-in defaults; saved author text and prompts remain untouched. */
export function presetDisplayLabel(kind: string, field: 'title' | 'subtitle', value: string, label: (key: string) => string): string {
  return NODE_PRESETS[kind]?.[field] === value ? label(value) : value;
}
