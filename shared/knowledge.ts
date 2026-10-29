export const knowledgeFactTypes = ['character', 'relationship', 'timeline', 'foreshadow', 'fact'] as const;
export type KnowledgeFactType = (typeof knowledgeFactTypes)[number];

export interface KnowledgeFact {
  id: string;
  type: KnowledgeFactType;
  title: string;
  content: string;
  chapterIds: string[];
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeFactInput {
  type: KnowledgeFactType;
  title: string;
  content: string;
  chapterIds?: string[];
  tags?: string[];
}
