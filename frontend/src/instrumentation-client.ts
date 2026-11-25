import posthog from 'posthog-js';
import { redactUrls, reportPendingSocketDrop } from '@/lib/analytics';

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  try {
    posthog.init(key, {
      api_host: 'https://eu.i.posthog.com',
      defaults: '2026-08-30',
      autocapture: false,
      disable_session_recording: true,
      capture_exceptions: true,
      capture_pageview: 'history_change',
      // Explicit false so PostHog project settings cannot switch these on remotely.
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_performance: false,
      // The /flags request sends person properties with the raw page URL and skips before_send.
      advanced_disable_flags: true,
      before_send: redactUrls,
    });
    reportPendingSocketDrop();
  } catch {
    // Tracking must never stop the app from loading.
  }
}
