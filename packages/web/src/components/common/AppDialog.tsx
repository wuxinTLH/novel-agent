import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type ConfirmOptions = { title?: string; confirmText?: string; danger?: boolean };
type Request = { message: string; options: ConfirmOptions; resolve: (value: boolean) => void };
const DialogContext = createContext<(message: string, options?: ConfirmOptions) => Promise<boolean>>(
  async () => false,
);

export function useConfirm() {
  return useContext(DialogContext);
}
export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Request | null>(null);
  const confirm = useCallback((message: string, options: ConfirmOptions = {}) => {
    // Fail closed on concurrent requests instead of orphaning the first promise.
    if (pending.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { message, options, resolve };
      pending.current = next;
      setRequest(next);
    });
  }, []);
  const close = (value: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.resolve(value);
  };
  useEffect(() => () => {
    pending.current?.resolve(false);
    pending.current = null;
  }, []);
  return (
    <DialogContext.Provider value={confirm}>
      {children}
      {request && (
        <div className="app-dialog-backdrop" role="presentation">
          <section
            className="app-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
          >
            <h2 id="app-dialog-title">{request.options.title || '请确认'}</h2>
            <p>{request.message}</p>
            <div>
              <button type="button" className="button secondary" onClick={() => close(false)}>
                取消
              </button>
              <button
                type="button"
                className={`button ${request.options.danger ? 'danger' : 'primary'}`}
                onClick={() => close(true)}
              >
                {request.options.confirmText || '确定'}
              </button>
            </div>
          </section>
        </div>
      )}
    </DialogContext.Provider>
  );
}
