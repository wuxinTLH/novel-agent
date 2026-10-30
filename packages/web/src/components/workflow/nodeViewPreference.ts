export type NodeView = 'grid' | 'list' | 'menu';
export const NODE_VIEW_KEY = 'novel-agent.node-picker.view';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readNodeView(storage?: PreferenceStorage): NodeView {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(NODE_VIEW_KEY);
    return value === 'list' || value === 'menu' || value === 'grid' ? value : 'grid';
  } catch { return 'grid'; }
}

export function saveNodeView(view: NodeView, storage?: PreferenceStorage): void {
  try { (storage ?? globalThis.localStorage)?.setItem(NODE_VIEW_KEY, view); }
  catch { /* Storage denial must not prevent switching the current view. */ }
}
