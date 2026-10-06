import { useConfirm } from './components/AppDialog';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node as FlowNode,
  type Edge,
  type NodeProps,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import {
  ArrowDownToLine,
  ArrowRight,
  Link2,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FolderOpen,
  GitBranch,
  Globe2,
  Layers3,
  LoaderCircle,
  Map,
  MoreHorizontal,
  Network,
  PanelRightClose,
  Play,
  Plus,
  Redo2,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  UsersRound,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiError, download } from './api';
import PlatformPanel from './PlatformPanel';
import GenerationModal, { type GenerationEntry } from './components/GenerationModal';
import GenerationCandidates from './components/GenerationCandidates';
import GenerationProgress from './components/GenerationProgress';
import Modal from './components/Modal';
import AddNodeDialog from './components/AddNodeDialog';
import ErrorBanner, { errorMessage } from './components/ErrorBanner';
import { useChapterEditor } from './hooks/useChapterEditor';
import {
  canApplyProject,
  filterAssets,
  graphSnapshot,
  nextChapterNumber,
  projectIdentity,
  sortedChapters,
  workflowIdOf,
  type GraphSnapshot,
} from './hooks/generationState';
import { GENERATION_LIMITS } from '../shared/generation';
import { IMAGE_ASSET_MAX_BYTES, TEXT_ASSET_MAX_BYTES } from '../shared/limits';
import {
  categories,
  categoryLabels,
  type Asset,
  type Category,
  type Chapter,
  type ModelSettings,
  type ModelProtocol,
  type Project,
  type Step,
  type StepId,
  protocolLabels,
  type Run,
  type RunRequest,
  type ChapterCandidate,
} from '../shared/types';
type Page = 'workflow' | 'assets' | 'chapters' | 'platforms' | 'settings';
type PendingRunSubmission = { key: string; request: RunRequest; requestHash: string };
const pendingRunMemory = new globalThis.Map<string, PendingRunSubmission>();
function runSubmissionStorageKey(projectId: string) {
  return `novel-run-submission:${projectId}`;
}
function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function readPendingRunSubmission(projectId: string): PendingRunSubmission | undefined {
  const remembered = pendingRunMemory.get(projectId);
  if (remembered) return remembered;
  try {
    const raw = sessionStorage.getItem(runSubmissionStorageKey(projectId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingRunSubmission>;
    return typeof value.key === 'string' && !!value.request && typeof value.requestHash === 'string'
      ? (value as PendingRunSubmission)
      : undefined;
  } catch {
    return undefined;
  }
}
function writePendingRunSubmission(projectId: string, value: PendingRunSubmission) {
  pendingRunMemory.set(projectId, value);
  try {
    sessionStorage.setItem(runSubmissionStorageKey(projectId), JSON.stringify(value));
  } catch {
    /* best effort */
  }
}
function clearPendingRunSubmission(projectId: string) {
  pendingRunMemory.delete(projectId);
  try {
    sessionStorage.removeItem(runSubmissionStorageKey(projectId));
  } catch {
    /* best effort */
  }
}

const icons: Partial<Record<StepId, LucideIcon>> = {
  lore: Globe2,
  outline: GitBranch,
  plan: Layers3,
  draft: WandSparkles,
  review: ShieldCheck,
};
const kindIcons: Partial<Record<NonNullable<Step['kind']>, LucideIcon>> = {
  world: Globe2,
  outline: GitBranch,
  plan: Layers3,
  writer: WandSparkles,
  audit: ShieldCheck,
};
const nodePresets: Record<string, { title: string; subtitle: string; prompt: string }> = {
  world: {
    title: '世界观解析',
    subtitle: '连接每一条故事线索',
    prompt:
      '整理资料中的地理、时代、规则与人物关系，建立统一的故事设定。列出不可违背的事实，以及需要作者补充的设定。',
  },
  outline: {
    title: '剧情编排',
    subtitle: '让故事有迹可循',
    prompt:
      '根据世界观和用户的剧情走向，规划三幕式故事大纲。包含核心冲突、人物弧光、关键转折与伏笔回收，尊重已有设定。',
  },
  plan: {
    title: '章节规划',
    subtitle: '把灵感拆解为章节',
    prompt:
      '结合整体大纲、章节设定和已有章节，为当前目标章节生成详细写作计划：章节标题、视角人物、场景、事件节拍、冲突、情绪变化、结尾悬念。避免重复已写的剧情。',
  },
  writer: {
    title: '正文生成',
    subtitle: '从第一句，走进故事',
    prompt:
      '根据上游规划与用户资料，创作当前目标章节的完整小说正文，约 1500–2500 中文字。以具体行动、细节和对白推动剧情，保持人物与世界规则一致。第一行写章节标题，其后直接输出正文，不要解释创作过程。',
  },
  audit: {
    title: '一致性审校',
    subtitle: '守住故事的每处细节',
    prompt:
      '对生成的章节进行审校。检查人物行为、地理关系、时间线、世界规则、伏笔与语言。引用具体原文并给出修改建议；区分确定冲突和待确认设定，不要编造问题。',
  },
  custom: {
    title: '',
    subtitle: '自定义创作节点',
    prompt: '根据输入上下文完成创作任务。',
  },
  character: {
    title: '人物塑造',
    subtitle: '让角色有动机与变化',
    prompt:
      '根据题材、简介和已有设定，整理主要人物的目标、阻碍、关系、语言习惯与人物弧光。只写资料支持的内容，缺失处明确标出。',
  },
  dialogue: {
    title: '对白打磨',
    subtitle: '让对话推动信息与关系',
    prompt:
      '改写当前章节的关键对白，使每句对白体现人物身份、关系和信息差。保留情节事实，不新增未经设定支持的转折。',
  },
  scene: {
    title: '场景渲染',
    subtitle: '用感官细节托住情节',
    prompt:
      '为当前场景补充符合题材的环境、感官和节奏。细节必须服务人物行动，不堆砌无关景物，不改变既定情节。',
  },
  continuity: {
    title: '伏笔管理',
    subtitle: '记住埋下与回收',
    prompt:
      '列出截至当前章节已经埋下、推进和回收的伏笔。指出可能遗忘或提前泄露的信息，并给出下一章可使用的线索。',
  },
};
const assetIcons: Record<Category, LucideIcon> = {
  world: Map,
  characters: UsersRound,
  plot: GitBranch,
  chapters: BookOpen,
};
const statusText = { idle: '待运行', running: '生成中', done: '已完成', error: '运行失败' };
function WorkflowNode({ data, selected }: NodeProps) {
  const step = data.step as Step;
  const Icon = icons[step.id] || (step.kind && kindIcons[step.kind]) || Sparkles;
  const protectedNode = Boolean(data.protected);
  const menuOpen = Boolean(data.menuOpen);
  return (
    <div className={`workflow-node ${step.id} ${selected ? 'selected' : ''} ${step.status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-top">
        <span className={`icon-box ${step.id}`}>
          <Icon size={19} />
        </span>
        <span className="node-number">0{Number(data.index) + 1}</span>
        <button
          className="node-menu-trigger nodrag nopan"
          aria-label={`打开 ${step.title} 操作菜单`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            (data.onMenu as (id: string) => void)?.(step.id);
          }}
        >
          <MoreHorizontal size={17} />
        </button>
        {menuOpen && (
          <div className="node-menu nodrag nopan" role="menu" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              role="menuitem"
              onClick={() => (data.onSelect as (id: string) => void)?.(step.id)}
            >
              查看节点
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={protectedNode}
              title={protectedNode ? '开始和结束节点必须保留' : undefined}
              onClick={() => (data.onDelete as (id: string) => void)?.(step.id)}
            >
              {protectedNode ? '边界节点不可删除' : '删除节点'}
            </button>
          </div>
        )}
      </div>
      <h3>{step.title}</h3>
      <p>{step.subtitle}</p>
      <div className="node-footer">
        <span className={`status-dot ${step.status}`} />
        {statusText[step.status]}
        <span className="node-kind">
          {step.kind === 'audit' || step.id === 'review'
            ? 'AUDIT'
            : step.kind === 'writer' || step.id === 'draft'
              ? 'WRITER'
              : step.id === data.startNodeId
                ? 'START'
                : step.id === data.endNodeId
                  ? 'END'
                  : 'AGENT'}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { workflow: WorkflowNode };
function FitCanvas() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const element = document.querySelector('.flow-container');
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.16 }));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitView]);
  return null;
}
export default function App() {
  const confirmDialog = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null);
  const [settings, setSettings] = useState<ModelSettings | null>(null),
    [page, setPage] = useState<Page>('workflow');
  const [selected, setSelected] = useState<StepId | null>(null),
    [openNodeMenu, setOpenNodeMenu] = useState<StepId | null>(null),
    [nodes, setNodes] = useState<FlowNode[]>([]),
    [edges, setEdges] = useState<Edge[]>([]);
  const [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [newProject, setNewProject] = useState(false),
    [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false),
    [addAsset, setAddAsset] = useState(false),
    [help, setHelp] = useState(false),
    [addNode, setAddNode] = useState(false),
    [editAsset, setEditAsset] = useState<Asset | null>(null),
    [workflowConfig, setWorkflowConfig] = useState(false),
    [workflowCreator, setWorkflowCreator] = useState(false),
    [platformGuide, setPlatformGuide] = useState(false);
  const [preview, setPreview] = useState<Asset | null>(null),
    [category, setCategory] = useState<Category>('world'),
    [filter, setFilter] = useState<Category | 'all'>('all'),
    [search, setSearch] = useState('');
  const chapterEditor = useChapterEditor(project, page === 'chapters');
  const { chapterId, editor, dirty, conflict: chapterConflict } = chapterEditor;
  const [generationEntry, setGenerationEntry] = useState<GenerationEntry | null>(null);
  const [platformChapterId, setPlatformChapterId] = useState('');
  const [inspectorTab, setInspectorTab] = useState<'config' | 'result'>('config'),
    [prompt, setPrompt] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null),
    activeId = useRef(''),
    activeIdentity = useRef(''),
    identityEpoch = useRef(0),
    projectRef = useRef<Project | null>(null),
    requestSequence = useRef(0),
    lastAppliedRequest = useRef(0),
    responseScopes = useRef(new WeakMap<Project, { epoch: number; sequence: number }>()),
    graphMutation = useRef(0),
    taskInFlight = useRef(false),
    mutationPending = useRef(0),
    deleteInFlight = useRef(false),
    graphHistory = useRef<GraphSnapshot[]>([]),
    restoringHistory = useRef(false);
  const projectId = project?.id,
    running = project?.run?.status === 'running';
  const projectSwitcherRef = useRef<HTMLDivElement>(null);
  const showToast = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const acceptProject = useCallback((p: Project, mutation?: number) => {
    const scope = responseScopes.current.get(p);
    if (scope && (scope.epoch !== identityEpoch.current || scope.sequence < lastAppliedRequest.current))
      return false;
    if (activeId.current && activeId.current !== p.id) return false;
    if (mutation !== undefined && mutation < graphMutation.current) return false;
    if (!canApplyProject(projectRef.current, p, activeIdentity.current || projectIdentity(p))) return false;
    if (scope) lastAppliedRequest.current = scope.sequence;
    projectRef.current = p;
    setProject(p);
    setProjects((all) => all.map((item) => (item.id === p.id ? p : item)));
    setSelected((current) =>
      current && p.steps.some((s) => s.id === current) ? current : p.steps[0]?.id || null,
    );
    return true;
  }, []);
  const activateProject = (p: Project) => {
    identityEpoch.current += 1;
    activeId.current = p.id;
    activeIdentity.current = projectIdentity(p);
    projectRef.current = null;
    lastAppliedRequest.current = 0;
    graphHistory.current = [];
    setCanUndo(false);
    chapterEditor.resetEditor();
    setGenerationEntry(null);
    setPlatformChapterId('');
    responseScopes.current.delete(p);
    acceptProject(p);
  };
  const projectRequest = useCallback(
    async (url: string, options: RequestInit = {}, changeWorkflow = false) => {
      const epoch = identityEpoch.current;
      const sequence = ++requestSequence.current;
      if (options.method && options.method !== 'GET') lastAppliedRequest.current = sequence;
      const mutating = !!options.method && options.method !== 'GET';
      if (mutating) mutationPending.current += 1;
      let p: Project;
      try {
        p = await api<Project>(url, options);
      } finally {
        if (mutating) mutationPending.current -= 1;
      }
      if (changeWorkflow && epoch === identityEpoch.current && p.id === activeId.current) {
        activeIdentity.current = projectIdentity(p);
        projectRef.current = null;
        graphHistory.current = [];
        setCanUndo(false);
        setGenerationEntry(null);
        setPlatformChapterId('');
      }
      responseScopes.current.set(p, { epoch, sequence });
      return p;
    },
    [],
  );
  useEffect(() => {
    const sync = () => {
      const next = window.location.pathname.replace(/^\//, '') as Page;
      if (['workflow','assets','chapters','platforms','settings'].includes(next)) setPage(next);
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<Project[]>('/projects', { signal: controller.signal }),
      api<ModelSettings>('/settings', { signal: controller.signal }),
    ])
      .then(([all, s]) => {
        if (controller.signal.aborted) return;
        setProjects(all);
        setSettings(s);
        const saved = localStorage.getItem('novel-project');
        const savedPage = localStorage.getItem('novel-page');
        if (
          savedPage === 'workflow' ||
          savedPage === 'assets' ||
          savedPage === 'chapters' ||
          savedPage === 'platforms' ||
          savedPage === 'settings'
        )
          setPage(savedPage);
        const p = all.find((p) => p.id === saved) || all[0];
        if (p) activateProject(p);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!projectId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const epoch = identityEpoch.current;
    const poll = async () => {
      try {
        if (!mutationPending.current) {
          const fresh = await projectRequest(`/projects/${projectId}`, { signal: controller.signal });
          if (!stopped && epoch === identityEpoch.current) acceptProject(fresh);
        }
      } catch (error) {
        if (!stopped && epoch === identityEpoch.current && !controller.signal.aborted)
          setError(errorMessage(error));
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 2500);
      }
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, project?.activeWorkflowId, running, acceptProject, projectRequest]);
  useEffect(() => {
    if (!openNodeMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.node-menu') && !target.closest('.node-menu-trigger')) setOpenNodeMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenNodeMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [openNodeMenu]);
  useEffect(() => {
    if (!projectSwitcherOpen) return;
    const current = projectSwitcherRef.current?.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    );
    current?.focus();
    const close = (event: MouseEvent) => {
      if (!projectSwitcherRef.current?.contains(event.target as Node)) setProjectSwitcherOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectSwitcherOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [projectSwitcherOpen]);
  useEffect(() => {
    if (!project) return;
    setNodes((current) => {
      const selectedIds = new Set(current.filter((n) => n.selected).map((n) => n.id));
      return project.steps.map((step, index) => ({
        id: step.id,
        type: 'workflow',
        position: step.position,
        selected: selectedIds.has(step.id) || step.id === selected,
        data: {
          step,
          index,
          startNodeId: project.workflow?.startNodeId,
          endNodeId: project.workflow?.endNodeId,
          protected: step.id === project.workflow?.startNodeId || step.id === project.workflow?.endNodeId,
          menuOpen: openNodeMenu === step.id,
          onMenu: (id: StepId) => setOpenNodeMenu((current) => (current === id ? null : id)),
          onSelect: (id: StepId) => {
            setSelected(id);
            setOpenNodeMenu(null);
          },
          onDelete: (id: StepId) => {
            setOpenNodeMenu(null);
            void persistGraphDelete([{ id }], []);
          },
        },
      }));
    });
    setEdges((current) => {
      const selectedIds = new Set(current.filter((e) => e.selected).map((e) => e.id));
      return (project.workflow?.edges || []).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        selected: selectedIds.has(edge.id),
        animated: project.steps.find((node) => node.id === edge.target)?.status === 'running',
        style: {
          stroke:
            project.steps.find((node) => node.id === edge.source)?.status === 'done' ? '#88a993' : '#bec6c1',
          strokeWidth: 1.5,
        },
      }));
    });
  }, [project, selected, openNodeMenu]);
  const step = project?.steps.find((s) => s.id === selected);
  useEffect(() => {
    setPrompt(step?.prompt || '');
  }, [step?.prompt, selected, projectId]);
  const task = async (fn: () => Promise<void>) => {
    if (taskInFlight.current || deleteInFlight.current || restoringHistory.current) return;
    const epoch = identityEpoch.current;
    taskInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (epoch === identityEpoch.current) setError(errorMessage(e));
    } finally {
      taskInFlight.current = false;
      setBusy(false);
    }
  };
  const reconcilePendingRun = async (retryAbsent = false) => {
    if (!projectId) return;
    const submission = readPendingRunSubmission(projectId);
    if (!submission) return;
    try {
      const receipt = await api<{ run: Run; project: Project }>(
        `/projects/${projectId}/run-requests/${encodeURIComponent(submission.key)}`,
      );
      if (!acceptProject(receipt.project)) throw new Error('已找到原运行，请返回原工作流查看。');
      clearPendingRunSubmission(projectId);
      showToast('已核对原运行，未重复生成');
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
      if (!retryAbsent) throw new Error('已确认没有原运行。可点击“核对并重试原请求”，沿用原章号和原请求。');
      if (dirty || running) throw new Error('请先保存章节修改并等待当前运行结束。');
      if (!(await confirmDialog('确认重试原请求？将保留原章号、原工作流和幂等键。'))) return;
      const started = await projectRequest(`/projects/${projectId}/run`, {
        method: 'POST',
        headers: { 'Idempotency-Key': submission.key },
        body: JSON.stringify(submission.request),
      });
      if (!acceptProject(started)) throw new Error('请求已提交，请返回原工作流查看状态。');
      clearPendingRunSubmission(projectId);
      showToast('原请求已提交');
    }
  };
  const switchProject = async (id: string) => {
    if (dirty && !(await confirmDialog('章节有未保存的修改，确定切换项目吗？'))) return;
    const p = projects.find((p) => p.id === id);
    if (!p) return;
    activateProject(p);
    localStorage.setItem('novel-project', p.id);
    setPage('workflow');
    setSelected(p.steps[0]?.id || null);
    setOpenNodeMenu(null);
    setError('');
    void projectRequest(`/projects/${id}`)
      .then((fresh) => {
        if (activeId.current === fresh.id) acceptProject(fresh);
      })
      .catch((e) => {
        if (activeId.current === id) setError(errorMessage(e));
      });
  };
  const deleteProject = async () => {
    if (!project || projects.length <= 1 || running || busy) return;
    if (dirty && !(await confirmDialog('章节有未保存的修改，确定删除当前作品吗？'))) return;
    if (!(await confirmDialog(`确定删除作品「${project.title}」吗？作品内的资料、章节和工作流都会被删除。`)))
      return;
    void task(async () => {
      const wasActive = activeId.current === project.id;
      const remaining = await api<Project[]>(`/projects/${project.id}`, { method: 'DELETE' });
      setProjects(remaining);
      if (!wasActive) {
        showToast('作品已删除');
        return;
      }
      const next = remaining[0];
      if (!next) return;
      activateProject(next);
      localStorage.setItem('novel-project', next.id);
      setPage('workflow');
      setOpenNodeMenu(null);
      showToast('作品已删除，已切换到下一个作品');
      const fresh = await projectRequest(`/projects/${next.id}`);
      if (activeId.current === fresh.id) acceptProject(fresh);
    });
  };
  const [canUndo, setCanUndo] = useState(false);
  const snapshotGraph = useCallback((value: Project | null = projectRef.current) => {
    if (!value || restoringHistory.current) return;
    graphHistory.current = [...graphHistory.current, graphSnapshot(value)].slice(-30);
    setCanUndo(true);
  }, []);
  const undoGraph = useCallback(async () => {
    const current = projectRef.current;
    if (!current || running || busy || taskInFlight.current || restoringHistory.current) return;
    const previous = graphHistory.current.at(-1);
    if (!previous || previous.identity !== projectIdentity(current)) return;
    restoringHistory.current = true;
    setBusy(true);
    try {
      const restored = await projectRequest(`/projects/${current.id}/graph`, {
        method: 'PUT',
        body: JSON.stringify({
          workflowId: workflowIdOf(current),
          expectedGraphRevision: current.workflow?.graphRevision ?? 0,
          steps: previous.steps,
          workflow: previous.workflow,
        }),
      });
      if (acceptProject(restored)) {
        graphHistory.current.pop();
        showToast('已撤销上一次图编辑，章节及运行结果未回滚');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '撤销失败');
    } finally {
      restoringHistory.current = false;
      setCanUndo(graphHistory.current.length > 0);
      setBusy(false);
    }
  }, [acceptProject, busy, projectRequest, running, showToast]);
  const graphScope = () => ({
    workflowId: project ? workflowIdOf(project) : '',
    expectedGraphRevision: project?.workflow?.graphRevision ?? 0,
  });
  const updateGraph = async (values: object) => {
    const before = projectRef.current;
    const updated = await projectRequest(`/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...values, ...graphScope() }),
    });
    if (acceptProject(updated)) snapshotGraph(before);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      void undoGraph();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undoGraph]);
  const arrangeNodes = async (mode: 'horizontal' | 'vertical' | 'grid' | 'layers') => {
    if (!project) return;
    const incoming: Record<string, number> = {};
    const depth: Record<string, number> = {};
    const edges = project.workflow?.edges || [];
    for (const edge of edges) incoming[edge.target] = (incoming[edge.target] || 0) + 1;
    const visit = (id: string, seen = new Set<string>()): number => {
      if (id in depth) return depth[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      const parents = edges.filter((edge) => edge.target === id).map((edge) => visit(edge.source, seen));
      return (depth[id] = parents.length ? Math.max(...parents) + 1 : 0);
    };
    project.steps.forEach((step) => visit(step.id));
    const positions: Record<string, { x: number; y: number }> = {};
    if (mode === 'grid')
      project.steps.forEach((step, index) => {
        positions[step.id] = { x: 80 + (index % 4) * 280, y: 80 + Math.floor(index / 4) * 180 };
      });
    else {
      const groups: Record<number, typeof project.steps> = {};
      for (const step of project.steps) (groups[depth[step.id]] ||= []).push(step);
      Object.keys(groups)
        .map(Number)
        .sort((a, b) => a - b)
        .forEach((rank, column) =>
          groups[rank].forEach((step, row) => {
            positions[step.id] =
              mode === 'vertical'
                ? { x: 80 + row * 280, y: 80 + column * 180 }
                : { x: 80 + column * 300, y: 90 + row * 170 };
          }),
        );
    }
    await task(async () => {
      await updateGraph({
        steps: project.steps.map((step) => ({ id: step.id, position: positions[step.id] })),
      });
      showToast('节点已整理');
    });
  };
  const navigate = async (next: Page) => {
    if (dirty && next !== page && !(await confirmDialog('章节有未保存的修改，确定离开吗？'))) return;
    localStorage.setItem('novel-page', next);
    window.history.pushState({ page: next }, '', `/${next}`);
    setPage(next);
    if (next !== 'chapters') chapterEditor.resetEditor();
    if (next === 'platforms') setPlatformChapterId('');
  };
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty]);
  const run = (id?: StepId) => {
    if (dirty) {
      setError('请先保存章节修改。');
      return;
    }
    if (running || busy) return;
    setGenerationEntry(id ? { stepId: id } : {});
  };
  const upload = (files: FileList | File[]) =>
    task(async () => {
      const list = Array.from(files);
      if (!list.length) return;
      const imagePattern = /\.(png|jpe?g|webp)$/i;
      const oversized = list.find(
        (file) => file.size > (imagePattern.test(file.name) ? IMAGE_ASSET_MAX_BYTES : TEXT_ASSET_MAX_BYTES),
      );
      if (oversized) {
        const image = imagePattern.test(oversized.name);
        throw new Error(`「${oversized.name}」超过${image ? '图片 4 MiB' : '文本 2 MiB'}上限`);
      }
      const form = new FormData();
      form.append('category', category);
      list.forEach((f) => form.append('files', f));
      acceptProject(
        await projectRequest(`/projects/${projectId}/assets/upload`, { method: 'POST', body: form }),
      );
      showToast(`已添加 ${list.length} 份设定`);
      if (uploadRef.current) uploadRef.current.value = '';
    });
  const selectChapter = async (c: Chapter) => {
    if (dirty && !(await confirmDialog('切换章节将丢弃未保存的修改，是否继续？'))) return;
    chapterEditor.selectChapter(c);
  };
  const retryFailedChapter = (number: number, mode: 'create' | 'regenerate') => {
    if (dirty) {
      setError('请先保存或处理当前章节修改，再重试失败目标。');
      return;
    }
    if (running || busy) return;
    setGenerationEntry({ number, mode });
    setPage('workflow');
  };
  const deleteChapter = async (chapter: Chapter) => {
    if (dirty && chapterId === chapter.id && !(await confirmDialog('当前章节有未保存的修改，确定删除吗？')))
      return;
    if (
      !(await confirmDialog(`确定删除第 ${chapter.number} 章「${chapter.title}」吗？其他章节不会重新编号。`))
    )
      return;
    const submitted = chapterEditor.stateRef.current;
    void task(async () => {
      const saved = await projectRequest(`/projects/${projectId}/chapters/${chapter.id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          expectedRevision: chapter.revision,
          workflowId: project ? workflowIdOf(project) : undefined,
        }),
      });
      if (!acceptProject(saved)) return;
      const current = chapterEditor.stateRef.current;
      if (
        current.chapterId === chapter.id &&
        current.identity === submitted.identity &&
        current.selectionVersion === submitted.selectionVersion &&
        current.editVersion === submitted.editVersion
      )
        chapterEditor.resetEditor(saved.chapters);
      showToast('章节已删除，章号不会复用');
    });
  };
  const saveChapter = () => {
    const submitted = { ...chapterEditor.stateRef.current };
    void task(async () => {
      let saved: Project;
      try {
        saved = await projectRequest(`/projects/${projectId}/chapters/${submitted.chapterId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: submitted.title,
            content: submitted.content,
            expectedRevision: submitted.baseRevision,
            workflowId: project ? workflowIdOf(project) : undefined,
          }),
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          activeIdentity.current === submitted.identity
        ) {
          try {
            acceptProject(await projectRequest(`/projects/${projectId}`));
          } catch {
            /* Keep the original conflict and local draft. */
          }
        }
        throw error;
      }
      const chapter = saved.chapters.find((item) => item.id === submitted.chapterId);
      if (!acceptProject(saved) || !chapter) return;
      chapterEditor.acknowledgeSave(submitted, chapter);
      showToast('提交的版本已保存；保存期间的新输入仍保留在编辑器');
    });
  };
  const openDraftSync = () => {
    if (dirty || chapterConflict || !chapterId) {
      setError('请先保存或处理当前章节版本，再选择同步。');
      return;
    }
    setPlatformChapterId(chapterId);
    chapterEditor.resetEditor();
    setPage('platforms');
  };
  const onNodeChanges = useCallback(
    (changes: NodeChange[]) => {
      const protectedIds = new Set(
        [project?.workflow?.startNodeId, project?.workflow?.endNodeId].filter(Boolean),
      );
      if (deleteInFlight.current && changes.some((change) => change.type === 'remove')) return;
      const safeChanges = changes.filter(
        (change) => change.type !== 'remove' || !protectedIds.has(change.id),
      );
      if (safeChanges.length) setNodes((nds) => applyNodeChanges(safeChanges, nds));
    },
    [project?.workflow?.startNodeId, project?.workflow?.endNodeId],
  );
  const onEdgeChanges = useCallback((changes: EdgeChange[]) => {
    if (deleteInFlight.current && changes.some((change) => change.type === 'remove')) return;
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);
  const persistGraphDelete = useCallback(
    async (deletedNodes: { id: string }[], deletedEdges: { id: string }[]) => {
      if (!projectId || running) {
        setError(running ? '请先停止工作流再删除节点。' : '请先选择作品。');
        return false;
      }
      if (deleteInFlight.current || taskInFlight.current || restoringHistory.current) return false;
      if (!deletedNodes.length && !deletedEdges.length) return false;
      const protectedIds = new Set(
        [project?.workflow?.startNodeId, project?.workflow?.endNodeId].filter(Boolean),
      );
      if (deletedNodes.some((node) => protectedIds.has(node.id))) {
        setError('开始节点和结束节点必须保留，不能删除。');
        return false;
      }
      deleteInFlight.current = true;
      setBusy(true);
      setError('');
      const mutation = ++graphMutation.current;
      const previous = project;
      try {
        const updated = await projectRequest(`/projects/${projectId}/nodes`, {
          method: 'DELETE',
          body: JSON.stringify({
            ...graphScope(),
            nodeIds: deletedNodes.map((n) => n.id),
            edgeIds: deletedEdges.map((e) => e.id),
          }),
        });
        if (acceptProject(updated, mutation)) snapshotGraph(previous);
        showToast(deletedNodes.length ? '节点已删除' : '连线已删除');
        return false;
      } catch (error) {
        try {
          acceptProject(await projectRequest(`/projects/${projectId}`), mutation);
        } catch {
          if (previous) acceptProject(previous, mutation);
        }
        setError(error instanceof Error ? error.message : '删除失败');
        return false;
      } finally {
        deleteInFlight.current = false;
        setBusy(false);
      }
    },
    [acceptProject, project, projectId, running, showToast, snapshotGraph],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const current = project?.workflow?.edges || [];
      if (current.some((e) => e.source === connection.source && e.target === connection.target)) return;
      void task(async () => {
        const previous = projectRef.current;
        const updated = await projectRequest(`/projects/${projectId}/edges`, {
          method: 'PUT',
          body: JSON.stringify({
            ...graphScope(),
            edges: [...current, { source: connection.source, target: connection.target }],
          }),
        });
        if (acceptProject(updated)) snapshotGraph(previous);
        showToast('节点连接已保存');
      });
    },
    [project, projectId, task, acceptProject, showToast, snapshotGraph],
  );
  const filteredAssets = useMemo(
    () => filterAssets(project?.assets || [], filter, search),
    [project?.assets, filter, search],
  );
  const chapters = useMemo(() => sortedChapters(project?.chapters || []), [project?.chapters]);
  const selectedChapterIndex = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (!project || !settings)
    return (
      <div className="loading-screen">
        <img src="/favicon.svg" alt="" />
        <h2>Novel Agent</h2>
        {error ? (
          <>
            <p>{error}</p>
            <button onClick={() => window.location.reload()}>重新连接</button>
          </>
        ) : (
          <p>
            <LoaderCircle className="spin" size={16} /> 正在打开你的故事宇宙…
          </p>
        )}
      </div>
    );
  const writingWorkflow = project.steps.some(
    (item) => item.enabled !== false && (item.kind === 'writer' || item.id === 'draft'),
  );
  const completed = project.steps.filter((item) => item.status === 'done').length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('workflow');
          }}
        >
          <img src="/favicon.svg" alt="" />
          <span>
            Novel<span className="brand-light"> Agent</span>
            <small>你的故事，正在发生</small>
          </span>
        </a>
        <div className="workspace-label">
          创作空间 <span>WORKSPACE</span>
        </div>
        <div className="project-select" ref={projectSwitcherRef}>
          <button
            className="project-switcher-trigger"
            aria-label="切换作品"
            aria-haspopup="listbox"
            aria-expanded={projectSwitcherOpen}
            aria-controls="project-switcher-list"
            disabled={running || busy}
            onClick={() => setProjectSwitcherOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setProjectSwitcherOpen(true);
              }
            }}
          >
            <span className="project-avatar">{project.title.slice(0, 1)}</span>
            <span className="project-switcher-current">
              <small>当前作品</small>
              <strong>{project.title}</strong>
              {project.genre && <em>{project.genre}</em>}
            </span>
            <ChevronDown size={14} />
          </button>
          <button
            className="icon-button project-delete"
            aria-label="删除当前作品"
            disabled={projects.length <= 1 || running || busy}
            title={projects.length <= 1 ? '至少保留一个作品' : '删除当前作品'}
            onClick={deleteProject}
          >
            <Trash2 size={15} />
          </button>
          {projectSwitcherOpen && (
            <div className="project-switcher-popover">
              <ul id="project-switcher-list" role="listbox" aria-label="作品列表">
                {projects.map((item, index) => (
                  <li key={item.id} role="presentation">
                    <button
                      role="option"
                      aria-selected={item.id === project.id}
                      className={item.id === project.id ? 'active' : ''}
                      onClick={() => {
                        setProjectSwitcherOpen(false);
                        if (item.id !== project.id) switchProject(item.id);
                      }}
                      onKeyDown={(event) => {
                        const options = event.currentTarget
                          .closest('[role="listbox"]')
                          ?.querySelectorAll<HTMLButtonElement>('[role="option"]');
                        if (!options) return;
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault();
                          const next = index + (event.key === 'ArrowDown' ? 1 : -1);
                          options[(next + options.length) % options.length]?.focus();
                        } else if (event.key === 'Home') {
                          event.preventDefault();
                          options[0]?.focus();
                        } else if (event.key === 'End') {
                          event.preventDefault();
                          options[options.length - 1]?.focus();
                        }
                      }}
                    >
                      <span className="project-avatar">{item.title.slice(0, 1)}</span>
                      <span>
                        <strong>{item.title}</strong>
                        <em>
                          {item.genre || '未分类'} · {item.chapters.length} 章
                        </em>
                      </span>
                      {item.id === project.id && <Check size={14} />}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="project-switcher-create"
                disabled={running || busy}
                onClick={async () => {
                  setProjectSwitcherOpen(false);
                  if (!dirty || (await confirmDialog('章节有未保存的修改，确定新建作品吗？')))
                    setNewProject(true);
                }}
              >
                <Plus size={14} /> 新建作品
              </button>
            </div>
          )}
        </div>
        <button
          className="new-project"
          onClick={async () => {
            if (!dirty || (await confirmDialog('章节有未保存的修改，确定新建作品吗？'))) setNewProject(true);
          }}
        >
          <Plus size={16} /> 新建作品
        </button>
        <nav>
          {(
            [
              { id: 'workflow', label: '创作工作流', icon: Network },
              { id: 'assets', label: '小说设定库', icon: FolderOpen },
              { id: 'chapters', label: '章节书稿', icon: BookOpen },
              { id: 'platforms', label: '平台作品', icon: Link2 },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'active' : ''}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === 'assets' && <span className="nav-count">{project.assets.length}</span>}
              {item.id === 'chapters' && project.chapters.length > 0 && (
                <span className="nav-count">{project.chapters.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="note-stars">✧</div>
          <p>
            好的故事，
            <br />
            从一个念头开始。
          </p>
          <span>让灵感生根，让世界生长。</span>
          <div className="note-line" />
        </div>
        <div className="sidebar-bottom">
          <button className={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}>
            <Settings2 size={18} /> 模型设置
            <span className={`connection-dot ${settings.hasKey && settings.mode === 'live' ? 'live' : ''}`} />
          </button>
          <button onClick={() => setHelp(true)}>
            <CircleHelp size={18} /> 使用指南
            <ArrowRight size={14} className="push-right" />
          </button>
          <div className="local-user">
            <span className="user-avatar">N</span>
            <div>
              本地创作空间
              <small>
                <span className="green-dot" /> 数据保存在本机
              </small>
            </div>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>我的作品</span>
            <ChevronRight size={14} />
            <span>{project.title}</span>
            <ChevronRight size={14} />
            <strong>
              {
                {
                  workflow: '创作工作流',
                  assets: '小说设定库',
                  chapters: '章节书稿',
                  platforms: '平台作品',
                  settings: '模型设置',
                }[page]
              }
            </strong>
          </div>
          <div className="topbar-right">
            <ThemeSwitcher />
            <button
              className="icon-button quick-settings"
              aria-label="模型设置"
              onClick={() => navigate('settings')}
            >
              <Settings2 size={18} />
            </button>
            <span className="save-indicator">
              <span className="green-dot" />
              {running ? '工作流运行中' : '已保存至本地'}
            </span>
            <button className="icon-button" aria-label="使用指南" onClick={() => setHelp(true)}>
              <CircleHelp size={18} />
            </button>
            <span className="top-avatar">N</span>
          </div>
        </header>
        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'workflow'
                  ? 'STORY WORKSPACE'
                  : page === 'assets'
                    ? 'STORY BIBLE'
                    : page === 'chapters'
                      ? 'MANUSCRIPT'
                      : page === 'platforms'
                        ? 'PLATFORM CONNECTION'
                        : 'MODEL CONNECTION'}
              </div>
              <h1>
                {
                  {
                    workflow: '让故事，自成宇宙',
                    assets: '每一处设定，皆有回响',
                    chapters: '把灵感，写成下一章',
                    platforms: '为作品，连接新天地',
                    settings: '为灵感，连接动力',
                  }[page]
                }
              </h1>
              <p>
                {
                  {
                    workflow: '从世界的轮廓到章节的细节，与 Agent 一起让想象落笔。',
                    assets: '收好世界的地图、人物的秘密，以及故事将要抵达的地方。',
                    chapters: '生成、打磨、留存。在这里，让每一个字找到自己的位置。',
                    platforms: '人工选择账号、作品与一个已保存章节，确认后同步到外部草稿箱，不自动正式发布。',
                    settings: '连接你偏爱的模型服务，让每一个创作节点开始思考。',
                  }[page]
                }
              </p>
            </div>
            <div className="heading-actions">
              {page === 'workflow' && (
                <>
                  <button className="button secondary" onClick={() => navigate('assets')}>
                    <Upload size={16} />
                    上传设定
                  </button>
                  {running ? (
                    <button
                      className="button primary"
                      onClick={() =>
                        task(async () => {
                          await api(`/projects/${project.id}/cancel`, { method: 'POST' });
                        })
                      }
                    >
                      <Square size={14} />
                      停止运行
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={busy || !project.steps.length}
                      onClick={() => run()}
                    >
                      <Play size={15} fill="currentColor" />
                      {writingWorkflow ? '运行工作流' : '运行世界观工作流'}
                    </button>
                  )}
                </>
              )}
              {page === 'assets' && (
                <button className="button primary" disabled={running} onClick={() => setAddAsset(true)}>
                  <Plus size={17} />
                  新建设定
                </button>
              )}
              {page === 'platforms' && (
                <button className="button secondary" onClick={() => setPlatformGuide(true)}>
                  <CircleHelp size={16} />
                  连接教程
                </button>
              )}
              {page === 'chapters' && (
                <div className="chapter-page-actions">
                  <button
                    className="button secondary"
                    disabled={!project.chapters.length}
                    onClick={() =>
                      download(`${project.title}.md`, chapters.map((c) => c.content).join('\n\n---\n\n'))
                    }
                  >
                    <ArrowDownToLine size={16} />
                    导出全书
                  </button>
                  <button
                    className="button secondary"
                    disabled={!chapterEditor.currentChapter || running || busy}
                    onClick={() =>
                      chapterEditor.currentChapter && deleteChapter(chapterEditor.currentChapter)
                    }
                  >
                    <Trash2 size={16} />
                    删除章节
                  </button>
                  <button
                    className="button secondary"
                    disabled={!chapterId || dirty || chapterConflict || running || busy}
                    title="前往平台页，人工选择账号与作品后确认一个已保存版本；此按钮不会进行远端写入"
                    onClick={openDraftSync}
                  >
                    <Upload size={16} />
                    同步此章到草稿
                  </button>
                  <button
                    className="button secondary"
                    disabled={dirty || running || busy || !chapterEditor.currentChapter}
                    onClick={() =>
                      chapterEditor.currentChapter &&
                      setGenerationEntry({ number: chapterEditor.currentChapter.number, mode: 'regenerate' })
                    }
                  >
                    <Redo2 size={16} />
                    重生成此章
                  </button>
                  <button
                    className="button primary"
                    disabled={dirty || running || busy}
                    onClick={() => run()}
                  >
                    <Play size={16} />
                    生成章节 / 要求
                  </button>
                </div>
              )}
            </div>
          </section>
          <ErrorBanner error={error} onClose={() => setError('')} />
          {project && readPendingRunSubmission(project.id) && !running && (
            <div className="run-reconciliation" role="status">
              <span>上次运行提交结果尚未核对。请先查运行状态，确认没有重复生成。</span>
              <button
                type="button"
                className="text-button"
                onClick={() => void task(() => reconcilePendingRun(false))}
              >
                核对原运行
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => void task(() => reconcilePendingRun(true))}
              >
                核对并重试原请求
              </button>
            </div>
          )}
          {page === 'workflow' && (
            <>
              <section className="project-strip">
                <span className="book-cover">
                  <BookOpen size={23} />
                </span>
                <div className="strip-title">
                  <h3>
                    {project.title}
                    <span className="genre-tag">{project.genre}</span>
                  </h3>
                  <p>{project.description || '一个新的故事，等待你的第一笔。'}</p>
                </div>
                <div className="strip-stat">
                  <strong>{project.assets.length.toString().padStart(2, '0')}</strong>
                  <span>设定资料</span>
                </div>
                <div className="strip-stat">
                  <strong>{project.chapters.length.toString().padStart(2, '0')}</strong>
                  <span>已保存章节</span>
                </div>
                <div className="strip-stat progress-stat">
                  <span>
                    <strong>{completed}</strong> / {Math.max(project.steps.length, 1)}
                  </span>
                  <span>节点已完成</span>
                  <div className="progress-track">
                    <i
                      style={{
                        width: `${project.steps.length ? (completed / project.steps.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </section>
              <section className="workflow-workspace">
                <div className="canvas-panel">
                  <div className="panel-toolbar">
                    <div>
                      <span className="panel-dot" />
                      <strong>{project.workflow?.name || '小说创作工作流'}</strong>
                      <select
                        className="workflow-switch"
                        aria-label="切换工作流"
                        value={project.activeWorkflowId || project.workflows?.[0]?.id || ''}
                        disabled={running || busy}
                        onChange={(e) =>
                          void task(async () => {
                            acceptProject(
                              await projectRequest(
                                `/projects/${project.id}/workflows/${e.target.value}/select`,
                                { method: 'POST' },
                                true,
                              ),
                            );
                            showToast('已切换工作流');
                          })
                        }
                      >
                        {(project.workflows || []).map((graph) => (
                          <option key={graph.id} value={graph.id}>
                            {graph.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="panel-actions">
                      <button
                        className="button secondary compact"
                        disabled={running || busy}
                        onClick={() => setWorkflowCreator(true)}
                      >
                        <Plus size={14} /> 新建工作流
                      </button>
                      <select
                        aria-label="整理节点"
                        disabled={running || busy}
                        defaultValue=""
                        onChange={(event) => {
                          const mode = event.target.value;
                          event.currentTarget.value = '';
                          if (mode) void arrangeNodes(mode as 'horizontal' | 'vertical' | 'grid' | 'layers');
                        }}
                      >
                        <option value="" disabled>
                          整理节点
                        </option>
                        <option value="layers">按流程分层</option>
                        <option value="horizontal">横向排列</option>
                        <option value="vertical">纵向排列</option>
                        <option value="grid">网格排列</option>
                      </select>
                      <button
                        className="button secondary compact"
                        disabled={running}
                        onClick={() => setAddNode(true)}
                      >
                        <Plus size={14} /> 新增节点
                      </button>
                      <button
                        className="button secondary compact"
                        disabled={!canUndo || running || busy}
                        title="撤销上一次节点或连线编辑（Ctrl+Z）"
                        onClick={() => void undoGraph()}
                      >
                        <Undo2 size={14} /> 撤销
                      </button>
                      <button
                        className="button secondary compact"
                        disabled={running}
                        onClick={() => setWorkflowConfig(true)}
                      >
                        <Settings2 size={14} /> 工作流设置
                      </button>
                      {(project.workflows?.length || 0) > 1 && (
                        <button
                          className="button secondary compact"
                          disabled={running || busy}
                          onClick={async () => {
                            if (!(await confirmDialog('确定删除当前工作流吗？章节不会被删除。'))) return;
                            void task(async () => {
                              acceptProject(
                                await projectRequest(
                                  `/projects/${project.id}/workflows/${project.activeWorkflowId}`,
                                  { method: 'DELETE', body: JSON.stringify(graphScope()) },
                                  true,
                                ),
                              );
                              showToast('工作流已删除');
                            });
                          }}
                        >
                          <Trash2 size={14} /> 删除工作流
                        </button>
                      )}
                      <span className={`mode-badge ${settings.mode}`}>
                        {settings.mode === 'demo' ? '演示模式' : '模型已连接'}
                        <span className="small-dot" />
                      </span>
                    </div>
                  </div>
                  <div className="canvas-hint">
                    <span>{String(project.steps.length).padStart(2, '0')} 个节点</span> 选中后按 Delete
                    删除节点或连线
                  </div>
                  <div className="flow-container">
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      nodeTypes={nodeTypes}
                      onNodesChange={onNodeChanges}
                      onEdgesChange={onEdgeChanges}
                      onConnect={onConnect}
                      onBeforeDelete={({ nodes: deletedNodes, edges: deletedEdges }) =>
                        persistGraphDelete(deletedNodes, deletedEdges)
                      }
                      onNodeClick={(_, node) => setSelected(node.id as StepId)}
                      onNodeDragStop={(_, node) =>
                        task(() => updateGraph({ steps: [{ id: node.id, position: node.position }] }))
                      }
                      nodesDraggable={!running && !busy}
                      nodesConnectable={!running && !busy}
                      deleteKeyCode={running || busy ? null : ['Backspace', 'Delete']}
                      fitView
                      fitViewOptions={{ padding: 0.15 }}
                      minZoom={0.25}
                      maxZoom={1.3}
                    >
                      <FitCanvas />
                      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d9ddd7" />
                      <Controls showInteractive={false} />
                    </ReactFlow>
                  </div>
                  <div className="canvas-footer">
                    <span>
                      <span className="legend-dot" />
                      待运行
                      <span className="legend-dot done" />
                      已完成
                      <span className="legend-dot selected" />
                      当前选中
                    </span>
                    <span>拖动节点调整布局 · 选中后按 Delete 删除 · 点击配置 Agent</span>
                  </div>
                </div>
                <aside className="inspector">
                  <div className="inspector-heading">
                    <strong>节点详情</strong>
                    <PanelRightClose size={16} />
                  </div>
                  {!step ? (
                    <div className="inspector-body empty-result">
                      <Network size={30} />
                      <h4>当前工作流还没有节点</h4>
                      <p>新增节点后即可配置指令、连接上下游并运行。</p>
                      <button
                        className="button primary"
                        disabled={running || busy}
                        onClick={() => setAddNode(true)}
                      >
                        <Plus size={14} /> 新增节点
                      </button>
                    </div>
                  ) : step.kind === 'start' || step.id === project.workflow?.startNodeId ? (
                    <div className="inspector-body system-inspector">
                      <h3>章节生成入口</h3>
                      <p>开始节点是系统边界，不调用模型。配置本次章号、生成方式及持久创作要求后开始运行。</p>
                      <p>下一个新章号：第 {nextChapterNumber(project)} 章。删除旧章不会重新编号。</p>
                      <button
                        className="button primary full"
                        disabled={running || busy || dirty}
                        onClick={() => run()}
                      >
                        <Play size={14} />
                        {writingWorkflow ? '配置目标与要求' : '运行世界观工作流'}
                      </button>
                      <GenerationProgress
                        run={project.run}
                        savedChapters={project.chapters.length}
                        onRetry={retryFailedChapter}
                      />
                    </div>
                  ) : step.kind === 'end' || step.id === project.workflow?.endNodeId ? (
                    <div className="inspector-body system-inspector">
                      <h3>生成结果摘要</h3>
                      <p>结束节点只汇总本地结果，不调用模型，也不会自动同步或正式发布。</p>
                      <GenerationProgress
                        run={project.run}
                        savedChapters={project.chapters.length}
                        onRetry={retryFailedChapter}
                      />
                      <button className="button secondary full" onClick={() => navigate('chapters')}>
                        <BookOpen size={14} />
                        查看书稿与候选
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="inspector-title">
                        <span className={`icon-box ${selected || ''}`}>
                          {(() => {
                            const Icon = (selected && icons[selected]) || Sparkles;
                            return <Icon size={21} />;
                          })()}
                        </span>
                        <div>
                          <h3>{step.title}</h3>
                          <p>AGENT 0{project.steps.findIndex((s) => s.id === selected) + 1}</p>
                        </div>
                        <span className={`tiny-status ${step.status}`}>{statusText[step.status]}</span>
                      </div>
                      <div className="tabs">
                        <button
                          className={inspectorTab === 'config' ? 'active' : ''}
                          onClick={() => setInspectorTab('config')}
                        >
                          节点配置
                        </button>
                        <button
                          className={inspectorTab === 'result' ? 'active' : ''}
                          onClick={() => setInspectorTab('result')}
                        >
                          运行结果{step.output && <span className="green-dot" />}
                        </button>
                      </div>
                      {inspectorTab === 'config' ? (
                        <div className="inspector-body">
                          <label className="field-label">
                            输入上下文 <span>自动关联</span>
                          </label>
                          <div className="context-box">
                            <FolderOpen size={15} />
                            <span>小说设定库{step.assetIds?.length ? '（节点专属）' : ''}</span>
                            <span>{project.assets.length} 份资料</span>
                          </div>
                          <label className="field-label" htmlFor="node-output-name">
                            {step.kind === 'writer' || step.id === 'draft' ? '章节名称' : '结果名称'}
                            <span>留空则按内容生成</span>
                          </label>
                          <input
                            id="node-output-name"
                            value={step.outputName || ''}
                            maxLength={120}
                            disabled={running || busy}
                            placeholder="未设置时使用正文首行"
                            onBlur={(event) => {
                              const outputName = event.target.value.trim();
                              if (outputName === (step.outputName || '')) return;
                              void task(async () => {
                                await updateGraph({ steps: [{ id: selected, outputName }] });
                                showToast('结果名称已更新');
                              });
                            }}
                          />
                          <label className="field-label">
                            节点模型 <span>可为不同节点指定模型</span>
                          </label>
                          <select
                            className="node-setting-select"
                            value={step.modelId || ''}
                            disabled={running || busy}
                            onChange={(e) =>
                              void task(async () => {
                                await updateGraph({ steps: [{ id: selected, modelId: e.target.value }] });
                                showToast('节点模型已更新');
                              })
                            }
                          >
                            <option value="">跟随全局模型</option>
                            {(settings.models || []).map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} · {m.model}
                              </option>
                            ))}
                          </select>
                          <label className="field-label">
                            关联设定 <span>留空则使用全部设定</span>
                          </label>
                          <select
                            className="node-setting-select asset-multi"
                            multiple
                            value={step.assetIds || []}
                            disabled={running || busy}
                            onChange={(e) =>
                              void task(async () => {
                                const ids = Array.from(e.target.selectedOptions, (option) => option.value);
                                await updateGraph({ steps: [{ id: selected, assetIds: ids }] });
                                showToast('节点设定范围已更新');
                              })
                            }
                          >
                            {project.assets
                              .filter((a) => !a.url)
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                          </select>
                          {selected !== 'lore' && (
                            <div className="context-box">
                              <GitBranch size={15} />
                              <span>上游节点输出</span>
                              <Check size={14} />
                            </div>
                          )}
                          <label className="field-label prompt-label" htmlFor="prompt">
                            Agent 指令 <Sparkles size={13} />
                          </label>
                          <textarea
                            id="prompt"
                            className="prompt-input"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            disabled={running}
                          />
                          <button
                            className="save-prompt"
                            disabled={running || busy || prompt === step.prompt || !prompt.trim()}
                            onClick={() =>
                              task(async () => {
                                await updateGraph({ steps: [{ id: selected, prompt }] });
                                showToast('节点指令已保存');
                              })
                            }
                          >
                            <Check size={14} />
                            保存指令
                          </button>
                          <div className="model-mini">
                            <span>运行模型</span>
                            <strong>{settings.mode === 'demo' ? '演示模板' : settings.model}</strong>
                            <p>
                              {settings.mode === 'demo'
                                ? '配置模型后，生成属于你的故事。'
                                : '使用设定资料与上游结果进行创作。'}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="inspector-body result-body">
                          {step.output ? (
                            <>
                              <div className="result-actions">
                                <span>{step.output.length.toLocaleString()} 字符</span>
                                <button
                                  onClick={() => download(`${project.title}-${step.title}.md`, step.output)}
                                >
                                  <ArrowDownToLine size={14} />
                                  导出
                                </button>
                              </div>
                              {(step.status !== 'done' ||
                                !step.generationContext ||
                                step.generationContext.runId !== project.run?.id) && (
                                <p className="generation-warning">
                                  历史保留输出，不代表本次运行成功；正式书稿以已保存章节为准。
                                </p>
                              )}
                              <button
                                className="save-prompt"
                                disabled={
                                  running ||
                                  busy ||
                                  step.status !== 'done' ||
                                  !step.output.trim() ||
                                  step.kind === 'writer' ||
                                  step.kind === 'audit'
                                }
                                onClick={() =>
                                  void task(async () => {
                                    acceptProject(
                                      await projectRequest(
                                        `/projects/${project.id}/steps/${step.id}/adopt-world-asset`,
                                        { method: 'POST' },
                                      ),
                                    );
                                    showToast('节点结果已保存到世界设定');
                                  })
                                }
                              >
                                <FolderOpen size={14} /> 采用为世界设定
                              </button>
                              <pre>{step.output}</pre>
                            </>
                          ) : (
                            <div className="empty-result">
                              {step.status === 'running' ? (
                                <LoaderCircle size={28} className="spin" />
                              ) : (
                                <FileText size={30} />
                              )}
                              <h4>{step.status === 'running' ? '正在编织故事…' : '等待故事的第一步'}</h4>
                              <p>
                                {step.status === 'running'
                                  ? '生成完成后，结果会出现在这里。'
                                  : '运行此节点后，在这里查看创作结果。'}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="inspector-bottom">
                        <button
                          className="button secondary full"
                          disabled={running || busy || prompt !== step.prompt}
                          onClick={() => selected && run(selected)}
                        >
                          <Play size={14} />
                          运行此节点
                          <ArrowRight size={15} />
                        </button>
                      </div>
                    </>
                  )}
                </aside>
              </section>
              <section className="workflow-bottom">
                <div className="flow-tip">
                  <span className="tip-icon">
                    <Sparkles size={18} />
                  </span>
                  <div>
                    <strong>
                      {project.run?.status === 'running'
                        ? `正在执行：${project.steps.find((s) => s.id === project.run?.stepId)?.title}`
                        : project.run?.status === 'done'
                          ? '这一轮创作已完成'
                          : project.run?.error
                            ? '运行提示'
                            : '先设定世界，再让故事发生'}
                    </strong>
                    <p>
                      {project.run?.error ||
                        (project.run?.status === 'done'
                          ? '前往章节书稿继续编辑，或选择节点查看结果。'
                          : '补充人物、地图和剧情走向，让 Agent 更懂你想讲述的故事。')}
                    </p>
                  </div>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate(project.run?.status === 'done' ? 'chapters' : 'assets')}
                >
                  {project.run?.status === 'done' ? '查看书稿' : '完善设定库'}
                  <ArrowRight size={16} />
                </button>
              </section>
              <footer className="page-footer">
                <span>NOVEL AGENT</span> 每个世界，都值得被写下来。
                <span className="push-right">
                  {settings.mode === 'demo'
                    ? '当前为演示模板输出 · 不调用模型'
                    : 'AI 辅助创作 · 由你定义故事'}
                </span>
              </footer>
            </>
          )}
          {page === 'assets' && (
            <>
              <section className="asset-category-grid">
                {categories.map((cat) => {
                  const Icon = assetIcons[cat];
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        setFilter(cat);
                        setCategory(cat);
                      }}
                      className={`category-card ${filter === cat ? 'active' : ''}`}
                    >
                      <span className={`icon-box ${cat}`}>
                        <Icon size={21} />
                      </span>
                      <strong>{categoryLabels[cat]}</strong>
                      <span>
                        {project.assets.filter((a) => a.category === cat).length} 份资料
                        <ChevronRight size={15} />
                      </span>
                    </button>
                  );
                })}
              </section>
              <section
                className="upload-zone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!running) void upload(e.dataTransfer.files);
                }}
              >
                <span className="upload-icon">
                  <Upload size={26} />
                </span>
                <div>
                  <h3>把你的故事设定，放在这里</h3>
                  <p>拖拽文件上传，支持 TXT、MD、JSON 和 PNG / JPG / WebP 地图</p>
                  <small>文本 2 MB · 图片 4 MB · UTF-8 编码 · 每次最多 10 个</small>
                </div>
                <select
                  aria-label="上传设定分类"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as Category)}
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {categoryLabels[cat]}
                    </option>
                  ))}
                </select>
                <button
                  className="button primary"
                  disabled={busy || running}
                  onClick={() => uploadRef.current?.click()}
                >
                  <Plus size={16} />
                  选择文件
                </button>
                <input
                  ref={uploadRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.json,.png,.jpg,.jpeg,.webp"
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void upload(e.target.files);
                  }}
                />
              </section>
              <div className="list-toolbar">
                <div className="filter-tabs">
                  <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                    全部资料 <span>{project.assets.length}</span>
                  </button>
                  {filter !== 'all' && (
                    <button className="active" onClick={() => setFilter('all')}>
                      {categoryLabels[filter]}
                      <X size={13} />
                    </button>
                  )}
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    placeholder="搜索设定内容…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="asset-table">
                <div className="asset-table-head">
                  <span>资料名称</span>
                  <span>分类</span>
                  <span>大小</span>
                  <span>操作</span>
                </div>
                {filteredAssets.length ? (
                  filteredAssets.map((a) => (
                    <div className="asset-row" key={a.id}>
                      <button className="asset-name" onClick={() => setPreview(a)}>
                        <span className={`file-icon ${a.mime?.startsWith('image') ? 'image' : ''}`}>
                          {a.mime?.startsWith('image') ? <Map size={19} /> : <FileText size={19} />}
                        </span>
                        <span>
                          <strong>{a.name}</strong>
                          <small>
                            {a.mime?.startsWith('image') ? '图片资料' : '文本设定'} ·{' '}
                            {new Date(a.createdAt).toLocaleDateString('zh-CN')}
                          </small>
                        </span>
                      </button>
                      <span>
                        <span className={`category-pill ${a.category}`}>{categoryLabels[a.category]}</span>
                      </span>
                      <span className="muted">
                        {a.size > 1024 ? `${(a.size / 1024).toFixed(1)} KB` : `${a.size} B`}
                      </span>
                      <span className="asset-actions">
                        <button
                          className="icon-button"
                          aria-label={`编辑 ${a.name}`}
                          disabled={running || busy || !!a.url}
                          onClick={() => setEditAsset(a)}
                        >
                          <Settings2 size={15} />
                        </button>
                        <button
                          className="icon-button delete"
                          aria-label={`删除 ${a.name}`}
                          disabled={running || busy}
                          onClick={async () => {
                            if (await confirmDialog(`确定删除「${a.name}」吗？`))
                              void task(async () => {
                                acceptProject(
                                  await projectRequest(`/projects/${project.id}/assets/${a.id}`, {
                                    method: 'DELETE',
                                  }),
                                );
                                showToast('设定已删除');
                              });
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <FolderOpen size={32} />
                    <h3>{search ? '没有找到相关设定' : '世界的轮廓，从这里开始'}</h3>
                    <p>上传文件或新建设定，为故事添上第一块拼图。</p>
                  </div>
                )}
              </div>
              <div className="info-note">
                <CircleHelp size={15} />
                图片会发送给支持视觉的模型，每次最多带入前 4 张。复杂地图建议附上文字说明。
              </div>
            </>
          )}
          {page === 'chapters' && (
            <>
              <GenerationProgress
                run={project.run}
                savedChapters={project.chapters.length}
                onRetry={retryFailedChapter}
              />
              <GenerationCandidates
                project={project}
                busy={busy || running}
                dirty={dirty}
                onAccept={(candidate) =>
                  void task(async () => {
                    const saved = await projectRequest(
                      `/projects/${project.id}/candidates/${candidate.id}/accept`,
                      {
                        method: 'POST',
                        body: JSON.stringify({
                          ...(candidate.baseRevision === undefined
                            ? {}
                            : { expectedRevision: candidate.baseRevision }),
                          ...((candidate as ChapterCandidate & { recoveryStatus?: string }).recoveryStatus ===
                          'review-failed'
                            ? { acknowledgeReviewFailure: true }
                            : {}),
                        }),
                      },
                    );
                    if (acceptProject(saved)) showToast('候选稿已采用，原稿修订历史保留');
                  })
                }
                onDiscard={(candidate) =>
                  void task(async () => {
                    const saved = await projectRequest(`/projects/${project.id}/candidates/${candidate.id}`, {
                      method: 'DELETE',
                    });
                    if (acceptProject(saved)) showToast('候选稿已放弃，原稿未变');
                  })
                }
              />
              <section className="chapter-workspace">
                <aside className="chapter-list">
                  <div className="chapter-list-heading">
                    <strong>章节目录</strong>
                    <span>{project.chapters.length} 章 · 仅已保存</span>
                  </div>
                  <ChapterCatalog
                    chapters={chapters}
                    selectedId={chapterId}
                    disabled={running || busy}
                    onSelect={selectChapter}
                    onDelete={deleteChapter}
                  />
                  {!project.chapters.length && <p className="muted chapter-list-empty">还没有章节</p>}
                </aside>
                <div className="chapter-editor">
                  {chapterId ? (
                    <>
                      <div className="editor-toolbar">
                        <div className="chapter-editor-selection">
                          <span>
                            <span className={`status-dot ${dirty ? 'idle' : 'done'}`} />
                            {dirty ? '有未保存的修改' : '已保存'} · {editor.content.length.toLocaleString()}{' '}
                            字符
                          </span>
                          <ChapterPicker
                            chapters={chapters}
                            selectedId={chapterId}
                            disabled={running || busy}
                            onSelect={selectChapter}
                          />
                          <div className="chapter-prev-next">
                            <button
                              type="button"
                              className="text-button"
                              aria-label="上一已保存章节"
                              disabled={selectedChapterIndex <= 0 || running || busy}
                              onClick={() =>
                                selectedChapterIndex > 0 && selectChapter(chapters[selectedChapterIndex - 1])
                              }
                            >
                              上一章
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              aria-label="下一已保存章节"
                              disabled={
                                selectedChapterIndex < 0 ||
                                selectedChapterIndex >= chapters.length - 1 ||
                                running ||
                                busy
                              }
                              onClick={() =>
                                selectedChapterIndex >= 0 &&
                                selectedChapterIndex < chapters.length - 1 &&
                                selectChapter(chapters[selectedChapterIndex + 1])
                              }
                            >
                              下一章
                            </button>
                          </div>
                        </div>
                        <div>
                          <button
                            className="button secondary"
                            onClick={() => download(`${editor.title}.md`, editor.content)}
                          >
                            <ArrowDownToLine size={15} />
                            导出
                          </button>
                          <button
                            className="button primary"
                            disabled={!dirty || busy || running || chapterConflict}
                            onClick={saveChapter}
                          >
                            <Check size={16} />
                            保存书稿
                          </button>
                        </div>
                        <p className="editor-status" role="status">
                          {chapterConflict
                            ? '服务器版本已变化，可继续编辑；请先导出，再载入最新版本后保存。'
                            : dirty
                              ? '修改尚未保存。'
                              : '当前章节已与服务器版本一致。'}
                        </p>
                      </div>
                      {chapterConflict && (
                        <div className="generation-warning" role="alert">
                          服务器上的章节已更新或删除。你的未保存文字仍在编辑器中，可先导出再载入最新版本。
                          <button
                            className="text-button"
                            onClick={async () => {
                              if (
                                await confirmDialog(
                                  '先导出或复制当前草稿。确定丢弃编辑器内容并载入最新版本吗？',
                                )
                              ) {
                                if (chapterEditor.currentChapter)
                                  chapterEditor.selectChapter(chapterEditor.currentChapter);
                                else chapterEditor.resetEditor(project.chapters);
                              }
                            }}
                          >
                            载入最新版本
                          </button>
                        </div>
                      )}
                      <input
                        className="chapter-title"
                        aria-label="章节标题"
                        value={editor.title}
                        onChange={(e) => chapterEditor.changeEditor('title', e.target.value)}
                      />
                      <textarea
                        className="chapter-content"
                        aria-label="章节正文"
                        spellCheck={false}
                        value={editor.content}
                        onChange={(e) => chapterEditor.changeEditor('content', e.target.value)}
                      />
                    </>
                  ) : (
                    <div className="empty-state chapter-empty">
                      <span className="empty-book">
                        <BookOpen size={38} />
                      </span>
                      <h2>每个故事，都有它的第一章</h2>
                      <p>
                        准备好设定，运行创作工作流。
                        <br />
                        生成的章节会自动来到这里，等待你的打磨。
                      </p>
                      <button className="button primary" onClick={() => navigate('workflow')}>
                        <Network size={17} />
                        前往工作流
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
          {page === 'platforms' && (
            <PlatformPanel
              key={project.id}
              projectId={project.id}
              running={running}
              selectedChapterId={platformChapterId || undefined}
            />
          )}
          {page === 'settings' && (
            <SettingsPanel
              settings={settings}
              busy={busy}
              onSettingsChange={setSettings}
              onError={setError}
              onSave={(values) =>
                task(async () => {
                  setSettings(
                    await api<ModelSettings>('/settings', { method: 'PUT', body: JSON.stringify(values) }),
                  );
                  showToast('模型设置已更新');
                })
              }
            />
          )}
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={18} />
          {toast}
        </div>
      )}
      {generationEntry && (
        <GenerationModal
          key={`${project.id}/${workflowIdOf(project)}`}
          project={project}
          entry={generationEntry}
          demo={settings.mode === 'demo'}
          busy={busy || running}
          onClose={() => setGenerationEntry(null)}
          onSave={async (requirements, chapterRequirements) => {
            const saved = await projectRequest(`/projects/${project.id}/requirements`, {
              method: 'PUT',
              body: JSON.stringify({ requirements, chapterRequirements }),
            });
            if (!acceptProject(saved)) throw new Error('作品或工作流已切换，请在当前作品重新打开生成配置。');
          }}
          onRun={async (request) => {
            if (dirty) throw new Error('请先保存章节修改。');
            const projectKey = project.id;
            let submission = readPendingRunSubmission(projectKey);
            if (submission) {
              try {
                const receipt = await api<{ run: Run; project: Project }>(
                  `/projects/${projectKey}/run-requests/${encodeURIComponent(submission.key)}`,
                );
                if (!acceptProject(receipt.project)) throw new Error('已找到原运行，请返回原工作流查看。');
                clearPendingRunSubmission(projectKey);
                setGenerationEntry(null);
                showToast('已核对到原运行，未重复生成');
                return;
              } catch (failure) {
                if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
              }
              if (
                !(await confirmDialog(
                  '已确认原提交尚未创建运行。是否使用原来的章号、请求和幂等键重试？当前表单的新目标不会应用。',
                ))
              )
                return;
            }
            if (!submission) {
              const fixed = structuredClone(request);
              if (!fixed.target || fixed.target.kind === 'next') {
                const first = nextChapterNumber(project);
                const count = fixed.target?.count ?? 1;
                fixed.target =
                  count === 1
                    ? { kind: 'single', number: first }
                    : { kind: 'range', from: first, to: first + count - 1 };
              }
              submission = { key: newIdempotencyKey(), request: fixed, requestHash: JSON.stringify(fixed) };
              writePendingRunSubmission(projectKey, submission);
            }
            try {
              const started = await projectRequest(`/projects/${projectKey}/run`, {
                method: 'POST',
                headers: { 'Idempotency-Key': submission.key },
                body: JSON.stringify(submission.request),
              });
              if (!acceptProject(started))
                throw new Error('运行已提交，但当前作品已切换；请返回原作品查看状态，不要重复提交。');
              clearPendingRunSubmission(projectKey);
              setGenerationEntry(null);
              setPage('workflow');
              setInspectorTab('result');
              if (request.stepId) setSelected(request.stepId);
              showToast(
                writingWorkflow
                  ? settings.mode === 'demo'
                    ? '演示工作流已启动'
                    : '工作流已启动'
                  : '世界观工作流已启动，完成后保存到设定库',
              );
            } catch (failure) {
              const ambiguous =
                failure instanceof ApiError &&
                (failure.status === 0 ||
                  failure.status >= 500 ||
                  (failure.status >= 200 && failure.status < 300) ||
                  failure.code === 'NETWORK_ERROR' ||
                  failure.code === 'REQUEST_TIMEOUT' ||
                  failure.code === 'RUN_RESULT_UNKNOWN' ||
                  failure.retryable === true);
              if (!ambiguous) {
                clearPendingRunSubmission(projectKey);
                throw failure;
              }
              try {
                const receipt = await api<{ run: Run; project: Project }>(
                  `/projects/${projectKey}/run-requests/${encodeURIComponent(submission.key)}`,
                );
                if (receipt?.project && acceptProject(receipt.project)) {
                  clearPendingRunSubmission(projectKey);
                  setGenerationEntry(null);
                  setPage('workflow');
                  setInspectorTab('result');
                  showToast('已核对到这次运行，未重复提交');
                  return;
                }
              } catch (reconcileError) {
                if (!(reconcileError instanceof ApiError && reconcileError.status === 404)) throw failure;
              }
              throw new ApiError(
                '提交结果未知：请先刷新或查看运行记录；确认没有这次运行后，再用相同目标重新提交。',
                failure.status,
                {
                  code: 'RUN_RESULT_UNKNOWN',
                  retryable: true,
                  requestId: failure instanceof ApiError ? failure.requestId : undefined,
                  runId: failure instanceof ApiError ? failure.runId : undefined,
                },
              );
            }
          }}
        />
      )}
      {newProject && (
        <Modal busy={busy} error={error} title="开启一个新故事" close={() => setNewProject(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void task(async () => {
                const p = await api<Project>('/projects', {
                  method: 'POST',
                  body: JSON.stringify(Object.fromEntries(f)),
                });
                setProjects((all) => [...all, p]);
                activateProject(p);
                localStorage.setItem('novel-project', p.id);
                setNewProject(false);
                setPage('workflow');
                showToast('新的故事空间已创建');
              });
            }}
          >
            <label>
              作品名称
              <input name="title" placeholder="为你的故事起个名字" required maxLength={80} autoFocus />
            </label>
            <label>
              故事类型
              <select name="genre">
                <option>东方幻想</option>
                <option>科幻冒险</option>
                <option>悬疑推理</option>
                <option>都市情感</option>
                <option>历史传奇</option>
                <option>武侠仙侠</option>
                <option>现实题材</option>
                <option>成长治愈</option>
                <option>轻喜喜剧</option>
                <option>其他类型</option>
              </select>
            </label>
            <label>
              一句话简介
              <textarea
                name="description"
                placeholder="一个怎样的人，走进了怎样的故事？"
                maxLength={2000}
                rows={3}
              />
            </label>
            <button className="button primary full" disabled={busy}>
              创建作品
              <ArrowRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {addAsset && (
        <Modal busy={busy} error={error} title="添加故事设定" close={() => setAddAsset(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void task(async () => {
                const content = String(f.get('content') || '');
                if (new TextEncoder().encode(content).byteLength > TEXT_ASSET_MAX_BYTES)
                  throw new Error('文本资料不能超过 2 MiB');
                acceptProject(
                  await projectRequest(`/projects/${project.id}/assets`, {
                    method: 'POST',
                    body: JSON.stringify(Object.fromEntries(f)),
                  }),
                );
                setAddAsset(false);
                showToast('设定已加入资料库');
              });
            }}
          >
            <label>
              设定名称
              <input name="name" required maxLength={120} placeholder="例如：主角人物档案" autoFocus />
            </label>
            <label>
              设定分类
              <select name="category" defaultValue={category}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabels[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              设定内容
              <textarea
                name="content"
                required
                maxLength={TEXT_ASSET_MAX_BYTES}
                rows={9}
                placeholder="描述你的世界、人物，或接下来的剧情…"
              />
            </label>
            <button className="button primary full" disabled={busy}>
              保存设定
              <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
      {editAsset && (
        <Modal
          busy={busy}
          error={error}
          title={`编辑设定 · ${editAsset.name}`}
          close={() => setEditAsset(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void task(async () => {
                const content = String(f.get('content') || '');
                if (new TextEncoder().encode(content).byteLength > TEXT_ASSET_MAX_BYTES)
                  throw new Error('文本资料不能超过 2 MiB');
                acceptProject(
                  await projectRequest(`/projects/${project.id}/assets/${editAsset.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(Object.fromEntries(f)),
                  }),
                );
                setEditAsset(null);
                showToast('设定已更新');
              });
            }}
          >
            <label>
              设定名称
              <input name="name" defaultValue={editAsset.name} required maxLength={120} />
            </label>
            <label>
              设定分类
              <select name="category" defaultValue={editAsset.category}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabels[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              设定内容
              <textarea
                name="content"
                defaultValue={editAsset.content}
                required
                maxLength={TEXT_ASSET_MAX_BYTES}
                rows={12}
              />
            </label>
            <button className="button primary full" disabled={busy}>
              <Check size={16} />
              保存修改
            </button>
          </form>
        </Modal>
      )}
      {addNode && (
        <AddNodeDialog
          presets={nodePresets}
          busy={busy || running}
          onClose={() => setAddNode(false)}
          onAdd={async (values) => {
            const previous = projectRef.current;
            const created = await projectRequest(`/projects/${project.id}/nodes`, {
              method: 'POST',
              body: JSON.stringify({
                ...values,
                ...graphScope(),
                position: { x: 170 + project.steps.length * 25, y: 130 + project.steps.length * 18 },
              }),
            });
            if (!acceptProject(created)) throw new Error('当前工作流已变化，请刷新核对新增节点。');
            snapshotGraph(previous);
            setAddNode(false);
            showToast('节点已添加，可在画布中连接');
          }}
        />
      )}
      {workflowCreator && (
        <Modal title="新建工作流" close={() => setWorkflowCreator(false)} busy={busy}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void task(async () => {
                acceptProject(
                  await projectRequest(
                    `/projects/${project.id}/workflows`,
                    {
                      method: 'POST',
                      body: JSON.stringify({ name: data.get('name'), preset: data.get('preset') }),
                    },
                    true,
                  ),
                );
                setWorkflowCreator(false);
                showToast('工作流已创建');
              });
            }}
          >
            <label>
              工作流名称
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={`工作流 ${(project.workflows?.length || 0) + 1}`}
              />
            </label>
            <fieldset className="node-presets">
              <legend>工作流类型</legend>
              <label className="workflow-choice">
                <input type="radio" name="preset" value="world" defaultChecked /> 世界观编写（不生成章节）
              </label>
              <label className="workflow-choice">
                <input type="radio" name="preset" value="chapter" /> 章节创作模板
              </label>
              <label className="workflow-choice">
                <input type="radio" name="preset" value="blank" /> 空白工作流
              </label>
            </fieldset>
            <button className="button primary full" disabled={busy}>
              <Plus size={15} /> 创建工作流
            </button>
          </form>
        </Modal>
      )}
      {workflowConfig && (
        <Modal busy={busy} error={error} title="自动化小说工作流" close={() => setWorkflowConfig(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void task(async () => {
                const previous = projectRef.current;
                const updated = await projectRequest(`/projects/${project.id}/workflow`, {
                  method: 'PUT',
                  body: JSON.stringify({
                    ...graphScope(),
                    chapterCount: Number(f.get('chapterCount')),
                    autoGenerate: f.get('autoGenerate') === 'on',
                    auditNodeId: String(f.get('auditNodeId') || ''),
                    outputName: String(f.get('outputName') || ''),
                  }),
                });
                if (acceptProject(updated)) snapshotGraph(previous);
                setWorkflowConfig(false);
                showToast('自动化工作流设置已保存');
              });
            }}
          >
            <label>
              自动生成章节数
              <input
                name="chapterCount"
                type="number"
                min={1}
                max={GENERATION_LIMITS.maxBatchSize}
                defaultValue={project.workflow?.chapterCount || 1}
              />
            </label>
            <label className="checkbox-label">
              <input name="autoGenerate" type="checkbox" defaultChecked={project.workflow?.autoGenerate} />
              使用该章数作为续写默认值
            </label>
            <p className="info-note">
              开始和结束节点由系统固定。该章数仅作为生成对话框的续写默认值，每次运行仍需确认；不执行自动同步或正式发布。
            </p>
            <label>
              {writingWorkflow ? '默认章节名称' : '世界观名称'}
              <input
                name="outputName"
                maxLength={120}
                defaultValue={project.workflow?.outputName || ''}
                placeholder="留空时根据生成内容自动命名"
              />
            </label>
            <label>
              小说审计节点
              <select name="auditNodeId" defaultValue={project.workflow?.auditNodeId || ''}>
                <option value="">不指定</option>
                {project.steps
                  .filter((s) => s.enabled !== false && (s.kind === 'audit' || s.id === 'review'))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </label>
            <p className="info-note">
              <Link2 size={15} />
              可新建多条工作流并独立增删节点。选中节点或连线后按 Delete 删除；章节可在书稿页单独删除。
            </p>
            <button className="button primary full" disabled={busy}>
              <Check size={16} />
              保存工作流
            </button>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal wide title={preview.name} close={() => setPreview(null)}>
          <span className={`category-pill ${preview.category}`}>{categoryLabels[preview.category]}</span>
          {preview.url ? (
            <img className="asset-preview" src={preview.url} alt={preview.name} />
          ) : (
            <pre className="text-preview">{preview.content}</pre>
          )}
          <button
            className="button secondary"
            onClick={() => {
              if (preview.url) {
                const a = document.createElement('a');
                a.href = preview.url;
                a.download = preview.name;
                a.click();
              } else download(preview.name, preview.content);
            }}
          >
            <ArrowDownToLine size={16} />
            下载资料
          </button>
        </Modal>
      )}
      {platformGuide && (
        <Modal wide title="平台连接教程" close={() => setPlatformGuide(false)}>
          <div className="help-content">
            {[
              [
                '人工登录',
                '在平台页打开独立的番茄登录窗口，由你输入账号、验证码并完成验证。不要向本工具粘贴 Cookie，也不要把真实凭据填入 Mock。',
              ],
              [
                '核实并绑定',
                '平台页必须先核实真实账号与作品，再由你选择并绑定现有作品。页面适配或身份验证未通过时会停止，不会猜测目标。',
              ],
              [
                '确认一个已保存章节',
                '先在书稿页保存，点击「同步此章到草稿」后选择账号和作品，核对正文版本及预览，明确确认后才进行远端草稿写入。',
              ],
              [
                '核对结果',
                '以重新打开草稿并核对后的回执为准；结果未知时先核对，不重复创建。不同步候选违规稿，不自动正式发布。',
              ],
            ].map(([t, d], i) => (
              <div key={t}>
                <span>0{i + 1}</span>
                <section>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </section>
              </div>
            ))}
            <p className="info-note">
              <ShieldCheck size={15} />
              这是第三方本机辅助工具，不是番茄官方 API
              或官方客户端。真实页面适配与账号验收未完成前，不代表草稿同步已可用；无持久密钥时服务重启需重新登录。
            </p>
          </div>
        </Modal>
      )}
      {help && (
        <Modal title="你的第一段创作旅程" close={() => setHelp(false)}>
          <div className="help-content">
            {[
              ['创建作品', '为小说取名，选择类型，写下故事的核心灵感。'],
              ['收集故事设定', '在设定库上传地图、人物档案、剧情主线与章节要求，也可以直接新建文字设定。'],
              [
                '运行创作工作流',
                '可为同一作品创建多条工作流。默认依次执行世界观解析、剧情编排、章节规划、正文生成和一致性审校。可增删节点、编辑指令，或删除不需要的章节。',
              ],
              [
                '打磨与导出',
                '在章节书稿编辑并保存正文，导出 Markdown。生成时可指定单章或区间并设置正文要求；重生成只产生候选稿，经你对比采用后才替换原稿。',
              ],
            ].map(([t, d], i) => (
              <div key={t}>
                <span>0{i + 1}</span>
                <section>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </section>
              </div>
            ))}
            <p className="info-note">
              演示模式使用固定模板，不会调用模型。API Key 仅保存在服务进程内存中；重启后请重新填写，或通过
              .env 配置。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ChapterCatalog({
  chapters,
  selectedId,
  disabled,
  onSelect,
  onDelete,
}: {
  chapters: Chapter[];
  selectedId: string;
  disabled: boolean;
  onSelect: (chapter: Chapter) => void;
  onDelete: (chapter: Chapter) => void;
}) {
  const [start, setStart] = useState(0);
  const size = 80;
  const selectedIndex = Math.max(
    0,
    chapters.findIndex((chapter) => chapter.id === selectedId),
  );
  const safeStart =
    selectedIndex < start || selectedIndex >= start + size ? Math.max(0, selectedIndex - 10) : start;
  const visible = chapters.slice(safeStart, safeStart + size);
  return (
    <div
      onScroll={(event) => {
        const node = event.currentTarget;
        if (node.scrollTop < 40) setStart((value) => Math.max(0, value - size));
        if (node.scrollTop + node.clientHeight > node.scrollHeight - 40)
          setStart((value) => Math.min(value + size, Math.max(0, chapters.length - size)));
      }}
    >
      {visible.map((c) => (
        <div key={c.id} className={`chapter-row ${selectedId === c.id ? 'active' : ''}`}>
          <button className={selectedId === c.id ? 'active' : ''} onClick={() => onSelect(c)}>
            <span>{String(c.number).padStart(2, '0')}</span>
            <div>
              <strong>{c.title}</strong>
              <small>
                {c.content.length} 字符 · {c.mode === 'demo' ? '演示草稿' : 'AI 初稿'} · 本地 v{c.revision}
              </small>
            </div>
            <ChevronRight size={14} />
          </button>
          <button
            className="icon-button delete"
            aria-label={`删除 ${c.title}`}
            disabled={disabled}
            onClick={() => onDelete(c)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
function ChapterPicker({
  chapters,
  selectedId,
  disabled,
  onSelect,
}: {
  chapters: Chapter[];
  selectedId: string;
  disabled: boolean;
  onSelect: (chapter: Chapter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [windowStart, setWindowStart] = useState(0);
  const selected = chapters.find((chapter) => chapter.id === selectedId);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return chapters;
    return chapters.filter((chapter) => `${chapter.number} ${chapter.title}`.toLowerCase().includes(text));
  }, [chapters, query]);
  const pageSize = 40;
  const visible = filtered.slice(windowStart, windowStart + pageSize);
  return (
    <div className="chapter-picker">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selected ? `第 ${selected.number} 章 · ${selected.title}` : '选择章节'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="chapter-picker-menu" role="listbox">
          <input
            aria-label="搜索章节"
            value={query}
            placeholder="搜索章号或标题"
            onChange={(event) => {
              setQuery(event.target.value);
              setWindowStart(0);
            }}
          />
          <div
            onScroll={(event) => {
              const node = event.currentTarget;
              if (node.scrollTop + node.clientHeight > node.scrollHeight - 40)
                setWindowStart((value) =>
                  Math.min(value + pageSize, Math.max(0, filtered.length - pageSize)),
                );
            }}
          >
            {visible.map((chapter) => (
              <button
                key={chapter.id}
                type="button"
                role="option"
                aria-selected={chapter.id === selectedId}
                className={chapter.id === selectedId ? 'active' : ''}
                onClick={() => {
                  onSelect(chapter);
                  setOpen(false);
                }}
              >
                第 {chapter.number} 章 · {chapter.title}
              </button>
            ))}
            {!visible.length && <p>没有匹配章节</p>}
          </div>
        </div>
      )}
    </div>
  );
}
const themes = [
  ['system', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
  ['mtf', '蓝粉白'],
] as const;
function ThemeSwitcher() {
  const [theme, setTheme] = useState<(typeof themes)[number][0]>(() => {
    const saved = localStorage.getItem('novel-theme');
    return themes.some(([id]) => id === saved) ? (saved as (typeof themes)[number][0]) : 'system';
  });
  const [open, setOpen] = useState(false);
  const current = themes.find(([id]) => id === theme)?.[1] || '跟随系统';
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('novel-theme', theme);
  }, [theme]);
  return (
    <div className="theme-menu">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        主题 · {current}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="theme-submenu" role="menu">
          {themes.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              className={theme === id ? 'active' : ''}
              onClick={() => {
                setTheme(id);
                setOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function SettingsPanel({
  settings,
  busy,
  onSave,
  onSettingsChange,
  onError,
}: {
  settings: ModelSettings;
  busy: boolean;
  onSave: (v: object) => void;
  onSettingsChange: (settings: ModelSettings) => void;
  onError: (message: string) => void;
}) {
  const confirmDialog = useConfirm();
  const [mode, setMode] = useState(settings.mode),
    [protocol, setProtocol] = useState<ModelProtocol>(settings.protocol || 'chat-completions'),
    [key, setKey] = useState(''),
    [clearKey, setClearKey] = useState(false),
    [baseUrl, setBaseUrl] = useState(settings.baseUrl),
    [model, setModel] = useState(settings.model),
    [showModelForm, setShowModelForm] = useState(false),
    [modelBusy, setModelBusy] = useState(false),
    [newProtocol, setNewProtocol] = useState<ModelProtocol>('chat-completions');
  const modelList = settings.models || [];
  const modelGate = useRef(false);
  useEffect(() => {
    setMode(settings.mode);
    setProtocol(settings.protocol || 'chat-completions');
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
    setClearKey(false);
  }, [settings]);
  const mutateModel = async (action: () => Promise<ModelSettings>) => {
    if (modelGate.current || busy) return;
    modelGate.current = true;
    setModelBusy(true);
    try {
      onSettingsChange(await action());
    } catch (error) {
      onError(error instanceof Error ? error.message : '模型设置失败');
    } finally {
      modelGate.current = false;
      setModelBusy(false);
    }
  };
  const protocolHint = {
    responses: '将请求发送到 {Base URL}/responses，使用 instructions + input，解析 output_text。',
    'chat-completions':
      '将请求发送到 {Base URL}/chat/completions，使用 messages，解析 choices[0].message.content。',
    'anthropic-messages': '将请求发送到 {Base URL}/v1/messages，使用 x-api-key 与 anthropic-version。',
  }[protocol];
  const selectModel = (id: string) =>
    mutateModel(() => api<ModelSettings>(`/models/${id}/select`, { method: 'POST' }));
  return (
    <div className="settings-layout">
      <form
        className="settings-card"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (modelGate.current || busy) return;
          const f = new FormData(e.currentTarget);
          onSave({ ...Object.fromEntries(f), mode, protocol, apiKey: key, clearKey });
          setKey('');
        }}
      >
        <div className="settings-heading">
          <span className="icon-box draft">
            <Sparkles size={22} />
          </span>
          <div>
            <h3>模型连接</h3>
            <p>选择官方协议：Responses、Chat Completions 或 Anthropic Messages</p>
          </div>
        </div>
        <label className="field-label">运行方式</label>
        <div className="mode-options">
          <button type="button" className={mode === 'demo' ? 'active' : ''} onClick={() => setMode('demo')}>
            <WandSparkles size={19} />
            <strong>演示模式</strong>
            <small>无需密钥，体验创作流程</small>
            {mode === 'demo' && <Check size={16} />}
          </button>
          <button type="button" className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>
            <Sparkles size={19} />
            <strong>连接模型</strong>
            <small>使用 AI 生成小说内容</small>
            {mode === 'live' && <Check size={16} />}
          </button>
        </div>
        <label>
          服务地址 <span>Base URL</span>
          <input
            name="baseUrl"
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.openai.com/v1"
          />
          <small>填写 API 基础地址。协议路径由所选模式自动追加，无需手填 endpoint。</small>
        </label>
        <label>
          接口协议
          <select
            name="protocol"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ModelProtocol)}
          >
            <option value="responses">Responses API</option>
            <option value="chat-completions">Chat Completions</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <small>{protocolHint}</small>
        </label>
        <div className="model-list-heading">
          <label className="field-label">
            模型列表 <span>可切换不同服务商与路由</span>
          </label>
          <button type="button" className="text-button" onClick={() => setShowModelForm((v) => !v)}>
            <Plus size={14} /> 添加模型
          </button>
        </div>
        <div className="model-list">
          {modelList.map((m) => (
            <div className={`model-list-item ${settings.activeModelId === m.id ? 'active' : ''}`} key={m.id}>
              <div>
                <strong>{m.name}</strong>
                <small>
                  {protocolLabels[m.protocol] || m.protocol} · {m.model} · {m.baseUrl}
                </small>
              </div>
              <button
                type="button"
                className="button secondary"
                disabled={modelBusy || busy}
                onClick={() => void selectModel(m.id)}
              >
                {settings.activeModelId === m.id ? '使用中' : '切换'}
              </button>
              <button
                type="button"
                className="icon-button delete"
                aria-label={`删除模型 ${m.name}`}
                disabled={modelBusy || busy}
                onClick={async () => {
                  if (!(await confirmDialog(`确定删除模型「${m.name}」吗？`))) return;
                  await mutateModel(async () => {
                    await api(`/models/${m.id}`, { method: 'DELETE' });
                    return api<ModelSettings>('/settings');
                  });
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        {showModelForm && (
          <div className="model-form">
            <label>
              显示名称
              <input data-model-field="name" required placeholder="例如：本地 Qwen" />
            </label>
            <label>
              完整服务地址
              <input data-model-field="baseUrl" type="url" required placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              接口协议
              <select
                data-model-field="protocol"
                value={newProtocol}
                onChange={(e) => setNewProtocol(e.target.value as ModelProtocol)}
              >
                <option value="responses">Responses API</option>
                <option value="chat-completions">Chat Completions</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </label>
            <label>
              模型 ID
              <input data-model-field="model" required placeholder="gpt-4.1-mini" />
            </label>
            <label>
              API Key
              <input data-model-field="apiKey" type="password" autoComplete="off" />
            </label>
            <p className="info-note">
              {newProtocol === 'anthropic-messages'
                ? 'Anthropic 将使用 x-api-key 与 anthropic-version: 2023-06-01。'
                : newProtocol === 'responses'
                  ? 'Responses 将请求 /responses，并使用 input / max_output_tokens。'
                  : 'Chat Completions 将请求 /chat/completions，并使用 messages / max_tokens。'}
            </p>
            <button
              type="button"
              className="button primary full"
              disabled={modelBusy || busy}
              onClick={async (e) => {
                const container = e.currentTarget.closest('.model-form')!;
                const fields = Array.from(
                  container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-model-field]'),
                );
                if (fields.some((field) => !field.checkValidity())) {
                  fields.find((field) => !field.checkValidity())?.reportValidity();
                  return;
                }
                const values = Object.fromEntries(
                  fields.map((field) => [field.dataset.modelField!, field.value]),
                );
                await mutateModel(async () => {
                  await api('/models', { method: 'POST', body: JSON.stringify(values) });
                  const canonical = await api<ModelSettings>('/settings');
                  setShowModelForm(false);
                  return canonical;
                });
              }}
            >
              <Check size={15} />
              保存并加入模型列表
            </button>
          </div>
        )}
        <label>
          模型名称
          <input
            name="model"
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="输入服务商提供的模型 ID"
            maxLength={100}
          />
        </label>
        <label>
          API Key <span>{settings.hasKey ? '已配置' : '未配置'}</span>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setClearKey(false);
            }}
            placeholder={settings.hasKey ? '留空保留现有密钥' : '输入你的 API Key'}
          />
          <small>密钥不传回浏览器、不写入项目文件，仅在当前服务进程中使用。</small>
        </label>
        {settings.hasKey && (
          <label className="checkbox-label">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
            清除已保存的密钥
          </label>
        )}
        <div className="settings-save">
          <span>
            <ShieldCheck size={15} />
            仅在本机运行
          </span>
          <button className="button primary" disabled={busy || modelBusy}>
            <Check size={16} />
            保存设置
          </button>
        </div>
      </form>
      <aside className="settings-aside">
        <span className="eyebrow">A NOTE FOR WRITERS</span>
        <h2>
          你掌握方向，
          <br />
          Agent 负责落笔。
        </h2>
        <p>同一套世界观，会贯穿每个创作节点。你可以随时调整指令、重新生成，或亲手改写一段文字。</p>
        <div>
          <Globe2 size={20} />
          <strong>地图也能成为灵感</strong>
          <p>上传图片后，请选用支持视觉输入的模型。文本模型可以使用配套的地图文字描述。</p>
        </div>
        <div>
          <Clock3 size={20} />
          <strong>让故事持续生长</strong>
          <p>每次生成会参考最近三章。长篇创作建议将前文梗概整理为剧情设定。</p>
        </div>
        <p className="settings-footnote">
          界面中的配置随服务重启重置。长期配置可写入项目根目录的 .env 文件。
        </p>
      </aside>
    </div>
  );
}
