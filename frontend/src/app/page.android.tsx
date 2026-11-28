'use client';

import CardFan from '@/components/CardFan';
import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Home from './page';
import RoomLobbyPage from './room/[roomCode]/page';
import GamePage from './game/[room-id]/page';

function Entry() {
  const query = useSearchParams();
  const room = query.get('room');
  const game = query.get('game');
  // The page components take their code as a params promise and re-run on a new one.
  const roomParams = useMemo(() => Promise.resolve({ roomCode: room ?? '' }), [room]);
  const gameParams = useMemo(() => Promise.resolve({ 'room-id': game ?? '' }), [game]);
  if (game) return <GamePage key={game} params={gameParams} />;
  if (room) return <RoomLobbyPage key={room} params={roomParams} />;
  return <Home />;
}

export default function AndroidEntry() {
  return (
    <Suspense fallback={
      <main role="status" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-felt text-paper">
        <CardFan />
        <span>Opening the table…</span>
      </main>
    }>
      <Entry />
    </Suspense>
  );
}
