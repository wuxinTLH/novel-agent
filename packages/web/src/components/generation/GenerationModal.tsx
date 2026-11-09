import { stepDisplayLabel } from '../workflow/nodeCatalog';
import type { TranslationKey } from '../../locals/core';
import { useLocale } from '../../locals/useLocale';
import { useMemo, useRef, useState } from 'react';
import { Check, Play } from 'lucide-react';
import type { GenerationMode, Project, Requirements, RunRequest, WorkflowRunMode } from '../../../../../shared/types';
import { DEFAULT_CHARACTER_TEMPLATE } from '../../../../../shared/types';
import {
  chapterNumberSchema,
  chapterRequirementsSchema,
  emptyRequirements,
  GENERATION_LIMITS,
  requirementsSchema,
} from '../../../../../shared/generation';
import { nextChapterNumber, targetNumbers, workflowIdOf } from '../../hooks/generation/generationState';
import GenerationRequirements from './GenerationRequirements';
import Modal from '../common/Modal';

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
  const { t } = useLocale();
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
    String(entry.stepId ? 1 : (project.workflow?.autoGenerate || project.workflow?.automationMode === 'automatic') ? project.workflow.chapterCount : 1),
  );
  const [writer, setWriter] = useState(project.workflow?.outputWriterNodeId || '');
  const [settingTarget, setSettingTarget] = useState<'world' | 'character' | 'plot'>(() =>
    project.steps.some((step) => step.kind === 'character') ? 'character' : 'world',
  );
  const [settingName, setSettingName] = useState('');
  const [settingExtra, setSettingExtra] = useState('');
  const characterStep = project.steps.find((step) => step.kind === 'character' && (!entry.stepId || step.id === entry.stepId));
  const [characterCount, setCharacterCount] = useState(String(characterStep?.characterCount || 1));
  const [characterName, setCharacterName] = useState(characterStep?.characterName || '');
  const [characterGender, setCharacterGender] = useState(characterStep?.characterGender || '');
  const [characterPersonality, setCharacterPersonality] = useState(characterStep?.characterPersonality || '');
  const [characterExperience, setCharacterExperience] = useState(characterStep?.characterExperience || '');
  const [characterTemplate, setCharacterTemplate] = useState(
    characterStep?.characterTemplate || DEFAULT_CHARACTER_TEMPLATE,
  );
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [workflowMode, setWorkflowMode] = useState<WorkflowRunMode>(
    project.steps.some((step) => step.kind === 'writer' || step.id === 'draft') ? 'chapter' : 'world',
  );
  const [overwrite, setOverwrite] = useState(false);
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
    mode: workflowMode === 'world' ? 'create' : modeRef.current,
    workflowMode,
    overwrite,
    ...(workflowMode === 'world'
      ? { settingTarget, outputName: settingName.trim(), instructions: settingExtra.trim() }
      : {}),
    ...(workflowMode === 'world' && settingTarget === 'character'
      ? {
          characterCount: Math.max(1, Math.min(100, Number(characterCount) || 1)),
          characterProfile: {
            name: characterName.trim(),
            gender: characterGender.trim(),
            personality: characterPersonality.trim(),
            experience: characterExperience.trim(),
            template: characterTemplate,
          },
        }
      : {}),
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
    targetError = error instanceof Error ? error.message : t("目标无效");
  }
  const conflicts = targets.filter((target) =>
    mode === 'create'
      ? project.chapters.some((chapter) => chapter.number === target)
      : !project.chapters.some((chapter) => chapter.number === target),
  );
  if (!targetError && conflicts.length)
    targetError =
      mode === 'create'
        ? t("已有正文的章号：{value0}。请改用重生成，原稿不会直接覆盖。", { value0: conflicts.join('、') })
        : t("以下章号没有原稿：{value0}。请改用新建。", { value0: conflicts.join('、') });
  if (!targetError && writers.length > 1 && !writers.some((step) => step.id === writer))
    targetError = t("请选择本次运行的最终正文输出节点。");
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
      else setMessage(t("创作要求已保存。清空的字段和列表也已保存。"));
    } catch (failure) {
      setError(failure);
    } finally {
      gate.current = false;
      setPending(false);
    }
  };
  return (
    <Modal
      title={entry.stepId ? t("运行指定节点") : t("生成章节与创作要求")}
      description={t("目标只用于本次运行；正式章节目录只统计已保存章节。")}
      close={onClose}
      wide
      busy={locked}
      dirty={requirementsDirty}
      error={error}
      className="generation-modal"
    >
      <section className="run-controls">
        <div className="run-mode-menu">
          <span>{t("运行模式")}</span>
          <button
            type="button"
            aria-expanded={modeMenuOpen}
            disabled={locked}
            onClick={() => setModeMenuOpen((value) => !value)}
          >
            {workflowMode === 'world' ? t("世界观模式") : t("正文模式")}
          </button>
          {modeMenuOpen && (
            <div className="workflow-run-modes" role="menu" aria-label={t("运行模式")}>
              {(
                [
                  ['chapter', t("正文模式")],
                  ['world', t("世界观模式")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={workflowMode === value}
                  disabled={locked || (value === 'world'
                    ? (entry.stepId ? writers.some((step) => step.id === entry.stepId) : writers.length > 0)
                    : !entry.stepId && writers.length === 0)}
                  title={value === 'world' && writers.length > 0
                    ? t("完整正文图不能切换为设定模式，请先切换独立设定工作流。")
                    : value === 'chapter' && !writers.length ? t("此工作流没有正文节点。") : undefined}
                  onClick={() => {
                    setWorkflowMode(value);
                    setModeMenuOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <div className="run-options">
        <label className={`overwrite-option${overwrite ? ' checked' : ''}`}>
          <input
            type="checkbox"
            checked={overwrite}
            disabled={locked}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          <span>
            <strong>{t("覆盖原文")}</strong>
            <small>{workflowMode === 'world' ? t("替换同名设定") : t("替换同章正文，并保留旧版本")}</small>
          </span>
        </label>
        {workflowMode === 'world' && (
          <>
            <label>
              {t("名字")}<input
                value={settingName}
                disabled={locked}
                maxLength={120}
                placeholder={t("留空则根据内容生成")}
                onChange={(event) => setSettingName(event.target.value)}
              />
            </label>
            <label>
              {t("额外信息")}<textarea
                value={settingExtra}
                disabled={locked}
                maxLength={2000}
                rows={3}
                placeholder={t("补充必须遵守的设定、边界或禁忌")}
                onChange={(event) => setSettingExtra(event.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {workflowMode === 'world' ? (
        <>
          <label>
            {t("本次目标")}<select
              aria-label={t("本次目标")}
              value={settingTarget}
              disabled={locked}
              onChange={(event) => setSettingTarget(event.target.value as typeof settingTarget)}
            >
              <option value="world">{t("世界观编写")}</option>
              <option value="character">{t("人物编写")}</option>
              <option value="plot">{t("剧情编排")}</option>
            </select>
          </label>
          {settingTarget === 'character' && (
            <section className="character-generation-settings">
              <div className="character-generation-heading">
                <strong>{t("人物参数")}</strong>
                <span>{t("留空项按世界设定随机补全")}</span>
              </div>
              <label>
                {t("生成人物数量")}<input type="number" min={1} max={100} value={characterCount} disabled={locked} onChange={(event) => setCharacterCount(event.target.value)} />
              </label>
              <label>
                {t("名字")}<input value={characterName} disabled={locked} placeholder={t("不填则随机")} onChange={(event) => setCharacterName(event.target.value)} />
              </label>
              <label>
                {t("性别")}<input value={characterGender} disabled={locked} placeholder={t("不填则随机男女")} onChange={(event) => setCharacterGender(event.target.value)} />
              </label>
              <label>
                {t("性格")}<textarea rows={2} value={characterPersonality} disabled={locked} placeholder={t("不填则随机")} onChange={(event) => setCharacterPersonality(event.target.value)} />
              </label>
              <label>
                {t("经历")}<textarea rows={3} value={characterExperience} disabled={locked} placeholder={t("填写部分内容，Agent 会根据世界设定补全")} onChange={(event) => setCharacterExperience(event.target.value)} />
              </label>
              <label>
                {t("人物模板")}<textarea rows={12} value={characterTemplate} disabled={locked} placeholder={t("粘贴 Markdown 模板，留空使用节点模板")} onChange={(event) => setCharacterTemplate(event.target.value)} />
              </label>
            </section>
          )}
        </>
      ) : (
        <div className="generation-target">
          <label>
            {t("本次目标")}<select
              aria-label={t("本次目标")}
              value={kind}
              disabled={locked}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="next">{t("续写新章")}</option>
              <option value="single">{t("指定单章")}</option>
              <option value="range" disabled={!!entry.stepId}>
                {t("指定区间")}</option>
            </select>
          </label>
          {workflowMode === 'chapter' && (
            <div className="generation-mode-options" role="radiogroup" aria-label={t("生成方式")}>
              {(
                [
                  ['create', t("新建正文")],
                  ['regenerate', t("重生成候选")],
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
          )}
          {kind === 'next' ? (
            <label>
              {t("续写章数")}<input
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
              {kind === 'range' ? t("开始章号") : t("章号")}
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
              {t("结束章号")}<input
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
      )}
      {workflowMode === 'chapter' && writers.length > 1 && (
        <label>
          {t("最终正文输出节点")}<select value={writer} disabled={locked} onChange={(event) => setWriter(event.target.value)}>
            <option value="">{t("请选择一个正文节点")}</option>
            {writers.map((step) => (
              <option value={step.id} key={step.id}>
                {stepDisplayLabel(step, 'title', key => t(key as TranslationKey))}
              </option>
            ))}
          </select>
          <small>{t("只有该节点提交章节，其余正文节点作为中间结果。")}</small>
        </label>
      )}
      {workflowMode === 'chapter' && (
        <>
          <p className="info-note">
            {demo
              ? t("演示模式：固定模板，不调用模型，也不保证遵循文学语义。")
              : t("语义和风格要求需作者确认；硬性原文规则将逐字校验。")}{' '}
            {t('单批最多 {count} 章。不会自动同步或发布。', { count: GENERATION_LIMITS.maxBatchSize })}</p>
          {targets.length > 0 && (
            <p className="generation-target-summary">
              {t('本次目标：第 {number} 章', { number: targets[0] })}{targets.length > 1 ? t(" — 第 {value0} 章（共 {value1} 章）", { value0: targets.at(-1) ?? 0, value1: targets.length }) : ''}
              {t("。目标仅用于本次运行，不沿用到下次续写。")}</p>
          )}
          {targetError && (
            <p className="generation-warning" role="alert">
              {targetError}
            </p>
          )}
          <GenerationRequirements
            label={t("作品级正文要求（每章累加）")}
            value={global}
            disabled={locked}
            onChange={(value) => {
              setGlobal(value);
              setRequirementsDirty(true);
            }}
          />
          <div className="generation-chapter-choice">
            <label>
              {t("按章保存额外要求")}<input
                type="number"
                min={1}
                max={GENERATION_LIMITS.maxChapterNumber}
                step={1}
                value={requirementNumber}
                disabled={locked}
                onChange={(event) => setRequirementNumber(event.target.value)}
              />
            </label>
            <p>{t("可提前设置尚未生成的章号，不会创建占位章节。这里切换章号不会改变本次生成目标。")}</p>
          </div>
          {validRequirementNumber ? (
            <GenerationRequirements
              label={t("第 {value0} 章专属要求（与作品要求累加）", { value0: chapterKey })}
              value={chapterRequirement}
              disabled={locked}
              onChange={(value) => {
                setChapters((current) => ({ ...current, [chapterKey]: value }));
                setRequirementsDirty(true);
              }}
            />
          ) : (
            <p role="alert" className="generation-warning">
              {t("请输入有效的正整数章号。")}</p>
          )}
          <details className="generation-effective">
            <summary>{t("查看本次合并要求")}</summary>
            {targets.map((target) => {
              const local = chapters[String(target)] || emptyRequirements();
              return (
                <div key={target}>
                  <strong>{t('第 {value0} 章', { value0: target })}</strong>
                  <p>
                    {[global.instructions, local.instructions].filter(Boolean).join('\n') ||
                      t("未设置自然语言要求")}
                  </p>
                  <p>
                    {t("必须出现：")}{[...global.requiredText, ...local.requiredText]
                      .map((text) => JSON.stringify(text))
                      .join('、') || t("无")}
                  </p>
                  <p>
                    {t("禁止出现：")}{[...global.forbiddenText, ...local.forbiddenText]
                      .map((text) => JSON.stringify(text))
                      .join('、') || t("无")}
                  </p>
                </div>
              );
            })}
          </details>
          {requirementErrors.length > 0 && (
            <div className="generation-warning" role="alert">
              {t("要求格式或长度不合法：")}{requirementErrors.join('；')}
            </div>
          )}
          {literalConflicts.length > 0 && (
            <div className="generation-warning" role="alert">
              {t('第 {numbers} 章的必须出现文本包含禁止文本，请先解决冲突。', { numbers: literalConflicts.join(', ') })}</div>
          )}
        </>
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
          {t("只保存要求")}</button>
        <button
          type="button"
          className="button primary"
          disabled={locked || !!targetError || !!requirementErrors.length || !!literalConflicts.length}
          onClick={() => void perform(true)}
        >
          <Play size={15} />
          {pending ? t("正在提交…") : requirementsDirty ? t("保存要求并开始") : t("开始生成")}
        </button>
      </div>
    </Modal>
  );
}
