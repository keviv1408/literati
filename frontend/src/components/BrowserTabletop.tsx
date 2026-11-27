'use client';

import { useEffect, useRef } from 'react';
import styles from './BrowserTabletop.module.css';

export default function BrowserTabletop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !window.WebGL2RenderingContext || !window.ResizeObserver) return;

    let cancelled = false;
    let dispose: (() => void) | undefined;
    import('./renderTabletop').then(({ renderTabletop }) => {
      if (!cancelled) dispose = renderTabletop(canvas);
    }).catch(() => {
      // The CSS felt stays visible when the chunk or graphics device is unavailable.
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} data-tabletop="" />;
}
