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
export function nodeCatalog(presets: Record<string, { title: string; subtitle: string }>, query = '', label = (text: string) => text) {
  const needle = query.trim().toLocaleLowerCase();
  const known = new Set(NODE_CATEGORIES.flatMap(category => category.groups.flatMap(group => group.kinds)));
  const categories = [...NODE_CATEGORIES, { title: '其他节点', groups: [{ title: '扩展节点', kinds: Object.keys(presets).filter(kind => !known.has(kind)) }] }];
  return categories.map(category => ({ ...category, groups: category.groups.map(group => ({ ...group,
    kinds: group.kinds.filter(kind => {
      const preset = presets[kind];
      return preset && (!needle || [kind, preset.title, preset.subtitle, label(preset.title), label(preset.subtitle), label(category.title), label(group.title)]
        .some(text => text.toLocaleLowerCase().includes(needle)));
    }),
  })).filter(group => group.kinds.length) })).filter(category => category.groups.length);
}
