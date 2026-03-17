<!-- ooo:START -->
<!-- ooo:VERSION:0.14.0 -->
# Ouroboros — Specification-First AI Development

> Before telling AI what to build, define what should be built.
> As Socrates asked 2,500 years ago — "What do you truly know?"
> Ouroboros turns that question into an evolutionary AI workflow engine.

Most AI coding fails at the input, not the output. Ouroboros fixes this by
**exposing hidden assumptions before any code is written**.

1. **Socratic Clarity** — Question until ambiguity ≤ 0.2
2. **Ontological Precision** — Solve the root problem, not symptoms
3. **Evolutionary Loops** — Each evaluation cycle feeds back into better specs

```
Interview → Seed → Execute → Evaluate
    ↑                           ↓
    └─── Evolutionary Loop ─────┘
```

## ooo Commands

Each command loads its agent/MCP on-demand. Details in each skill file.

| Command | Loads |
|---------|-------|
| `ooo` | — |
| `ooo interview` | `ouroboros:socratic-interviewer` |
| `ooo seed` | `ouroboros:seed-architect` |
| `ooo run` | MCP required |
| `ooo evolve` | MCP: `evolve_step` |
| `ooo evaluate` | `ouroboros:evaluator` |
| `ooo unstuck` | `ouroboros:{persona}` |
| `ooo status` | MCP: `session_status` |
| `ooo setup` | — |
| `ooo help` | — |

## Agents

Loaded on-demand — not preloaded.

**Core**: socratic-interviewer, ontologist, seed-architect, evaluator,
wonder, reflect, advocate, contrarian, judge
**Support**: hacker, simplifier, researcher, architect
<!-- ooo:END -->

---

# Literati — Codebase Architecture Reference

> Read this before exploring files. It will save you tokens.

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
