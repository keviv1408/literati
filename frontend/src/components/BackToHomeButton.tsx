import type { ComponentPropsWithoutRef } from 'react';

type BackToHomeProps = ComponentPropsWithoutRef<'button'> & { variant?: 'default' | 'felt' };

export default function BackToHomeButton({ variant = 'default', className = '', ...props }: BackToHomeProps) {
  const colors = variant === 'felt'
    ? 'border-sage text-paper hover:bg-felt-hover focus-visible:outline-sage'
    : 'border-emerald-600 bg-emerald-900 text-emerald-50 hover:bg-emerald-800 focus-visible:outline-emerald-300';
  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-5 py-2 text-sm font-semibold focus-visible:outline-2 ${colors} ${className}`}
      {...props}
    >
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" className="size-5 shrink-0">
        <use href="/icons/high-diamond.svg#diamond" />
      </svg>
      Back to Home
    </button>
  );
}
