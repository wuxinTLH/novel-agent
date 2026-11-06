import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep auth-owned actions and permission checks while placing them in the app shell. */
export function ShellChromePortal({ target, children }: { target: string; children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => {
      const element = document.getElementById(target);
      if (element) setContainer(element);
      return !!element;
    };
    if (find()) return;
    const observer = new MutationObserver(() => {
      if (find()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [target]);
  return container ? createPortal(children, container) : null;
}
