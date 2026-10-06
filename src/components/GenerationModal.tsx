import { useMemo, useRef, useState } from 'react';
import { Check, Play } from 'lucide-react';
import type { GenerationMode, Project, Requirements, RunRequest } from '../../shared/types';
import {
  chapterNumberSchema,
  chapterRequirementsSchema,
  emptyRequirements,
  GENERATION_LIMITS,
  requirementsSchema,
} from '../../shared/generation';
import { nextChapterNumber, targetNumbers, workflowIdOf } from '../hooks/generationState';
import GenerationRequirements from './GenerationRequirements';
import Modal from './Modal';

export type GenerationEntry = { stepId?: string; number?: number; mode?: GenerationMode };
export default function GenerationModal({
  project,
  entry,
  demo,
  busy,
  onClose,
  onSave,
  onRun,
}: {
  project: Project;
  entry: GenerationEntry;
  demo: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (requirements: Requirements, chapterRequirements: Record<string, Requirements>) => Promise<void>;
  onRun: (request: RunRequest) => Promise<void>;
}) {
  const [kind, setKind] = useState<'next' | 'single' | 'range'>(entry.number ? 'single' : 'next');
  const [mode, setModeState] = useState<GenerationMode>(entry.mode || 'create');
  const modeRef = useRef<GenerationMode>(entry.mode || 'create');
  const setMode = (value: GenerationMode) => {
    modeRef.current = value;
    setModeState(value);
  };
  const [number, setNumber] = useState(String(entry.number || nextChapterNumber(project)));
  const [to, setTo] = useState(String(entry.number || nextChapterNumber(project)));
  const [count, setCount] = useState(
    String(entry.stepId ? 1 : project.workflow?.autoGenerate ? project.workflow.chapterCount : 1),
  );
  const [writer, setWriter] = useState(project.workflow?.outputWriterNodeId || '');
  const [global, setGlobal] = useState<Requirements>(() =>
    structuredClone(project.requirements || emptyRequirements()),
  );
  const [chapters, setChapters] = useState<Record<string, Requirements>>(() =>
    structuredClone(project.chapterRequirements || {}),
  );
  const [requirementNumber, setRequirementNumber] = useState(
    String(entry.number || nextChapterNumber(project)),
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [requirementsDirty, setRequirementsDirty] = useState(false);
  const gate = useRef(false);
  const writers = useMemo(
    () =>
      project.steps.filter(
        (step) => step.enabled !== false && (step.kind === 'writer' || step.id === 'draft'),
      ),
    [project.steps],
  );
  const request: RunRequest = {
    workflowId: workflowIdOf(project),
    ...(entry.stepId ? { stepId: entry.stepId } : {}),
    target:
      kind === 'next'
        ? { kind, count: Number(count) }
        : kind === 'single'
          ? { kind, number: Number(number) }
          : { kind, from: Number(number), to: Number(to) },
    mode: modeRef.current,
    ...(writers.length === 1
      ? { outputWriterNodeId: writers[0].id }
      : writer
        ? { outputWriterNodeId: writer }
        : {}),
  };
  let targets: number[] = [];
  let targetError = '';
  try {
    targets = targetNumbers(project, request);
  } catch (error) {
    targetError = error instanceof Error ? error.message : '目标无效';
  }
  const conflicts = targets.filter((target) =>
    mode === 'create'
      ? project.chapters.some((chapter) => chapter.number === target)
      : !project.chapters.some((chapter) => chapter.number === target),
  );
  if (!targetError && conflicts.length)
    targetError =
      mode === 'create'
        ? `已有正文的章号：${conflicts.join('、')}。请改用重生成，原稿不会直接覆盖。`
        : `以下章号没有原稿：${conflicts.join('、')}。请改用新建。`;
  if (!targetError && writers.length > 1 && !writers.some((step) => step.id === writer))
    targetError = '请选择本次运行的最终正文输出节点。';
  const validRequirementNumber = chapterNumberSchema.safeParse(Number(requirementNumber)).success;
  const chapterKey = String(Number(requirementNumber));
  const chapterRequirement = validRequirementNumber
    ? chapters[chapterKey] || emptyRequirements()
    : emptyRequirements();
  const requirementErrors = [
    ...(requirementsSchema.safeParse(global).error?.issues || []),
    ...(chapterRequirementsSchema.safeParse(chapters).error?.issues || []),
  ].map((issue) => `${issue.path.join('.')} ${issue.message}`);
  const literalConflicts = targets.flatMap((target) => {
    const local = chapters[String(target)] || emptyRequirements();
    const required = [...global.requiredText, ...local.requiredText];
    const forbidden = [...global.forbiddenText, ...local.forbiddenText];
    return required.some((text) => forbidden.some((banned) => banned.length > 0 && text.includes(banned)))
      ? [target]
      : [];
  });
  const locked = pending || busy;
  const perform = async (run: boolean) => {
    if (gate.current) return;
    if (requirementErrors.length || (run && (targetError || literalConflicts.length))) return;
    gate.current = true;
    setPending(true);
    setMessage('');
    setError(undefined);
    try {
      if (requirementsDirty) {
        await onSave(global, chapters);
        setRequirementsDirty(false);
      }
      if (run) await onRun(request);
      else setMessage('创作要求已保存。清空的字段和列表也已保存。');
    } catch (failure) {
      setError(failure);
    } finally {
      gate.current = false;
      setPending(false);
    }
  };
  return (
    <Modal
      title={entry.stepId ? '运行指定节点' : '生成章节与创作要求'}
      description="目标只用于本次运行；正式章节目录只统计已保存章节。"
      close={onClose}
      wide
      busy={locked}
      dirty={requirementsDirty}
      error={error}
      className="generation-modal"
    >
      <div className="generation-target">
        <label>
          本次目标
          <select
            aria-label="本次目标"
            value={kind}
            disabled={locked}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="next">续写新章</option>
            <option value="single">指定单章</option>
            <option value="range" disabled={!!entry.stepId}>
              指定区间
            </option>
          </select>
        </label>
        <div className="generation-mode-options" role="radiogroup" aria-label="生成方式">
          {(
            [
              ['create', '新建正文'],
              ['regenerate', '重生成候选'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-generation-mode={value}
              aria-pressed={mode === value}
              disabled={locked}
              onClick={(event) => setMode(event.currentTarget.dataset.generationMode as GenerationMode)}
            >
              {label}
            </button>
          ))}
        </div>
        {kind === 'next' ? (
          <label>
            续写章数
            <input
              type="number"
              min={1}
              max={entry.stepId ? 1 : GENERATION_LIMITS.maxBatchSize}
              step={1}
              value={count}
              disabled={locked || !!entry.stepId}
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
        ) : (
          <label>
            {kind === 'range' ? '开始章号' : '章号'}
            <input
              type="number"
              min={1}
              max={GENERATION_LIMITS.maxChapterNumber}
              step={1}
              value={number}
              disabled={locked}
              onChange={(event) => setNumber(event.target.value)}
            />
          </label>
        )}
        {kind === 'range' && (
          <label>
            结束章号
            <input
              type="number"
              min={1}
              max={GENERATION_LIMITS.maxChapterNumber}
              step={1}
              value={to}
              disabled={locked}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        )}
      </div>
      {writers.length > 1 && (
        <label>
          最终正文输出节点
          <select value={writer} disabled={locked} onChange={(event) => setWriter(event.target.value)}>
            <option value="">请选择一个正文节点</option>
            {writers.map((step) => (
              <option value={step.id} key={step.id}>
                {step.title}
              </option>
            ))}
          </select>
          <small>只有该节点提交章节，其余正文节点作为中间结果。</small>
        </label>
      )}
      <p className="info-note">
        {demo
          ? '演示模式：固定模板，不调用模型，也不保证遵循文学语义。'
          : '语义和风格要求需作者确认；硬性原文规则将逐字校验。'}{' '}
        单批最多 {GENERATION_LIMITS.maxBatchSize} 章。不会自动同步或发布。
      </p>
      {targets.length > 0 && (
        <p className="generation-target-summary">
          本次目标：第 {targets[0]} 章
          {targets.length > 1 ? ` — 第 ${targets.at(-1)} 章（共 ${targets.length} 章）` : ''}
          。目标仅用于本次运行，不沿用到下次续写。
        </p>
      )}
      {targetError && (
        <p className="generation-warning" role="alert">
          {targetError}
        </p>
      )}
      <GenerationRequirements
        label="作品级正文要求（每章累加）"
        value={global}
        disabled={locked}
        onChange={(value) => {
          setGlobal(value);
          setRequirementsDirty(true);
        }}
      />
      <div className="generation-chapter-choice">
        <label>
          按章保存额外要求
          <input
            type="number"
            min={1}
            max={GENERATION_LIMITS.maxChapterNumber}
            step={1}
            value={requirementNumber}
            disabled={locked}
            onChange={(event) => setRequirementNumber(event.target.value)}
          />
        </label>
        <p>可提前设置尚未生成的章号，不会创建占位章节。这里切换章号不会改变本次生成目标。</p>
      </div>
      {validRequirementNumber ? (
        <GenerationRequirements
          label={`第 ${chapterKey} 章专属要求（与作品要求累加）`}
          value={chapterRequirement}
          disabled={locked}
          onChange={(value) => {
            setChapters((current) => ({ ...current, [chapterKey]: value }));
            setRequirementsDirty(true);
          }}
        />
      ) : (
        <p role="alert" className="generation-warning">
          请输入有效的正整数章号。
        </p>
      )}
      <details className="generation-effective">
        <summary>查看本次合并要求</summary>
        {targets.map((target) => {
          const local = chapters[String(target)] || emptyRequirements();
          return (
            <div key={target}>
              <strong>第 {target} 章</strong>
              <p>
                {[global.instructions, local.instructions].filter(Boolean).join('\n') || '未设置自然语言要求'}
              </p>
              <p>
                必须出现：
                {[...global.requiredText, ...local.requiredText]
                  .map((text) => JSON.stringify(text))
                  .join('、') || '无'}
              </p>
              <p>
                禁止出现：
                {[...global.forbiddenText, ...local.forbiddenText]
                  .map((text) => JSON.stringify(text))
                  .join('、') || '无'}
              </p>
            </div>
          );
        })}
      </details>
      {requirementErrors.length > 0 && (
        <div className="generation-warning" role="alert">
          要求格式或长度不合法：{requirementErrors.join('；')}
        </div>
      )}
      {literalConflicts.length > 0 && (
        <div className="generation-warning" role="alert">
          第 {literalConflicts.join('、')} 章的必须出现文本包含禁止文本，请先解决冲突。
        </div>
      )}
      {message && (
        <p className="info-note" role="status">
          {message}
        </p>
      )}
      <div className="generation-actions">
        <button
          type="button"
          className="button secondary"
          disabled={locked || !!requirementErrors.length || !requirementsDirty}
          onClick={() => void perform(false)}
        >
          <Check size={15} />
          只保存要求
        </button>
        <button
          type="button"
          className="button primary"
          disabled={locked || !!targetError || !!requirementErrors.length || !!literalConflicts.length}
          onClick={() => void perform(true)}
        >
          <Play size={15} />
          {pending ? '正在提交…' : requirementsDirty ? '保存要求并开始' : '开始生成'}
        </button>
      </div>
    </Modal>
  );
}
