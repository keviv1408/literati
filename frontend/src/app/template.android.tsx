'use client';

import { usePathname } from 'next/navigation';
import Template from './template';

export default function AndroidTemplate({ children }: { children: React.ReactNode }) {
  // The native splash already covers the entrance to home, lobby, and game.
  if (usePathname() === '/') return <div className="min-h-dvh bg-felt">{children}</div>;
  return <Template>{children}</Template>;
}
