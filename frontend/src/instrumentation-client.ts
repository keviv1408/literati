import posthog from 'posthog-js';
import { redactUrls, reportPendingSocketDrop } from '@/lib/analytics';

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (token && host) {
  posthog.init(token, {
    api_host: host,
    defaults: '2026-08-30',
    capture_exceptions: true,
    capture_pageview: 'history_change',
    before_send: redactUrls,
    logs: {
      serviceName: 'literati-frontend',
      environment: process.env.NODE_ENV ?? 'production',
    },
  });
  reportPendingSocketDrop();
} else if (process.env.NODE_ENV === 'development') {
  const missingVariable = token
    ? 'NEXT_PUBLIC_POSTHOG_HOST'
    : 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN';
  throw new Error(
    `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
  );
}
