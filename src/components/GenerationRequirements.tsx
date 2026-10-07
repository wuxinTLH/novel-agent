import { Plus, Trash2 } from 'lucide-react';
import type { Requirements } from '../../shared/types';
import { GENERATION_LIMITS } from '../../shared/generation';

export default function GenerationRequirements({
  value,
  onChange,
  disabled = false,
  label,
}: {
  value: Requirements;
  onChange: (value: Requirements) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <fieldset className="generation-requirements" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        创作要求
        <textarea
          aria-label="创作要求"
          rows={3}
          value={value.instructions}
          placeholder="剧情、人物、视角、风格等。需要融入正文，不是输出检查清单。"
          onChange={(event) => onChange({ ...value, instructions: event.target.value })}
        />
        <small>
          {value.instructions.length} / {GENERATION_LIMITS.maxInstructionsLength} 字符 ·
          语义符合程度由作者确认
        </small>
      </label>
      <div className="word-count-settings">
        <strong>章节字数</strong>
        <div>
          {(
            [
              ['min', '最少'],
              ['target', '预计'],
              ['max', '最多'],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                min={1}
                max={200000}
                value={value.wordCount?.[field] || ''}
                placeholder="不限"
                onChange={(event) =>
                  onChange({
                    ...value,
                    wordCount: {
                      ...value.wordCount,
                      [field]: event.target.value ? Number(event.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <small>单位为中文字符。预计值应落在最少与最多之间。</small>
      </div>
      {(['requiredText', 'forbiddenText'] as const).map((field) => (
        <div key={field} className="literal-requirements">
          <div className="literal-heading">
            <strong>{field === 'requiredText' ? '必须原文出现' : '禁止出现的原文'}</strong>
            <button
              type="button"
              className="text-button"
              disabled={value[field].length >= GENERATION_LIMITS.maxLiteralItems}
              onClick={() => onChange({ ...value, [field]: [...value[field], ''] })}
            >
              <Plus size={13} />
              添加一项
            </button>
          </div>
          {value[field].map((text, index) => (
            <div className="literal-row" key={index}>
              <textarea
                rows={1}
                aria-label={`${label}${field === 'requiredText' ? '必须出现' : '禁止出现'}第 ${index + 1} 项`}
                value={text}
                placeholder="逐字匹配，保留空格与换行；不需要时请删除这一项"
                onChange={(event) =>
                  onChange({
                    ...value,
                    [field]: value[field].map((item, i) => (i === index ? event.target.value : item)),
                  })
                }
              />
              <button
                type="button"
                className="icon-button delete"
                aria-label={`删除第 ${index + 1} 项`}
                onClick={() => onChange({ ...value, [field]: value[field].filter((_, i) => i !== index) })}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <small>
            {value[field].length} / {GENERATION_LIMITS.maxLiteralItems} 项，每项最多{' '}
            {GENERATION_LIMITS.maxLiteralLength} 字符；匹配区分大小写。
          </small>
        </div>
      ))}
    </fieldset>
  );
}
