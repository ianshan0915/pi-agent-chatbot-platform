# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`chatbot-platform` is a multi-tenant chatbot platform built on top of the `pi` coding agent. It provides a web UI where teams can chat with an AI agent loaded with team/user-specific skills, upload files, and schedule recurring pipelines.

It uses an SDK bridge architecture:

1. **Browser** — Lit.js web components + TailwindCSS chat UI, API-backed storage, WebSocket client
2. **Bridge Server** (`server/`) — Express + WebSocket server with in-process `AgentSession` instances via the SDK
3. **SDK Backend** — `@mariozechner/pi-coding-agent` `createAgentSession()` running in-process

Communication flow: `Browser WebSocket → Express/WS SdkBridge → in-process AgentSession`

## Commands

```bash
# Infrastructure (PostgreSQL + Redis)
docker compose -f docker-compose.dev.yml up -d

# App (runs natively for HMR)
npm run dev        # Start dev server with Vite HMR (runs tsx server/index.ts)
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run check      # Type-check with tsgo --noEmit
npm run clean      # Remove dist/
npm run scheduler  # Start the scheduler worker (separate process)
```

## Key Source Files

### Server (`server/`)

- `server/index.ts` — Express server setup, helmet/CORS/security middleware, API routes, Vite middleware (dev) or static serving (prod), WebSocket upgrade routing with per-user connection limits. Always uses `SdkBridge` (no feature flags).
- `server/sdk-bridge.ts` — `SdkBridge`: tenant-aware agent bridge using in-process `AgentSession`. Core design:
  - **Lazy session creation**: `AgentSession` is deferred until first user prompt to avoid resource waste on session browsing
  - **Single dispatch path**: `dispatchCommand()` routes all commands through three tiers: session exists → SDK call, no session + read-only → synthetic response, no session + mutation → queue + lazy create
  - **Provider key injection**: `AuthStorage.inMemory()` + `setRuntimeApiKey()` per provider (no env vars)
  - **Extension factories**: Closure-based `ExtensionFactory` instances for per-session credentials (memory, brave search, push-to-viewer)
  - **Detach/reattach**: Sessions survive WebSocket disconnects; output buffered to DB during detachment
  - **Model state push**: After lazy session creation, pushes `state_update` event with real model to client
  - **Startup**: 5 async prep steps (buildEnv, resolveSkills, resolveFiles, fetchHistory, resolveMemory) parallelized via `Promise.all`
- `server/services/session-pool.ts` — `SessionPool`: manages `AgentSession` lifecycle (idle timeout, capacity limits, generating-state protection)
- `server/services/agent-executor.ts` — Shared logic for `buildEnv()` (provider key resolution) and `spawn()` (used by scheduler/task-queue, which still use RPC child processes)
- `server/services/memory-resolver.ts` — `resolveMemoryContent()`: queries user memories from PostgreSQL, returns markdown string for virtual file injection via `agentsFilesOverride`
- `server/extensions/agent-memory-factory.ts` — Closure-based factory: `createAgentMemoryExtension(memoryToken, serverPort)` → `ExtensionFactory` with `memory_save` + `memory_search` tools
- `server/extensions/brave-search.ts` — Brave Search `web_search` tool extension
- `server/extensions/push-to-viewer.ts` — Push-to-viewer extension for artifact rendering
- `server/db/` — PostgreSQL connection pool (`server/db/index.ts`) and migration runner (`server/db/migrate.ts`)
- `server/db/migrations/` — SQL migrations: initial schema, provider keys, skills/files, skill bundles, OAuth credentials, scheduler, agent profiles, tasks, seed profiles, agent memory
- `server/auth/` — JWT auth middleware (`middleware.ts`), local auth with bcrypt and password validation (`local-auth.ts`), permissions (`permissions.ts`), WebSocket auth (`ws-auth.ts`), single-use SSE tickets (`sse-tickets.ts`), memory tokens (`memory-tokens.ts`)
- `server/routes/` — REST API: `auth.ts`, `sessions.ts`, `settings.ts`, `provider-keys.ts`, `skills.ts`, `files.ts`, `jobs.ts`, `oauth.ts`, `import.ts`, `agent-profiles.ts`, `tasks.ts`, `memory.ts`, `team-members.ts`, `projects.ts`, `invites.ts`
- `server/services/crypto.ts` — Envelope encryption (AES-256-GCM) for provider API keys
- `server/services/storage.ts` — `StorageService` interface with `LocalFsStorageService` implementation
- `server/services/skill-resolver.ts` — Resolves platform → team → user skills, downloads to temp dir
- `server/services/oauth-service.ts` — OAuth token management for personal LLM subscriptions
- `server/utils/provider-env-map.ts` — `PROVIDER_ENV_MAP`, `OAUTH_PROVIDER_ENV_MAP`, `PROVIDER_CONFIG_ENV_MAP` mappings
- `server/utils/reverse-provider-map.ts` — `envVarToProvider()`: reverse mapping from env var names back to provider identifiers (used by SdkBridge to inject keys via `AuthStorage`)
- `server/scheduler/` — Job worker (`worker.ts`), executor (`job-executor.ts`), delivery (`delivery.ts`)
- `server/middleware/rate-limit.ts` — Per-user/team rate limiting (express-rate-limit), compound ip:email key for auth endpoints
- `server/utils/sanitize-filename.ts` — Filename sanitization and RFC 5987 Content-Disposition headers

### Client (`src/`)

- `src/main.ts` — Browser entry point: auth flow, chat UI, welcome screen with starter prompts, API storage init, WebSocket connection, session management, profile switching
- `src/remote-agent.ts` — `RemoteAgent` class implementing the `Agent` interface; maintains local state mirror synchronized with the server. Handles server-pushed `state_update` events for model reconciliation after lazy session creation.
- `src/auth/auth-client.ts` — Browser auth client (JWT storage, login/register)
- `src/auth/login-page.ts` — Login/register UI
- `src/storage/api-storage-backend.ts` — `StorageBackend` impl backed by REST API with optimistic local cache
- `src/components/` — Platform UI panels: `SkillsPanel.ts`, `FilesPanel.ts`, `SchedulerPanel.ts`, `ProviderKeysPanel.ts`, `OAuthConnectionsPanel.ts`, `TasksDashboard.ts`, `CronBuilder.ts`, `InfoTooltip.ts`, `MemoryPanel.ts`
- `src/web-ui/` — Chat UI components (Lit.js): `ChatPanel.ts`, message rendering, tool renderers, artifact viewers, dialogs
- `src/studio/` — Agent Builder: `StudioPage.ts` (main page), `ProfileEditor.ts` (form with basic/advanced mode and auto-icon generation), `ProfilePreview.ts` (live preview)
- `src/shared/model-labels.ts` — Friendly display names for LLM model IDs
- `src/migration/export-indexeddb.ts` — One-time IndexedDB export script for migration from single-user system

## Architecture Notes

- **Node.js built-in stubbing**: `vite.config.ts` aliases all Node.js built-ins to `src/node-stub/index.ts` (no-op exports) so server-side SDK code can be bundled for browser without errors.
- **Auth flow**: Local auth (JWT) with Azure AD SSO planned. All routes check `req.user` populated by auth middleware. Password complexity enforced (8+ chars, upper/lower/number).
- **API key flow**: Provider API keys are managed server-side (team admins set them). Keys are envelope-encrypted at rest (AES-256-GCM with KMS-wrapped DEKs). SdkBridge injects them via `AuthStorage.setRuntimeApiKey()`.
- **OAuth flow**: Users can connect personal LLM subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) via OAuth with PKCE. User OAuth credentials override team API keys when both exist.
- **Session persistence**: Sessions stored in PostgreSQL, accessed via REST API. Browser maintains optimistic in-memory cache synced asynchronously.
- **Security middleware**: Helmet (CSP, HSTS, X-Frame-Options), CORS with `ALLOWED_ORIGINS` env var, HTTPS redirect in production, 1MB body size limit, `Cache-Control: no-store` on API responses. File uploads validated against MIME allowlist. Content-Disposition headers sanitized (RFC 5987). Session IDs validated as UUID format.
- **SSE authentication**: EventSource can't set headers, so SSE endpoints use single-use tickets (`server/auth/sse-tickets.ts`) instead of raw JWT tokens. Client POSTs to `/api/auth/sse-ticket` to get a 30-second ticket, then passes it as `?ticket=` query param.
- **WebSocket URL parameters**: `/ws?token=<jwt>&cwd=/path&provider=anthropic&model=claude-3-5-sonnet&agentProfileId=...&args=...`
- **WebSocket connection limits**: Max 5 concurrent WebSocket connections per user. Excess connections rejected with close code 4029.
- **Session lifecycle**: `SessionPool` manages idle timeout, capacity limits, and generating-state protection for in-process `AgentSession` objects.
- **Skills resolution**: Platform → team → user scoped skills, resolved and injected via `DefaultResourceLoader`.
- **Agent memory**: Memories stored in `agent_memories` table with full-text search (tsvector). Injected as virtual `MEMORY.md` file via `agentsFilesOverride`. Extension tools (`memory_save`, `memory_search`) use closure-based factory for per-session auth tokens.
- **Scheduler**: Separate worker process (`npm run scheduler`) with `FOR UPDATE SKIP LOCKED` job claiming, cron-based scheduling, email/Teams delivery. Still uses RPC child processes (`agent-executor.ts` spawn).

## SdkBridge Design

The SdkBridge (`server/sdk-bridge.ts`) is the core server component. Key design decisions:

### Command Dispatch

All WebSocket commands flow through `dispatchCommand()` — a single routing method with three tiers:
1. **Session exists** → `handleCommand()` calls the SDK method directly
2. **No session + read-only** (`get_state`) → `sendSyntheticGetState()` returns model/state without creating a session
3. **No session + mutation** (`prompt`, etc.) → queue in `pendingMessages` + trigger `createSessionLazy()`

This single-path design ensures consistent behavior whether messages arrive during startup (buffered in `pendingMessages`, flushed through `dispatchCommand` when `ready = true`) or after.

### Lazy Session Creation

`AgentSession` is NOT created on WebSocket connect. It's deferred until the first user prompt to avoid wasting resources when browsing session history. A `sessionCreating` lock prevents concurrent creation from multiple queued messages.

### Model State Resolution

Model display follows a three-phase lifecycle:
1. **Pre-ready** (during `startAsync`): Client gets `PLACEHOLDER_MODEL` ("loading...") — messages are buffered
2. **Ready, pre-session**: `sendSyntheticGetState()` resolves model from: `options.model` → `sessionModel` (DB) → `ModelRegistry.getAvailable()[0]`
3. **Post-session**: `createSessionLazy()` pushes `state_update` event with the real `session.model` to reconcile any mismatch between synthetic and actual model

The client (`RemoteAgent`) handles `state_update` events to update its model state and notify the UI.

### Wire Protocol

Client sends commands as JSON. Key field names:
- `prompt`: `{ type: "prompt", message: "...", id: "req_N" }` — field is `message` (not `text`)
- `steer`/`follow_up`: `{ type: "steer", message: "..." }` — fire-and-forget, no `id`
- `prompt` requires immediate acknowledgment: `sendResponse(id, { command: "prompt", success: true })`

## Dependencies on pi-mono packages

This project depends on published npm packages from the pi-mono monorepo:

- `@mariozechner/pi-agent-core` — Agent runtime interface
- `@mariozechner/pi-ai` — Unified LLM provider abstraction
- `@mariozechner/pi-coding-agent` — SDK: `createAgentSession`, `AgentSession`, `AuthStorage`, `DefaultResourceLoader`, `ModelRegistry`, `SessionManager`, `SettingsManager`, extension types

These are installed from npm (not `file:` links). Update versions when new releases are published.

## Recent Features

- **SDK Bridge Migration** — Replaced RPC child process architecture (`pi --mode rpc`) with in-process `AgentSession` via SDK. Deleted: `ws-bridge.ts`, `agent-service.ts`, `process-pool.ts`. Added: `sdk-bridge.ts`, `session-pool.ts`, `reverse-provider-map.ts`, `agent-memory-factory.ts`.
- **Agent Memory** — Persistent user memory with `agent_memories` table, full-text search, memory tools extension, and `MemoryPanel` UI.
- **Security Hardening** — Helmet, CORS, HTTPS redirect, body size limits, MIME validation, Content-Disposition sanitization, password complexity, compound rate limiting, UUID session validation, SSE ticket auth, per-user WebSocket limits, path traversal fix.
- **UX Onboarding** — Welcome screen with profile-aware starter prompts, friendly model names, info tooltips, basic/advanced mode in ProfileEditor, CronBuilder for human-readable scheduling, task templates, improved empty states, renamed features (Agent Builder, Agent Tools, AI Subscriptions).
- **Seed Profiles** — Migration `010_seed_profiles.sql` inserts 5 platform-scope starter profiles with system prompts, starter messages, and suggested prompts.
- **Agent Profiles** (`src/studio/`, `server/routes/agent-profiles.ts`) — CRUD for specialist agent profiles with custom system prompts, curated skills/files, model/provider overrides, starter messages, and suggested prompts. Scoped at platform/team/user level.
- **Async Task Queue** (`server/services/task-queue.ts`) — Background task execution with SSE progress streaming and artifact collection.

## Development Notes

- **Type-check command**: `npx tsc --noEmit` (not tsgo — tsgo is not available via npx).
- **Pre-existing type errors**: `server/routes/oauth.ts`, `server/services/oauth-service.ts`, `src/remote-agent.ts`, `src/main.ts`, `server/middleware/rate-limit.ts` line 7 all have pre-existing type errors. Do not attempt to fix these.
- **UI terminology**: Use "Agent Builder" (not "Studio"), "Agent Tools" (not "Skills"), "Your AI Subscriptions" (not "OAuth Subscriptions") in all user-facing strings.
- **WebSocket profile switching order**: Must save session BEFORE clearing state, then disconnect (with listener removal to prevent stale close handler race), then clear state, then connect new. See `selectAgentProfile()` in `src/main.ts`.
- **SdkBridge startup**: The 5 async prep steps (buildEnv, resolveSkills, resolveFiles, fetchHistory, resolveMemory) must remain parallelized via `Promise.all` in `server/sdk-bridge.ts`. Do not make them sequential — it causes noticeable delay on profile switch.
- **SdkBridge command dispatch**: All commands must flow through `dispatchCommand()`. Do not add command routing elsewhere — it leads to duplicated logic and subtle bugs with buffered message handling.
- **Welcome screen dismissal**: The `welcomeDismissed` flag in `src/main.ts` must be set to `true` before calling `renderApp()` when sending a starter prompt, and reset to `false` on profile switch and new chat. Without this, the chat panel stays hidden in `display:none` while the server processes the message.
- **npm dependencies**: `helmet` and `cors` (+ `@types/cors`) are installed for security middleware.
- **Scheduler/task-queue**: These still use RPC child processes via `agent-executor.ts` `spawn()`. Future migration to SDK pending.

## Architecture

See `ARCHITECTURE.md` for the full multi-tenant platform design including database schema, deployment architecture, and implementation phases.
