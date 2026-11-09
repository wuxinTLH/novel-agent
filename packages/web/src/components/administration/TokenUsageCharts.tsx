import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useLocale } from '../../locals';
import { positiveChartData, TOKEN_CHART_COLORS, type ChartDatum } from './tokenUsageHelpers';

interface Props {
  pie: ChartDatum[];
  bars: ChartDatum[];
  pieTitle: string;
  barTitle: string;
  fallbackLabel: string;
}

function Chart({ data, kind, title, fallbackLabel }: { data: ChartDatum[]; kind: 'pie' | 'bar'; title: string; fallbackLabel: string }) {
  const { locale, t } = useLocale();
  const format = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const maximum = Math.max(0, ...data.map((item) => item.value));
  const host = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let stopped = false;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 10);
    camera.position.z = 4;
    const values = positiveChartData(data);
    const dispose = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      if (renderer) {
        renderer.domElement.removeEventListener('webglcontextlost', contextLost);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        renderer = undefined;
      }
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      setUnavailable(true);
      dispose();
    };
    try {
      setUnavailable(false);
      // Do not attempt renderer construction on browsers without WebGL or ResizeObserver.
      if (!window.WebGLRenderingContext || !window.ResizeObserver) throw new Error('WebGL unavailable');
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setClearColor(0, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.setAttribute('aria-hidden', 'true');
      renderer.domElement.addEventListener('webglcontextlost', contextLost);
      element.appendChild(renderer.domElement);
      if (kind === 'pie') {
        const total = values.reduce((sum, item) => sum + item.value, 0);
        let start = Math.PI / 2;
        values.forEach((item, index) => {
          const angle = item.value / total * Math.PI * 2;
          const geometry = new THREE.RingGeometry(0.42, 1, Math.max(3, Math.ceil(angle * 32)), 1, start, angle);
          const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: TOKEN_CHART_COLORS[index % TOKEN_CHART_COLORS.length], side: THREE.DoubleSide }));
          scene.add(mesh);
          start += angle;
        });
      } else {
        const maximum = Math.max(1, ...values.map((item) => item.value));
        const count = Math.max(1, data.length);
        data.forEach((item, index) => {
          if (!Number.isFinite(item.value) || item.value <= 0) return;
          const height = item.value / maximum * 1.8;
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.8 / count * 0.72, height), new THREE.MeshBasicMaterial({ color: TOKEN_CHART_COLORS[0] }));
          mesh.position.set(-0.9 + (index + 0.5) * 1.8 / count, -0.9 + height / 2, 0);
          scene.add(mesh);
        });
      }
      const draw = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (stopped || !renderer) return;
          try {
            const width = Math.max(1, element.clientWidth);
            const height = Math.max(1, element.clientHeight);
            renderer.setSize(width, height, false);
            const aspect = width / height;
            camera.left = -1.2 * (kind === 'pie' ? Math.max(1, aspect) : 1);
            camera.right = -camera.left;
            camera.top = 1.2 * (kind === 'pie' ? Math.max(1, 1 / aspect) : 1);
            camera.bottom = -camera.top;
            camera.updateProjectionMatrix();
            renderer.render(scene, camera);
          } catch {
            setUnavailable(true);
            dispose();
          }
        });
      };
      observer = new ResizeObserver(draw);
      observer.observe(element);
      draw();
    } catch {
      setUnavailable(true);
      dispose();
    }
    return dispose;
  }, [data, kind]);

  return <figure data-testid="token-usage-chart" className="token-usage-chart">
    <figcaption>{title}</figcaption>
    {!unavailable && kind === 'bar' && <div className="token-usage-chart__scale" aria-hidden="true"><span>{format(maximum)} Token</span><span>{format(maximum / 2)}</span><span>0</span></div>}
    <div ref={host} className="token-usage-chart__canvas" aria-hidden="true" hidden={unavailable} />
    {unavailable && <p data-testid="token-usage-chart-fallback" className="token-usage-chart__fallback" role="status">{fallbackLabel}</p>}
    {!unavailable && kind === 'bar' && <>
      <div className="token-usage-chart__axis" aria-hidden="true"><span>{data[0]?.label}</span><span>{data.at(-1)?.label}</span></div>
      <div className="token-usage-chart__daily" aria-label={t('每日 Token 用量（UTC）')}>{data.map((item) => <span key={item.label} tabIndex={0} title={`${item.label}: ${format(item.value)} Token`} aria-label={`${item.label}: ${format(item.value)} Token`}><span>{item.label.slice(5)}</span><strong>{format(item.value)}</strong></span>)}</div>
    </>}
    {kind === 'pie' && <ul className="token-usage-legend">{data.map((item, index) => <li key={`${index}-${item.label}`}><i aria-hidden="true" style={{ background: TOKEN_CHART_COLORS[index % TOKEN_CHART_COLORS.length] }} /><span>{item.label}: {format(item.value)} Token ({format(total > 0 ? item.value / total * 100 : 0)}%)</span></li>)}</ul>}
  </figure>;
}

/** Dynamically imported by TokenUsagePanel: Three.js never enters the administration entry bundle. */
export default function TokenUsageCharts({ pie, bars, pieTitle, barTitle, fallbackLabel }: Props) {
  return <div className="token-usage-charts"><Chart data={pie} kind="pie" title={pieTitle} fallbackLabel={fallbackLabel} /><Chart data={bars} kind="bar" title={barTitle} fallbackLabel={fallbackLabel} /></div>;
}
