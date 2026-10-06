import { randomUUID } from 'node:crypto';
import {
  SYSTEM_END_NODE_ID,
  SYSTEM_START_NODE_ID,
  stepIds,
  type Project,
  type Step,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowSettings,
} from '../shared/types.js';
const LEGACY_PROMPTS = {
  plan: '结合整体大纲、章节设定和已有章节，为下一章生成详细写作计划：章节标题、视角人物、场景、事件节拍、冲突、情绪变化、结尾悬念。避免重复已写的剧情。',
  draft:
    '根据上游规划与用户资料，创作下一章完整小说正文，约 1500–2500 中文字。以具体行动、细节和对白推动剧情，保持人物与世界规则一致。第一行写章节标题，其后直接输出正文，不要解释创作过程。',
  review:
    '对生成的章节进行审校。检查人物行为、地理关系、时间线、世界规则、伏笔与语言。引用具体原文并给出修改建议；区分确定冲突和待确认设定，不要编造问题。',
};
const CURRENT_PROMPTS = {
  plan: '结合整体大纲、章节设定和目标章节之前的正文，为当前目标章节生成详细写作计划：章节标题、视角人物、场景、事件节拍、冲突、情绪变化、结尾悬念。遵循本章有效创作要求，避免重复已写的剧情。',
  draft:
    '根据上游规划与用户资料，创作当前目标章节完整小说正文，约 1500–2500 中文字。将有效创作要求融入故事，必须文本应原文出现，禁止文本不得出现，不得用检查清单代替正文。以具体行动、细节和对白推动剧情，保持人物与世界规则一致。第一行写章节标题，其后直接输出正文，不要解释创作过程。',
  review:
    '对当前目标章节的最终正文进行审校。检查人物行为、地理关系、时间线、世界规则、伏笔与语言，并逐项检查有效创作要求。引用具体原文作为证据，列出缺口与修改建议；区分确定冲突和待确认设定，不要编造问题。语义与风格符合性仍须作者确认，不代表自动批准。',
};
export function migrateDefaultPrompts(steps: Step[]) {
  for (const step of steps) {
    for (const id of ['plan', 'draft', 'review'] as const) {
      if (step.id === id && step.prompt === LEGACY_PROMPTS[id]) step.prompt = CURRENT_PROMPTS[id];
    }
  }
}
export function createSteps(): Step[] {
  return [
    {
      id: 'lore',
      title: '世界观解析',
      subtitle: '连接每一条故事线索',
      prompt:
        '整理资料中的地理、时代、规则与人物关系，建立统一的故事设定。列出不可违背的事实，以及需要作者补充的设定。',
    },
    {
      id: 'outline',
      title: '剧情编排',
      subtitle: '让故事有迹可循',
      prompt:
        '根据世界观和用户的剧情走向，规划三幕式故事大纲。包含核心冲突、人物弧光、关键转折与伏笔回收，尊重已有设定。',
    },
    {
      id: 'plan',
      title: '章节规划',
      subtitle: '把灵感拆解为章节',
      prompt: CURRENT_PROMPTS.plan,
    },
    {
      id: 'draft',
      title: '正文生成',
      subtitle: '从第一句，走进故事',
      prompt: CURRENT_PROMPTS.draft,
    },
    {
      id: 'review',
      title: '一致性审校',
      subtitle: '守住故事的每处细节',
      prompt: CURRENT_PROMPTS.review,
    },
  ].map((s, i) => ({
    ...s,
    id: s.id as Step['id'],
    status: 'idle',
    output: '',
    position: { x: 60 + (i % 3) * 295, y: i < 3 ? 75 : 310 },
    kind: s.id === 'draft' ? 'writer' : s.id === 'review' ? 'audit' : 'agent',
    enabled: true,
  }));
}
export function createWorkflow(edges?: WorkflowEdge[], name = '默认工作流'): WorkflowSettings {
  const usingTemplate = edges === undefined;
  return {
    id: randomUUID(),
    name,
    edges: usingTemplate ? stepIdsToEdges() : edges,
    startNodeId: SYSTEM_START_NODE_ID,
    endNodeId: SYSTEM_END_NODE_ID,
    auditNodeId: 'review',
    chapterCount: 1,
    autoGenerate: false,
    autoPublish: false,
    graphRevision: 0,
  };
}
const WORLD_PROMPTS = {
  draft:
    '根据作者资料直接撰写一份世界观初稿。只写已有资料支持的地理、时代、规则、势力与人物关系；缺失内容明确标出，不要规划章节，不要创作小说正文。',
  expand:
    '在上游世界观初稿上扩写细节、关系与边界。保留已确认事实，把新增内容与待确认问题分开；不要规划章节，不要创作小说正文。',
};
export function createWorldSteps(): Step[] {
  return (
    [
      ['world-draft', '自写节点', '根据资料写出世界观初稿', WORLD_PROMPTS.draft, 'world'],
      ['world-expand', '扩写节点', '在初稿上补充细节与边界', WORLD_PROMPTS.expand, 'expand'],
    ] as const
  ).map(([id, title, subtitle, prompt, kind], index) => ({
    id,
    title,
    subtitle,
    prompt,
    status: 'idle' as const,
    output: '',
    position: { x: 250 + index * 280, y: 170 },
    kind,
    enabled: true,
  }));
}
export function createWorldWorkflowGraph(name = '世界观编写'): WorkflowGraph {
  const now = new Date().toISOString();
  const steps = [createSystemStep('start'), ...createWorldSteps(), createSystemStep('end')];
  const workflow = createWorkflow([], name);
  workflow.edges = linearEdges(steps.map((step) => step.id));
  workflow.auditNodeId = undefined;
  workflow.outputWriterNodeId = undefined;
  workflow.autoGenerate = false;
  workflow.chapterCount = 1;
  workflow.outputName = '';
  return { id: workflow.id!, name, steps, workflow, createdAt: now, updatedAt: now };
}
export function createWorkflowGraph(name = '默认工作流', template = false): WorkflowGraph {
  const now = new Date().toISOString();
  const steps = template
    ? [createSystemStep('start'), ...createSteps(), createSystemStep('end')]
    : createBoundarySteps();
  const workflow = createWorkflow(template ? undefined : [], name);
  workflow.startNodeId = SYSTEM_START_NODE_ID;
  workflow.endNodeId = SYSTEM_END_NODE_ID;
  workflow.auditNodeId = template ? 'review' : undefined;
  workflow.edges = template ? linearEdges(steps.map((step) => step.id)) : boundaryEdges();
  return { id: workflow.id!, name, steps, workflow, createdAt: now, updatedAt: now };
}
export function syncActiveWorkflow(p: Project) {
  const graphs = (p.workflows ||= []);
  if (!graphs.length) {
    const workflow = p.workflow || createWorkflow();
    graphs.push({
      id: workflow.id || randomUUID(),
      name: workflow.name || '默认工作流',
      steps: p.steps,
      workflow,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }
  const current = graphs.find((g) => g.id === p.activeWorkflowId);
  if (current) {
    current.steps = p.steps;
    current.workflow = p.workflow || current.workflow;
    current.updatedAt = p.updatedAt;
  }
  const active = graphs.find((g) => g.id === p.activeWorkflowId) || graphs[0];
  p.activeWorkflowId = active.id;
  p.steps = active.steps;
  p.workflow = active.workflow;
  p.workflow.id = active.id;
  p.workflow.name = active.name;
  normalizeWorkflow(p);
  active.steps = p.steps;
  active.workflow = p.workflow;
  active.updatedAt = p.updatedAt;
}
export function normalizeWorkflow(p: Project) {
  const legacyStart = p.steps.find((step) => /^boundary-start-\d+$/.test(step.id));
  const legacyEnd = p.steps.find((step) => /^boundary-end-\d+$/.test(step.id));
  const start = legacyStart
    ? { ...legacyStart, id: SYSTEM_START_NODE_ID }
    : p.steps.find((step) => step.id === SYSTEM_START_NODE_ID) || createSystemStep('start');
  const end = legacyEnd
    ? { ...legacyEnd, id: SYSTEM_END_NODE_ID }
    : p.steps.find((step) => step.id === SYSTEM_END_NODE_ID) || createSystemStep('end');
  const ordinary = p.steps.filter((step) => !isSystemStep(step));
  start.title = '开始编写';
  start.subtitle = '工作流入口';
  start.kind = 'start';
  start.enabled = true;
  end.id = SYSTEM_END_NODE_ID;
  end.title = '编写结束';
  end.subtitle = '工作流出口';
  end.kind = 'end';
  end.enabled = true;
  p.steps = [start, ...ordinary.filter((step) => step.id !== start.id && step.id !== end.id), end];
  const ids = new Set(p.steps.map((s) => s.id));
  const workflow = (p.workflow ||= {
    id: p.activeWorkflowId || randomUUID(),
    name: '默认工作流',
    edges: [],
    chapterCount: 1,
    autoGenerate: false,
  });
  const canonicalId = (id: string) =>
    id === legacyStart?.id ? SYSTEM_START_NODE_ID : id === legacyEnd?.id ? SYSTEM_END_NODE_ID : id;
  workflow.edges = (workflow.edges || [])
    .map((edge) => ({ ...edge, source: canonicalId(edge.source), target: canonicalId(edge.target) }))
    .filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        edge.source !== SYSTEM_END_NODE_ID &&
        edge.target !== SYSTEM_START_NODE_ID,
    );
  workflow.startNodeId = SYSTEM_START_NODE_ID;
  workflow.endNodeId = SYSTEM_END_NODE_ID;
  const ordinaryIds = p.steps.slice(1, -1).map((step) => step.id);
  if (!ordinaryIds.length) {
    workflow.edges = boundaryEdges();
  } else {
    workflow.edges = workflow.edges.filter(
      (edge) => !(edge.source === SYSTEM_START_NODE_ID && edge.target === SYSTEM_END_NODE_ID),
    );
    if (!workflow.edges.some((edge) => edge.source === SYSTEM_START_NODE_ID))
      workflow.edges.unshift({
        id: `e-${SYSTEM_START_NODE_ID}`,
        source: SYSTEM_START_NODE_ID,
        target: ordinaryIds[0],
      });
    if (!workflow.edges.some((edge) => edge.target === SYSTEM_END_NODE_ID))
      workflow.edges.push({
        id: `e-${SYSTEM_END_NODE_ID}`,
        source: ordinaryIds.at(-1)!,
        target: SYSTEM_END_NODE_ID,
      });
  }
  workflow.chapterCount ||= 1;
  workflow.autoGenerate ??= false;
  workflow.autoPublish = false;
  workflow.graphRevision ??= 0;
  migrateDefaultPrompts(p.steps);
}
function isSystemStep(step: Step) {
  return (
    step.id === SYSTEM_START_NODE_ID ||
    step.id === SYSTEM_END_NODE_ID ||
    /^boundary-(start|end)-\d+$/.test(step.id)
  );
}
function createSystemStep(role: 'start' | 'end'): Step {
  return {
    id: role === 'start' ? SYSTEM_START_NODE_ID : SYSTEM_END_NODE_ID,
    title: role === 'start' ? '开始编写' : '编写结束',
    subtitle: role === 'start' ? '工作流入口' : '工作流出口',
    prompt: '',
    status: 'idle',
    output: '',
    position: role === 'start' ? { x: 30, y: 170 } : { x: 720, y: 170 },
    kind: role,
    enabled: true,
  };
}
function boundaryEdges(): WorkflowEdge[] {
  return [{ id: 'e-system-boundary', source: SYSTEM_START_NODE_ID, target: SYSTEM_END_NODE_ID }];
}
function linearEdges(ids: string[]): WorkflowEdge[] {
  return ids.slice(1).map((target, index) => ({ id: `e-${target}`, source: ids[index], target }));
}

function createBoundarySteps(): Step[] {
  return [createSystemStep('start'), createSystemStep('end')];
}

function stepIdsToEdges(): WorkflowEdge[] {
  return ['lore', 'outline', 'plan', 'draft', 'review'].slice(1).map((target, i) => ({
    id: `e-${target}`,
    source: ['lore', 'outline', 'plan', 'draft'][i],
    target,
  }));
}
export function createProject(title: string, genre = '奇幻小说', description = ''): Project {
  const now = new Date().toISOString();
  const graph = createWorkflowGraph('默认工作流', true);
  return {
    id: randomUUID(),
    title,
    genre,
    description,
    createdAt: now,
    updatedAt: now,
    assets: [],
    steps: graph.steps,
    chapters: [],
    workflow: graph.workflow,
    workflows: [graph],
    activeWorkflowId: graph.id,
    requirements: { instructions: '', requiredText: [], forbiddenText: [] },
    chapterRequirements: {},
    chapterNumberHighWatermark: 0,
    candidates: [],
    dataVersion: 1,
  };
}
export function starterProject(): Project {
  const p = createProject('雾海来信', '东方幻想', '当潮汐抹去记忆，一封来自旧世界的信，唤醒了整片雾海。');
  p.assets = [
    {
      category: 'world',
      name: '雾海 · 世界观.md',
      content:
        '世界由被雾海隔开的七座岛屿组成。每逢大潮，靠近海岸的人会失去一段记忆。唯一能保存记忆的是用深海墨水书写的信。北方的白塔掌管航路，南方的沉钟港聚集着走私者。航行必须借助鸣石定位，禁止使用现代科技。',
    },
    {
      category: 'characters',
      name: '主要人物档案.md',
      content:
        '沈砚：22 岁，沉钟港的修信师，寡言，观察敏锐。寻找在五年前大潮中失踪的姐姐沈汐。他的右手遇到深海墨水会隐隐发冷。\n叶灯：24 岁，白塔出逃的领航员，擅长听辨鸣石。表面散漫，实际对失误十分苛刻。她知道沈汐仍然活着，但不能直接说出。',
    },
    {
      category: 'plot',
      name: '故事主线.md',
      content:
        '沈砚收到姐姐寄来的空白信件，在盐水中显出一条被抹去的航路。他与叶灯合作离开沉钟港，逐步发现大潮不是自然现象。核心主题：记忆的代价与重新选择的勇气。前期不要揭露白塔制造大潮的真相。',
    },
    {
      category: 'chapters',
      name: '第一章 · 写作简报.md',
      content:
        '第一章：不该抵达的信。视角：沈砚。地点：沉钟港修信铺。以暴雨夜收到一封已经被海水浸透的信开场；通过修复信件展示深海墨水的规则；叶灯在章末出现。氛围克制、潮湿、有悬疑感，避免大段说明世界观。',
    },
  ].map((a) => ({
    ...a,
    category: a.category as Project['assets'][number]['category'],
    id: randomUUID(),
    size: Buffer.byteLength(a.content),
    createdAt: p.createdAt,
    mime: 'text/markdown',
  }));
  return p;
}
