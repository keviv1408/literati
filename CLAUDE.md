# Literati — Codebase Architecture Reference

> Read this before exploring files. It will save you tokens.

## Quick Start

### Setup
```bash
# Install dependencies (run from root)
cd frontend && npm install
cd ../backend && npm install
```

### Development
```bash
# Terminal 1: Backend (port 3012)
cd backend && npm run dev

# Terminal 2: Frontend (port 3011)
cd frontend && npm run dev
```

Then open [http://localhost:3011](http://localhost:3011).

### Environment Variables

**Backend** (`.env`):
```
PORT=3012
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
FRONTEND_URL=http://localhost:3011
DAILY_API_KEY=...           # Optional: voice chat
DAILY_DOMAIN=...            # Optional: voice chat
```

**Frontend** (`.env.local`):
```
NEXT_PUBLIC_API_URL=http://localhost:3012
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## Testing

```bash
# Frontend: Run tests with pattern
cd frontend && npm test -- --testPathPattern=GamePage --no-coverage

# Frontend: Watch mode
cd frontend && npm test:watch

# Backend: Run tests
cd backend && npm test

# Backend: Watch mode
cd backend && npm test:watch

# Backend: Single file
cd backend && npm test -- roomSocket
```

**Key note**: Always use `--testPathPattern` or `--no-coverage` to avoid slowness. Never run `npm test` alone without flags.

## Gotchas

### Bot Logic Fragility
Recent history has many bot-related reverts. Bot logic (`backend/src/game/botLogic.js`) is complex:
- Avoid touching bot decision-making without deep game knowledge
- Test changes thoroughly with 2-3 games before committing
- Check for "Simplify bot" patterns in commits before refactoring

### Disconnect/Reconnect Handling
Game state has multiple layers:
- `disconnectStore.js` — Tracks who's offline; gates reconnect
- `gameState.js` — In-memory ephemeral state (lost on restart)
- `gameStore.js` — Persistence layer (Supabase)

Mismatch between these causes desync. Always update all three if modifying disconnect behavior.

### Partial Declaration State
`partialSelectionStore.js` holds incomplete half-suit selections. If a player navigates away mid-declare, state persists. When modifying the declare flow, check if this store needs updates.

### Voice Chat (Daily)
Voice routes are **unavailable** unless both `DAILY_API_KEY` and `DAILY_DOMAIN` env vars are set. Routes under `/api/voice/*` silently fail without these. Test voice flows with full env config.

## Repo Structure

```
literati/
├── frontend/          # Next.js 14 App Router (TypeScript)
└── backend/           # Express + WebSocket server (JavaScript)
```

## Frontend (`frontend/src/`)

### Pages (App Router)
| Route | File |
|-------|------|
| `/` | `app/page.tsx` |
| `/auth/login` | `app/auth/login/page.tsx` |
| `/auth/register` | `app/auth/register/page.tsx` |
| `/room/[roomCode]` | `app/room/[roomCode]/page.tsx` |
| `/game/[room-id]` | `app/game/[room-id]/page.tsx` |
| `/matchmaking` | `app/matchmaking/page.tsx` |
| `/leaderboard` | `app/leaderboard/page.tsx` |
| `/live-games` | `app/live-games/page.tsx` |
| `/profile/[userId]` | `app/profile/[userId]/page.tsx` |

### Key Files
| File | Purpose |
|------|---------|
| `src/lib/api.ts` | All HTTP calls to backend (`API_URL = process.env.NEXT_PUBLIC_API_URL`) |
| `src/lib/socket.ts` | WebSocket connection factory |
| `src/lib/backendSession.ts` | Bearer token cache (localStorage) |
| `src/lib/guestSession.ts` | Guest session management |
| `src/lib/roomMembership.ts` | Track which rooms user has joined |
| `src/lib/kickedRooms.ts` | Track kicked room codes |
| `src/lib/audio.ts` | Sound effects |
| `src/lib/teamTheme.ts` | Team color theming |
| `src/hooks/useGameSocket.ts` | Main game WebSocket hook |
| `src/hooks/useRoomSocket.ts` | Room lobby WebSocket hook |
| `src/hooks/useMatchmakingSocket.ts` | Matchmaking WebSocket hook |
| `src/hooks/useLiveGamesSocket.ts` | Live games feed WebSocket hook |
| `src/hooks/useReconnect.ts` | Auto-reconnect logic |
| `src/hooks/useAuth.ts` | Auth state (Supabase + guest) |
| `src/hooks/useTurnIndicator.ts` | Whose turn it is |
| `src/types/game.ts` | Game state types |
| `src/types/room.ts` | Room types |
| `src/types/lobby.ts` | Lobby types |
| `src/types/user.ts` | User types |

### Key Components
| Component | Purpose |
|-----------|---------|
| `GamePlayerSeat.tsx` | Single seat in the game oval |
| `OvalTable.tsx` | 6/8 player oval layout |
| `CardHand.tsx` | Player's hand (mobile+desktop) |
| `CardRequestWizard.tsx` | Multi-step ask-card flow |
| `DeclareModal.tsx` | Half-suit declaration UI |
| `AskCardModal.tsx` | Ask card from opponent |
| `TurnTimerStrip.tsx` | Turn countdown timer |
| `SpectatorView.tsx` | Read-only game view |
| `DraggableLobbyTeamColumns.tsx` | Drag-to-assign teams in lobby |
| `CreateRoomModal.tsx` | New private room form |
| `RematchVotePanel.tsx` | Post-game rematch voting |
| `Avatar.tsx` | Player avatar display |

## Backend (`backend/src/`)

### HTTP Routes
| Route | File |
|-------|------|
| `/api/auth/*` | `routes/auth.js` |
| `/api/rooms/*` | `routes/rooms.js` |
| `/api/matchmaking/*` | `routes/matchmaking.js` |
| `/api/stats/*` | `routes/stats.js` |
| `/api/live-games/*` | `routes/liveGames.js` |

### WebSocket Servers
| File | Handles |
|------|---------|
| `ws/roomSocketServer.js` | Room lobby WS (`/ws/room/:code`) |
| `game/gameSocketServer.js` | Game WS (`/ws/game/:roomId`) |
| `ws/liveGamesSocketServer.js` | Live games feed WS |
| `ws/wsServer.js` | WS routing/upgrade handler |
| `ws/lobbyManager.js` | Lobby state broadcasting |

### Game Engine
| File | Purpose |
|------|---------|
| `game/gameEngine.js` | Core game logic (ask, declare, turns) |
| `game/gameState.js` | In-memory game state |
| `game/gameStore.js` | Game persistence layer |
| `game/botLogic.js` | Bot player AI |
| `game/halfSuits.js` | Half-suit definitions |
| `game/deck.js` | Card deck/dealing |
| `game/partialSelectionStore.js` | Partial declaration state |
| `game/disconnectStore.js` | Disconnect/reconnect tracking |
| `game/rematchStore.js` | Rematch vote state |

### Other
| File | Purpose |
|------|---------|
| `middleware/auth.js` | JWT/bearer auth middleware |
| `matchmaking/matchmakingQueue.js` | Player queue management |
| `matchmaking/botFiller.js` | Fill empty slots with bots |
| `lobby/lobbyStore.js` | Lobby state store |
| `sessions/guestSessionStore.js` | Guest session storage |
| `db/supabase.js` | Supabase client |

## Environment Variables

### Frontend (`.env.local`)
```
NEXT_PUBLIC_API_URL=http://localhost:3012
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

### Backend (`.env`)
```
PORT=3012
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
FRONTEND_URL=http://localhost:3011
```

## Agent Efficiency Rules

**Before reading files:**
- Check this reference first — most file locations are listed above
- Use `Grep` to find specific symbols before reading whole files
- Use `Glob` to confirm a file exists before reading it

**Scope discipline:**
- Only read files directly relevant to your AC
- Do not explore the full codebase to orient yourself — use this doc
- Prefer targeted reads (`offset`+`limit`) over reading entire large files

**Model selection:**
- Use `claude-haiku-4-5-20251001` for verification tasks: running tests, grepping, checking if files exist, reading to confirm a change was applied
- Use `claude-sonnet-4-6` only for implementation: writing new code, designing logic, fixing bugs
- When spawning sub-agents, default to Haiku unless the task requires reasoning or code generation

**Testing:**
- Frontend tests: `cd frontend && npm test -- --testPathPattern=<name> --no-coverage`
- Backend tests: `cd backend && npm test -- <name>`
- Never run `npm test` without `--testPathPattern` unless checking full suite
