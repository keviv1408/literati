'use client';

import { useEffect, useRef, useState } from 'react';
import { isAndroidBuild } from '@/lib/appPaths';

export default function LobbyInviteButton({ roomCode, inviteLink }: { roomCode: string; inviteLink?: string }) {
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (manualLink) linkInput.current?.select();
  }, [manualLink]);

  async function _inviteFriends() {
    let url: string;
    if (isAndroidBuild()) {
      if (!inviteLink) {
        setShowUnavailable(true);
        return;
      }
      url = inviteLink;
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.isNativePlatform()) {
          const { Share } = await import('@capacitor/share');
          if ((await Share.canShare()).value) {
            await Share.share({ title: 'Play Literati', url });
            return;
          }
          return _copyInvite(url);
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Share canceled') return;
        return _copyInvite(url);
      }
    } else {
      url = new URL(`/room/${roomCode}`, window.location.origin).href;
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Play Literati', url });
        return;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
      }
    }

    await _copyInvite(url);
  }

  async function _copyInvite(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setManualLink('');
      setCopied(true);
    } catch {
      setManualLink(url);
      linkInput.current?.select();
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={_inviteFriends}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-emerald-700 bg-emerald-950 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-emerald-300"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2" />
        </svg>
        <span aria-live="polite">{copied ? 'Link copied' : 'Invite friends'}</span>
      </button>
      <label className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-emerald-200">
        Room code
        <input
          readOnly
          value={roomCode}
          onFocus={(event) => event.currentTarget.select()}
          className="w-[7ch] select-all rounded bg-transparent font-mono text-base font-semibold tracking-wide text-white focus-visible:outline-2 focus-visible:outline-emerald-300"
        />
      </label>
      {showUnavailable && !inviteLink && (
        <p className="mt-2 text-xs text-emerald-200" role="status">
          Invite link unavailable. Reopen this room and try again.
        </p>
      )}
      {manualLink && (
        <label className="mt-2 block text-xs text-emerald-200">
          Copy this invite link
          <input
            ref={linkInput}
            readOnly
            value={manualLink}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-slate-100"
          />
        </label>
      )}
    </div>
  );
}
