'use client';

/**
 * ServiceWorkerRegistrar
 * Registers the PWA service worker on mount (client-side only).
 * Renders nothing to the DOM.
 */

import { useEffect } from 'react';

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // Avoid stale dev caches causing hydration mismatches while iterating locally.
    if (process.env.NODE_ENV !== 'production') {
      if (typeof navigator.serviceWorker.getRegistrations === 'function') {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) =>
            Promise.all(registrations.map((registration) => registration.unregister()))
          )
          .catch(() => {});
      }

      if ('caches' in window) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
          .catch(() => {});
      }

      return;
    }

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[SW] Registered, scope:', reg.scope);
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
  }, []);

  return null;
}
