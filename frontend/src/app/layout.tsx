import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { GuestProvider } from '@/contexts/GuestContext';
import GuestNameModal from '@/components/GuestNameModal';
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Literati — Online Literature Card Game',
  description:
    'Play Literature (Half-Suit) card game online with friends. 6–8 players, two teams, real-time multiplayer.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Literati',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#064e3b', // emerald-950
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <GuestProvider>
          {children}
          {/* Global guest name entry modal — rendered above all content */}
          <GuestNameModal />
          {/* PWA service worker registration */}
          <ServiceWorkerRegistrar />
        </GuestProvider>
      </body>
    </html>
  );
}
