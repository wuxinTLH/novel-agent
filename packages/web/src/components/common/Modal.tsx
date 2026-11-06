import { useConfirm } from './AppDialog';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ErrorBanner from './ErrorBanner';

let scrollLocks = 0;
let previousOverflow = '';
const focusable =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export default function Modal({
  title,
  description,
  children,
  close,
  wide = false,
  busy = false,
  dirty = false,
  error,
  className = '',
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  busy?: boolean;
  dirty?: boolean;
  error?: unknown;
  className?: string;
}) {
  const confirmDialog = useConfirm();
  const titleId = useId();
  const descriptionId = useId();
  const section = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const motion = useRef<Animation | null>(null);
  const props = useRef({ close, busy, dirty });
  props.current = { close, busy, dirty };
  const requestClose = async () => {
    if (props.current.busy || closing.current) return;
    if (props.current.dirty && !(await confirmDialog('有未保存的修改，确定关闭并丢弃吗？'))) return;
    if (props.current.busy || closing.current) return;
    closing.current = true;
    const panel = section.current;
    if (panel && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion.current?.cancel();
      motion.current = panel.animate(
        [{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(8px) scale(.97)' }],
        { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' },
      );
      backdrop.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      try { await motion.current.finished; } catch { return; }
    }
    props.current.close();
  };
  useEffect(() => {
    const panel = section.current;
    if (!panel) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!reduced.matches) {
      motion.current = panel.animate(
        [{ opacity: 0, transform: 'translateY(12px) scale(.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
        { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
      backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    }
    let previous = { width: panel.offsetWidth, height: panel.offsetHeight };
    const observer = new ResizeObserver(() => {
      const next = { width: panel.offsetWidth, height: panel.offsetHeight };
      if (!closing.current && !reduced.matches && next.width > 0 && next.height > 0 && previous.width > 0 && previous.height > 0 &&
          (Math.abs(next.width - previous.width) > 1 || Math.abs(next.height - previous.height) > 1)) {
        motion.current?.cancel();
        motion.current = panel.animate(
          [{ transform: `scale(${previous.width / next.width}, ${previous.height / next.height})` }, { transform: 'scale(1)' }],
          { duration: 200, easing: 'cubic-bezier(.22,1,.36,1)' },
        );
      }
      previous = next;
    });
    observer.observe(panel);
    return () => { observer.disconnect(); motion.current?.cancel(); };
  }, []);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLocks++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const panel = section.current!;
    const available = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(focusable)).filter(
        (element) => !element.hidden && element.getClientRects().length > 0,
      );
    (
      panel.querySelector<HTMLElement>('[autofocus]') ||
      available().find((element) => element.matches('input, textarea, select')) ||
      panel
    ).focus();
    const keydown = (event: KeyboardEvent) => {
      if (
        document
          .querySelectorAll('[aria-modal="true"]')
          .item(document.querySelectorAll('[aria-modal="true"]').length - 1) !== panel
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
      if (event.key === 'Tab') {
        const elements = available();
        const first = elements[0],
          last = elements.at(-1);
        if (!first) {
          event.preventDefault();
          panel.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))
        ) {
          event.preventDefault();
          last!.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !elements.includes(document.activeElement as HTMLElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div
      ref={backdrop}
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={section}
        tabIndex={-1}
        className={`modal ${wide ? 'wide' : ''} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy}
      >
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            onClick={requestClose}
            aria-label="关闭弹窗"
          >
            <X size={20} />
          </button>
        </div>
        {description && (
          <p id={descriptionId} className="modal-description">
            {description}
          </p>
        )}
        <ErrorBanner error={error} />
        {children}
      </section>
    </div>
  );
}
