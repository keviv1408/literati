'use client';

import { useEffect, useRef } from 'react';
import styles from './BrowserTabletop.module.css';

// Gate the import itself so the native bundle can omit Three.js.
const loadTabletop = process.env.NEXT_PUBLIC_BUILD_TARGET === 'android'
  ? null
  : () => import('./renderTabletop');

export default function BrowserTabletop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!loadTabletop || !canvas || !window.WebGL2RenderingContext || !window.ResizeObserver) return;

    let cancelled = false;
    let dispose: (() => void) | undefined;
    loadTabletop().then(({ renderTabletop }) => {
      if (!cancelled) dispose = renderTabletop(canvas);
    }).catch(() => {
      // The CSS felt stays visible when the chunk or graphics device is unavailable.
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return loadTabletop ? <canvas ref={canvasRef} className={styles.canvas} data-tabletop="" /> : null;
}
