# Literati

Literati is an online, real-time version of the classic Literature card game. It supports private rooms, public matchmaking, spectators, bots for empty seats, guest play, registered accounts, live game recovery, and optional voice chat.

## What It Includes

- Real-time private rooms and matchmaking
- 6-player and 8-player games
- Guest sessions and registered-user auth
- Bot filling for incomplete lobbies and rematches
- Spectator links and live-games feed
- Persistent profiles and game stats via Supabase
- Optional Daily-powered voice rooms

## Game Rules

- Players: 6 players split into 3v3, or 8 players split into 4v4
- Deck: standard 52-card deck with 7s removed, leaving 48 cards
- Half-suits:
  - Low half: A-6
  - High half: 8-K
- Objective: collect all 6 cards of a half-suit across your team and declare it
- Win condition: first team to 5 declared half-suits out of 8

## Tech Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS
- Backend: Express, WebSocket servers, Socket.IO
- Data/Auth: Supabase
- Voice: Daily
- Tests: Jest

## Repo Structure

```text
literati/
├── frontend/   # Next.js app
├── backend/    # Express API + WebSocket game server
├── LICENSE
└── README.md
```

## Local Development

### Prerequisites

- Node.js 18+
- npm
- A Supabase project
- A Daily account if you want voice chat enabled

### 1. Install dependencies

```bash
cd frontend && npm install
cd ../backend && npm install
```

### 2. Configure environment variables

Backend variables:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
FRONTEND_URL=http://localhost:3011
PORT=3012

# Optional: voice chat
DAILY_API_KEY=...
DAILY_DOMAIN=...
```

Frontend variables:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3012
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Notes:

- The frontend runs on `http://localhost:3011`
- The backend runs on `http://localhost:3012`
- Voice routes are unavailable unless `DAILY_API_KEY` and `DAILY_DOMAIN` are set

### 3. Run the apps

In one terminal:

```bash
cd backend
npm run dev
```

In another terminal:

```bash
cd frontend
npm run dev
```

Then open [http://localhost:3011](http://localhost:3011).

## Useful Scripts

Frontend:

```bash
cd frontend
npm run dev
npm run build
npm run lint
npm test
```

Backend:

```bash
cd backend
npm run dev
npm start
npm test
```

## Backend Surface Area

Main backend entrypoint: `backend/src/index.js`

Highlights:

- REST routes under `/api/auth`, `/api/rooms`, `/api/matchmaking`, and `/api/live-games`
- WebSocket endpoints for room, game, and live-games updates
- Health endpoint at `/health`
- Startup recovery for stale in-progress games

## Database

Supabase migrations live in `backend/supabase/migrations`.

The backend uses:

- service-role access for server-side room/game/admin operations
- anon-key access for user-facing auth flows

## Testing

There are separate test suites for frontend and backend.

```bash
cd frontend && npm test
cd backend && npm test
```

If you want to run a single test file:

```bash
cd frontend && npm test -- --testPathPattern=GamePage
cd backend && npm test -- roomSocket
```

## Notes

- The root README is intended as the quick-start; framework-specific details can live closer to each app over time
- Always commit and push to main after implementing any feature/bug fix/ enhancements.