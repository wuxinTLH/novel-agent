import type { Chapter } from '../../../../../shared/types.js';

export interface RetrievedPassage { chapterNumber: number; title: string; text: string; score: number; offset: number }
export const CONTEXT_BUDGET = 120_000;

function terms(text: string): string[] {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9_]{2,}/gu) || [];
  const han = normalized.match(/\p{Script=Han}+/gu) || [];
  return [...new Set([...latin, ...han.flatMap((part) => Array.from({ length: Math.max(0, part.length - 1) }, (_, index) => part.slice(index, index + 2)))])];
}

/** Real local lexical retrieval over overlapping source passages, with source locations. */
export function retrievePassages(chapters: Chapter[], query: string, budget = 12_000): RetrievedPassage[] {
  const queryTerms = terms(query);
  if (!queryTerms.length || budget <= 0) return [];
  const passages = chapters.flatMap((chapter) => {
    const result: RetrievedPassage[] = [];
    for (let offset = 0; offset < chapter.content.length; offset += 800) {
      const text = chapter.content.slice(offset, offset + 1000);
      const tokens = new Set(terms(text));
      const score = queryTerms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
      if (score) result.push({ chapterNumber: chapter.number, title: chapter.title, text, score, offset });
      if (offset + 1000 >= chapter.content.length) break;
    }
    return result;
  }).sort((a, b) => b.score - a.score || b.chapterNumber - a.chapterNumber || a.offset - b.offset);
  const selected: RetrievedPassage[] = [];
  let remaining = budget;
  for (const passage of passages) {
    if (remaining < 200) break;
    if (selected.some((item) => item.chapterNumber === passage.chapterNumber && Math.abs(item.offset - passage.offset) < 1000)) continue;
    const text = passage.text.slice(0, remaining);
    selected.push({ ...passage, text });
    remaining -= text.length + 100;
  }
  return selected;
}

/** Character budget is explicit; mandatory requirements and current task are never silently cut. */
export function fitContextSections(sections: { label: string; text: string; budget: number }[]): string[] {
  return sections.map(({ label, text, budget }) => text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 70))}\n[${label}因上下文预算截断，未包含全文]`);
}
