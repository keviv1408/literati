'use client';

import NextError from 'next/error';
import { useEffect } from 'react';
import { trackException } from '@/lib/analytics';

export default function GlobalError({ error }: Readonly<{ error: Error & { digest?: string } }>) {
  // The root boundary swallows render errors, so exception autocapture never sees them.
  useEffect(() => {
    trackException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
