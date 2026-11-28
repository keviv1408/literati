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
- Backend: Express, WebSocket servers
- Data/Auth: Supabase
- Voice: Daily
- Tests: Jest

## Repo Structure

```text
literati/
├── frontend/   # Next.js app
├── backend/    # Express API + WebSocket game server
├── e2e/        # Playwright end-to-end tests
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

# Optional: PostHog tracking, leave empty to turn it off
NEXT_PUBLIC_POSTHOG_KEY=
```

Notes:

- The frontend runs on `http://localhost:3011`
- The backend runs on `http://localhost:3012`
- For Google sign-in, set the Supabase Site URL to the production web origin. Add the exact `/auth/callback` URL for production, the stable Vercel branch preview you test, and `http://localhost:3011/auth/callback` for local development. Start each sign-in from that same origin so the browser can finish it.
- Voice routes are unavailable unless `DAILY_API_KEY` and `DAILY_DOMAIN` are set
- Build Android with the same `FRONTEND_URL` the backend uses for player invites. It defaults to `https://literationline.com` in the app. Rebuild the app if the public web origin changes.
- Android verifies room invites against `/.well-known/assetlinks.json` on that origin. The checked-in fingerprint matches the sideloaded test build. For a Play Store release, add the SHA-256 fingerprint of the Play app signing certificate to `frontend/public/.well-known/assetlinks.json`. Serve the file directly over HTTPS, then install the matching app build to test a shared `/room/ABC123` link.

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

## Android closed-test releases

Once the first closed release is live in Play Console, push a new version tag on the commit to release. For example, after merging the changes you want:

```sh
git fetch origin main
git tag android-v1.0.1 origin/main
git push origin android-v1.0.1
```

The **Android closed test** workflow builds and signs the bundle and submits it to Play’s default closed track (`alpha`). Google reviews releases as usual. Use a higher `major.minor.patch` for each release. For example, `1.0.1` sets the Play version code to `1000001`.

For the first release, create `com.literationline.app` in Play Console, enroll in Play App Signing, and upload the initial signed bundle. Under **Users and permissions**, grant the publisher service account access to this app with **Release apps to testing tracks**. For room links on Play-installed builds, add the SHA-256 fingerprint of the Play app-signing certificate to the website’s `assetlinks.json`.

GitHub stores the upload key and password in the `android-closed-test` environment. Its `PLAY_IDENTITY_PROVIDER` and `PLAY_SERVICE_ACCOUNT` variables select the Google identity used for publishing.

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
cd backend && npm test -- rooms.test
```

### End-to-end tests

`e2e/` holds Playwright tests for the game socket reconnect. They need Node.js 20 or newer and an installed Google Chrome. They do not start the apps: run the backend and frontend as in "Run the apps" above (ports 3012 and 3011), then:

```bash
cd e2e
npm install
npx playwright test
```

The run takes about a minute, because one test waits out 30 seconds of silence on purpose. Each test creates one real room in the Supabase project that `backend/.env` points at.

## Notes

- The root README is intended as the quick-start; framework-specific details can live closer to each app over time
- Always commit and push to main after implementing any feature/bug fix/ enhancements.
