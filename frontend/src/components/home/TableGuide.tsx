'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tutorialPath } from '@/lib/appPaths';
import type { CardRank } from '@/types/game';
import GuideCard from './GuideCard';
import { chapters } from './chapters';
import { frames } from './cardPoses';
import styles from './Guide.module.css';

export default function TableGuide({ onPlay, playLabel, playDisabled, playError }: {
  onPlay: () => void;
  playLabel: ReactNode;
  playDisabled: boolean;
  playError: string;
}) {
  const [active, setActive] = useState(0);
  const section = useRef<HTMLElement>(null);
  const steps = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const chapter = chapters[active];

  useEffect(() => {
    const guide = section.current;
    const list = steps.current;
    const cards = stage.current;
    if (!guide || !list || !cards || !window.ResizeObserver || !window.IntersectionObserver) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const compact = window.matchMedia('(max-width: 760px)');
    let draw: typeof import('./animateDeal').animateDeal | undefined;
    let scheduled = 0;
    let disposed = false;
    let near = false;
    let centers: number[] = [];

    function _update() {
      scheduled = 0;
      if (!list || !cards || !centers.length) return;
      const y = window.innerHeight * (compact.matches ? 0.69 : 0.5) - list.getBoundingClientRect().top;
      const next = centers.findIndex(center => center > y);
      let progress = 0;
      if (next === -1) progress = chapters.length - 1;
      else if (next > 0) progress = next - 1 + (y - centers[next - 1]) / (centers[next] - centers[next - 1]);
      const index = Math.round(progress);
      setActive(index);
      if (draw) draw(cards, reduced.matches ? index : progress);
    }

    function _schedule() {
      if (near && !scheduled) scheduled = window.requestAnimationFrame(_update);
    }
    function _measure() {
      const top = list!.getBoundingClientRect().top;
      centers = Array.from(list!.children, (el) => {
        const rect = el.getBoundingClientRect();
        return rect.top - top + rect.height / 2;
      });
      _schedule();
    }

    const resize = new ResizeObserver(_measure);
    resize.observe(list);
    resize.observe(cards);
    const visibility = new IntersectionObserver(([entry]) => {
      near = entry.isIntersecting;
      if (!near) return;
      _measure();
      if (!draw) {
        import('./animateDeal').then(module => {
          if (disposed) return;
          draw = module.animateDeal;
          _schedule();
        }).catch(() => {});
      }
    }, { rootMargin: '200px' });
    visibility.observe(guide);
    window.addEventListener('scroll', _schedule, { passive: true });
    window.addEventListener('resize', _measure);
    reduced.addEventListener('change', _schedule);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(scheduled);
      resize.disconnect();
      visibility.disconnect();
      window.removeEventListener('scroll', _schedule);
      window.removeEventListener('resize', _measure);
      reduced.removeEventListener('change', _schedule);
    };
  }, []);

  return (
    <>
      <section ref={section} className={styles.guide} aria-label="How to play Literature">
        <figure className={styles.sticky}>
          <div className={styles.plate} data-scene={active}>
            <div className={styles.cards} ref={stage} aria-hidden="true">
              {frames[active].map((pose, i) => (
                <div className={styles.mover} key={i} style={{
                  '--x': `${pose.x}%`, '--y': `${pose.y}%`, '--angle': `${pose.angle}deg`,
                  '--flip': `${pose.flip}deg`, '--scale': pose.scale, '--alpha': pose.opacity,
                } as React.CSSProperties}>
                  <GuideCard rank={(i + 1) as CardRank} />
                </div>
              ))}
            </div>
            <div className={styles.labels} key={active} aria-hidden="true">
              {chapter.labels.map(([label, x, y]) => (
                <span key={label} style={{ left: `${x}%`, top: `${y}%` }}>{label}</span>
              ))}
            </div>
          </div>
          <figcaption className={styles.caption}>
            <span>{chapter.caption}</span>
            <nav aria-label="Guide chapters">
              {active > 0 && <a href={`#lesson-${active}`} aria-label="Previous chapter">←</a>}
              <span>{String(active + 1).padStart(2, '0')} / 10</span>
              <a href={active === 9 ? '#full-tutorial' : `#lesson-${active + 2}`} aria-label={active === 9 ? 'Go to full tutorial' : 'Next chapter'}>→</a>
            </nav>
          </figcaption>
        </figure>
        <div className={styles.steps} ref={steps}>
          {chapters.map((step, i) => (
            <article key={step.title} id={`lesson-${i + 1}`} className={styles.step} tabIndex={-1}>
              <div>
                <div className={styles.index}>Table guide <span>/</span> {String(i + 1).padStart(2, '0')}</div>
                <h2>{step.title}</h2>
                <p>{step.copy}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
      <footer id="full-tutorial" className={styles.footer}>
        <div>
          <h2>Still don’t understand?</h2>
          <a href={tutorialPath()}>Do the full interactive tutorial <span aria-hidden="true">↗</span></a>
          <small>10–15 min</small>
        </div>
        <div>
          <h2>The easiest way to learn is to play once.</h2>
          <button type="button" disabled={playDisabled} onClick={onPlay}>{playLabel}</button>
          <small>You and five bots at a private table.</small>
          {playError && <p role="alert">{playError}</p>}
        </div>
      </footer>
    </>
  );
}
