import type { ModelSettings, Project, Step } from '../../shared/types';

/** Mirrors runtime model selection; an explicit unavailable model never silently falls back. */
export function nodeModelSummary(step: Step, settings: ModelSettings) {
  if (step.modelId) {
    const model = settings.models?.find((item) => item.id === step.modelId);
    if (!model) return { label: '指定模型已删除', hint: '请选择可用模型或切换为跟随全局模型。' };
    if (!model.enabled || !model.hasKey)
      return { label: `${model.name} · 不可用`, hint: '此模型已禁用或未配置密钥，运行前请先修复配置。' };
    return { label: `${model.name} · ${model.model}`, hint: '此节点使用单独指定的模型。' };
  }
  return settings.mode === 'demo'
    ? { label: '演示模板（不调用模型）', hint: '演示结果仅用于检查流程，不代表真实 AI 创作。' }
    : { label: settings.model, hint: '此节点跟随全局模型，使用设定资料与上游结果进行创作。' };
}

export function nodeContextSummary(step: Step, project: Project) {
  const assets = step.assetIds?.length
    ? project.assets.filter((asset) => step.assetIds!.includes(asset.id))
    : project.assets;
  const upstream = (project.workflow?.edges || [])
    .filter((edge) => edge.target === step.id)
    .map((edge) => project.steps.find((item) => item.id === edge.source))
    .filter((item): item is Step => !!item && item.kind !== 'start' && item.enabled !== false);
  return { assets, upstream };
}
