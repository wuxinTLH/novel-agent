import React, { Component, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DialogProvider } from './components/AppDialog';
import '@xyflow/react/dist/style.css';
import './styles.scss';
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="route-fallback"><h1>页面发生异常</h1><p>已拦截错误，避免停留在空白页。</p><a href="/workflow">返回首页</a></section>;
  }
}
function UnknownRoute() {
  const [seconds, setSeconds] = React.useState(5);
  React.useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value - 1), 1000);
    const back = window.setTimeout(() => window.history.length > 1 ? window.history.back() : window.location.replace('/workflow'), 5000);
    return () => { window.clearInterval(timer); window.clearTimeout(back); };
  }, []);
  return <section className="route-fallback"><h1>404</h1><p>页面不存在，{Math.max(seconds, 0)} 秒后返回上一页。</p></section>;
}
const known = ['/workflow','/assets','/chapters','/platforms','/settings','/'];
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </React.StrictMode>,
);
