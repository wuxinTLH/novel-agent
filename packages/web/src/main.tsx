import React, { Component, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { useLocale } from './locals/useLocale';
import { runtimeT } from './locals/runtimeTranslate';
import App from './app/App';
import AuthGate from './components/auth/AuthGate';
import { DialogProvider } from './components/common/AppDialog';
import '@xyflow/react/dist/style.css';
import './styles/styles.scss';
import './components/workflow/add-node-dialog.scss';
import './components/knowledge/KnowledgePanel.scss';
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="route-fallback">
        <h1>{runtimeT('页面发生异常')}</h1>
        <p>{runtimeT('已拦截错误，避免停留在空白页。')}</p>
        <a href="/workflow">{runtimeT('返回首页')}</a>
      </section>
    );
  }
}
function UnknownRoute() {
  useLocale();
  const [seconds, setSeconds] = React.useState(5);
  React.useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value - 1), 1000);
    const back = window.setTimeout(
      () => (window.history.length > 1 ? window.history.back() : window.location.replace('/workflow')),
      5000,
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(back);
    };
  }, []);
  return (
    <section className="route-fallback">
      <h1>404</h1>
      <p>{runtimeT('页面不存在，{x0} 秒后返回上一页。', { x0: Math.max(seconds, 0) })}</p>
    </section>
  );
}
const known = ['/workflow', '/assets', '/chapters', '/platforms', '/settings', '/'];
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </DialogProvider>
  </React.StrictMode>,
);
