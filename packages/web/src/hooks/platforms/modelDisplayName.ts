import type { ModelProfile } from '../../../../../shared/types';
import type { Translator } from '../../locals/core';

/** Translate only the unchanged system seed label, never arbitrary user model names. */
export function seedModelDisplayName(t: Translator, model: Pick<ModelProfile, 'id' | 'name'>): string {
  return model.id === 'default' && model.name === '默认模型' ? t('默认模型') : model.name;
}
