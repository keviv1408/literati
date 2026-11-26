import type { Page } from '@playwright/test';
import type { Seat } from './seats';

export const ERROR_VIEWS = [
  'ws-error-banner',
  'generic-error-view',
  'server-unreachable-view',
  'not-found-view',
  'abandoned-view',
  'cancelled-view',
  'invalid-format-view',
];

declare global {
  interface Window {
    __e2e?: number;
    __errorViews?: string[];
  }
}

export async function installPageObserver(page: Page): Promise<void> {
  await page.evaluate((ids) => {
    const views: string[] = (window.__errorViews = []);
    const selector = ids.map((id) => `[data-testid="${id}"]`).join(',');
    const note = (id: string | null) => {
      if (id !== null && ids.includes(id)) views.push(id);
    };
    const noteTree = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(selector)) note(node.getAttribute('data-testid'));
      node.querySelectorAll(selector).forEach((found) => note(found.getAttribute('data-testid')));
    };
    noteTree(document.body);
    // React swaps data-testid on reused nodes and a view can vanish before the callback, so read the records.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          note(record.oldValue);
          note((record.target as Element).getAttribute('data-testid'));
        } else {
          record.addedNodes.forEach(noteTree);
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
      attributeOldValue: true,
    });
  }, ERROR_VIEWS);
}

export async function pageProblems(seat: Seat, gameUrl: string): Promise<string[]> {
  let seen: { marker: number | undefined; views: string[] };
  try {
    seen = await seat.page.evaluate(() => ({ marker: window.__e2e, views: window.__errorViews ?? [] }));
  } catch (err) {
    return [`the page did not answer: ${_firstLine(err)}`];
  }
  const problems: string[] = [];
  if (seen.marker !== 1) problems.push('window.__e2e is gone: the page reloaded');
  if (seat.loads > 0) problems.push(`the page loaded ${seat.loads} time(s) after the game started`);
  const url = seat.page.url();
  // The query string and fragment are cut, so nothing a URL might carry reaches the message.
  if (url !== gameUrl) problems.push(`the page left the game for ${url.split(/[?#]/)[0]}`);
  if (seen.views.length > 0) problems.push(`the page showed ${[...new Set(seen.views)].join(', ')}`);
  if (seat.authCalls.length > 0) {
    problems.push(`the page called ${[...new Set(seat.authCalls)].join(', ')} after its first game_init`);
  }
  return problems;
}

function _firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0];
}
