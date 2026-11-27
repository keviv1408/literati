import { useEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import AndroidEntry from '@/app/page.android';

let mockQuery: string;

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockQuery),
}));

jest.mock('@/app/page', () => ({
  __esModule: true,
  default: () => <div>home</div>,
}));

jest.mock('@/app/room/[roomCode]/page', () => ({
  __esModule: true,
  default: function Lobby({ params }: { params: Promise<{ roomCode: string }> }) {
    const [code, setCode] = useState('');
    useEffect(() => {
      void params.then(({ roomCode }) => setCode(roomCode));
    }, [params]);
    return <div>lobby:{code}</div>;
  },
}));

jest.mock('@/app/game/[room-id]/page', () => ({
  __esModule: true,
  default: function Game({ params }: { params: Promise<{ 'room-id': string }> }) {
    const [code, setCode] = useState('');
    useEffect(() => {
      void params.then(({ 'room-id': roomId }) => setCode(roomId));
    }, [params]);
    return <div>game:{code}</div>;
  },
}));

describe('Android entry', () => {
  it.each([
    ['room=ABC123', 'lobby:ABC123'],
    ['game=ABC123', 'game:ABC123'],
    ['room=ABC123&game=XYZ789', 'game:XYZ789'],
    ['room=', 'home'],
    ['', 'home'],
  ])('renders %s as %s', async (query, expected) => {
    mockQuery = query;
    render(<AndroidEntry />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});
