import type { ComponentPropsWithoutRef } from 'react';

export default function BackToHomeButton({ className = '', ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-600 bg-emerald-900 px-5 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-emerald-300 ${className}`}
      {...props}
    >
      <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" className="size-5 shrink-0">
        <use href="/icons/high-diamond.svg#diamond" />
      </svg>
      Back to Home
    </button>
  );
}
