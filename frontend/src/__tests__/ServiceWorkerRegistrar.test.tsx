/**
 * Tests for the ServiceWorkerRegistrar component.
 *
 * Verifies that the service worker is registered (or gracefully skipped)
 * depending on browser support.
 */

import React from 'react';
import { render } from '@testing-library/react';
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar';

// ─── helpers ────────────────────────────────────────────────────────────────

function mockServiceWorker(
  registerImpl: () => Promise<Partial<ServiceWorkerRegistration>>
) {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: jest.fn(registerImpl) },
    configurable: true,
    writable: true,
  });
}

function removeServiceWorker() {
  // Simulate a browser that doesn't support service workers by deleting
  // the property entirely so that `'serviceWorker' in navigator` is false.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (navigator as any).serviceWorker;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('ServiceWorkerRegistrar', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders nothing to the DOM', () => {
    mockServiceWorker(() => Promise.resolve({ scope: '/' }));
    const { container } = render(<ServiceWorkerRegistrar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('registers /sw.js with scope "/" when serviceWorker is supported', async () => {
    const mockRegister = jest.fn(() => Promise.resolve({ scope: '/' }));
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: mockRegister },
      configurable: true,
      writable: true,
    });

    render(<ServiceWorkerRegistrar />);

    // useEffect fires after render — flush microtasks
    await Promise.resolve();

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does not throw when serviceWorker is not in navigator', () => {
    removeServiceWorker();
    expect(() => render(<ServiceWorkerRegistrar />)).not.toThrow();
  });

  it('handles registration failure without throwing', async () => {
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: jest.fn(() => Promise.reject(new Error('SW install failed'))),
      },
      configurable: true,
      writable: true,
    });

    render(<ServiceWorkerRegistrar />);
    // Let promises settle
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[SW] Registration failed:',
      expect.any(Error)
    );
  });
});
