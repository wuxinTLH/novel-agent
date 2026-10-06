import { createContext, useContext, useState } from 'react';

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
  const confirm = (message: string, options: ConfirmOptions = {}) =>
    new Promise<boolean>((resolve) => setRequest({ message, options, resolve }));
  const close = (value: boolean) => {
    request?.resolve(value);
    setRequest(null);
  };
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
