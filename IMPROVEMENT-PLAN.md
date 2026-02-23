# Enterprise Improvement Plan: Chatbot Platform

**Target:** 1,000–1,500 employees | Security-critical org | Non-technical users
**Assessment Date:** 2026-02-23
**Findings:** 30 security issues, 15+ scalability gaps, 25+ feature gaps, 7 UX blockers

---

## Executive Summary

The platform has a solid technical foundation — multi-tenant architecture, real-time WebSocket chat, flexible agent profiles, skill injection, task queue, and job scheduler. However, it is **not production-ready** for enterprise deployment across three dimensions:

1. **Security** — 3 critical vulnerabilities, 7 high-severity issues that are deploy blockers
2. **Infrastructure** — Supports ~30 concurrent users today, needs ~300 concurrent for 1,500 employees
3. **Usability** — Non-technical users can chat but will miss 80% of the platform's value due to jargon, no onboarding, and no guided discovery

The plan below is organized into **6 phases over ~16 weeks**, ordered by deployment risk and user impact.

---

## Phase 1: Security Hardening (Weeks 1–2)

> **Goal:** Eliminate deploy-blocking vulnerabilities. Nothing ships to production without these.

### P0 — Critical (Deploy Blockers)

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 1.1 | **Add security headers** — Install `helmet` middleware (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) | `server/index.ts` | **DONE** |
| 1.2 | **Configure CORS** — Explicit origin allowlist, credentials policy, preflight handling | `server/index.ts` | **DONE** |
| 1.3 | **Remove JWT from URL query params** — Replaced with single-use SSE tickets (`server/auth/sse-tickets.ts`) | `server/auth/middleware.ts`, `src/components/TasksDashboard.ts` | **DONE** |
| 1.4 | **Enforce HTTPS** — HTTP→HTTPS redirect in production via `x-forwarded-proto` | `server/index.ts` | **DONE** |
| 1.5 | **Add JSON body size limit** — `express.json({ limit: '1mb' })` | `server/index.ts` | **DONE** |
| 1.6 | **Remove secrets from `.env.development`** — Rotate Brave Search API key, create `.env.example` with placeholders only, add `.env*` to `.gitignore` | `.env.development`, `.gitignore` | TODO |

### P0 — High Severity

| # | Issue | File(s) | Status |
|---|-------|---------|--------|
| 1.7 | **Password complexity requirements** — Min 8 chars, mixed case + number. Account lockout after 5 failed attempts (15-min lockout) | `server/auth/local-auth.ts` | **DONE** |
| 1.8 | **Strengthen auth rate limiting** — 5/min, compound `ip:email` key | `server/middleware/rate-limit.ts` | **DONE** |
| 1.9 | **Sanitize filenames in Content-Disposition** — RFC 5987 encode | `server/routes/files.ts`, `skills.ts`, `tasks.ts` | **DONE** |
| 1.10 | **Validate file MIME types on upload** — Allowlist of safe MIME types | `server/routes/files.ts` | **DONE** |
| 1.11 | **Fix path traversal on `/api/agent-files`** — `fs.realpath()` + `path.sep` suffix | `server/index.ts` | **DONE** |
| 1.12 | **Add CSRF protection** — N/A: app uses JWT in Authorization header (not cookies), CSRF attacks don't apply | — | **SKIPPED** |
| 1.13 | **Add `Cache-Control: no-store`** — On all `/api` responses | `server/index.ts` | **DONE** |
| 1.14 | **Session ID validation** — UUID format validation (kept client IDs to preserve optimistic cache architecture) | `server/routes/sessions.ts` | **DONE** |
| 1.15 | **Per-user WebSocket connection limits** — Max 5, close code 4029 | `server/index.ts` | **DONE** |

**Phase 1: 14/15 done. Remaining: 1.6 (env secrets cleanup).**

---

## Phase 2: Onboarding & UX Quick Wins (Weeks 2–4)

> **Goal:** Make the platform usable for non-technical employees on day one. These changes are high-impact and mostly additive (no architectural risk).

### P0 — First-Time User Experience

| # | Change | File(s) | Status |
|---|--------|---------|--------|
| 2.1 | **Welcome screen with starter prompts** — 6 clickable starter prompts, profile-aware, immediate dismiss on click | `src/main.ts` | **DONE** |
| 2.2 | **Pre-built agent profiles** — 5 platform-scope seed profiles (Writing Assistant, Data Analyst, Meeting Summarizer, Research Helper, Q&A Helper) | `server/db/migrations/010_seed_profiles.sql` | **DONE** |
| 2.3 | **Empty-state guidance in every panel** — Emoji icon + benefit description + CTA in all panels | `FilesPanel.ts`, `SkillsPanel.ts`, `SchedulerPanel.ts`, `AgentProfilesPanel.ts`, `TasksDashboard.ts` | **DONE** |
| 2.4 | **Profile-aware chat empty state** — Selected profile's icon/name/description/suggested_prompts shown in welcome screen | `src/main.ts` | **DONE** |

### P0 — De-Jargon & Terminology

| # | Change | File(s) | Status |
|---|--------|---------|--------|
| 2.5 | **Rename key features** — "Skills" → "Agent Tools", "Agent Studio" → "Agent Builder", "OAuth Subscriptions" → "Your AI Subscriptions" | `src/main.ts`, `StudioPage.ts`, `SkillsPanel.ts`, `OAuthConnectionsPanel.ts` | **DONE** |
| 2.6 | **Friendly model names** — `MODEL_LABELS` map + `getModelLabel()` utility | `src/shared/model-labels.ts`, `ProfileCard.ts`, `ProfilePreview.ts`, `ProfileEditor.ts` | **DONE** |
| 2.7 | **Tooltips on technical terms** — CSS-only `<info-tooltip>` component on Scope, System Prompt, Provider, Model | `src/components/InfoTooltip.ts`, `ProfileEditor.ts` | **DONE** |
| 2.8 | **Token display simplification** — `formatUsageSimple()` shows cost or total token count | `src/web-ui/utils/format.ts` | **DONE** |

### P1 — Simplify Complex Features

| # | Change | File(s) | Status |
|---|--------|---------|--------|
| 2.9 | **Profile Editor: basic vs. advanced mode** — Basic: name, icon, description, starter message, prompts. Advanced toggle: system prompt, prompt mode, provider, model, skills, files | `src/studio/ProfileEditor.ts` | **DONE** |
| 2.10 | **Quick Create as default flow** — "+ New Profile" navigates to Studio Quick Create | `src/components/AgentProfilesPanel.ts` | **DONE** |
| 2.11 | **Human-readable cron builder** — Presets (daily/weekday/weekly/hourly/custom) + time picker + day selector + preview | `src/components/CronBuilder.ts`, `SchedulerPanel.ts` | **DONE** |
| 2.12 | **Task templates** — 4 example prompt chips above textarea in create form | `src/components/TasksDashboard.ts` | **DONE** |

**Phase 2: 12/12 done. Complete.**

---

## Phase 3: Enterprise Auth & Admin (Weeks 4–7)

> **Goal:** Enable enterprise-scale user management. Without SSO, you can't onboard 1,500 employees. Without admin tools, you can't govern usage.

### P0 — Authentication & Identity

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 3.1 | **Azure AD / OIDC SSO integration** — Add OpenID Connect authentication flow. Support auto-provisioning of users on first login. Map Azure AD groups to teams | `server/auth/`, new `server/auth/oidc.ts` | 40h |
| 3.2 | **MFA / 2FA support** — TOTP-based (Google Authenticator, Microsoft Authenticator) for local auth users. SSO users inherit MFA from IdP | `server/auth/local-auth.ts`, new `server/auth/mfa.ts` | 20h |
| 3.3 | **User invitation system** — Admin can invite users by email. Invited users join existing team. Invitation expiry (72h) | New `server/routes/invitations.ts`, `src/components/TeamPanel.ts` | 16h |
| 3.4 | **Granular RBAC** — Expand from admin/member to: viewer (read-only chat), contributor (chat + files + profiles), admin (full management). Apply per-route | `server/auth/permissions.ts`, all route files | 16h |

### P0 — Admin Dashboard & Governance

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 3.5 | **Team member management UI** — List users, view roles, activate/deactivate, change roles. Admin-only panel | New `src/components/TeamManagementPanel.ts`, new `server/routes/admin.ts` | 16h |
| 3.6 | **Comprehensive audit logging** — Middleware that logs all state-changing operations: file uploads/deletes, skill changes, profile changes, session events, auth events. Store in `audit_log` table | New `server/middleware/audit.ts`, new migration | 16h |
| 3.7 | **Usage analytics dashboard** — Per-team and per-user: message count, token usage, cost estimate, active sessions, top profiles used. Admin-only view | New `src/components/AnalyticsDashboard.ts`, new `server/routes/analytics.ts` | 24h |
| 3.8 | **Cost tracking per team/user** — Capture token counts from RPC responses, aggregate by user/team/model. Store in `usage_stats` table | New `server/services/usage-tracker.ts`, new migration | 12h |

### P1 — Data Governance

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 3.9 | **Data retention policies** — Auto-archive sessions older than N days (configurable per team). Soft-delete → hard-delete after retention period | `server/services/retention.ts`, migration | 8h |
| 3.10 | **Session data export** — User can export their own chat history as JSON/markdown. Admin can export team data for compliance | `server/routes/sessions.ts` (new endpoints) | 8h |
| 3.11 | **Content guardrails** — Input/output filtering middleware. Block PII in prompts, restrict topics, apply DLP rules. Configurable per team | New `server/middleware/guardrails.ts` | 16h |

**Phase 3 Total: ~192 hours**

---

## Phase 4: Infrastructure & Scalability (Weeks 6–9)

> **Goal:** Scale from ~30 concurrent users to ~300+. Run reliably with HA and observability.

### P0 — Horizontal Scaling

| # | Change | Details | Effort |
|---|--------|---------|--------|
| 4.1 | **Dockerize for production** — Multi-stage Dockerfile, K8s deployment/service/configmap manifests, HPA (horizontal pod autoscaler) | New `Dockerfile`, `k8s/` directory | 16h |
| 4.2 | **Increase process pool** — Default from 30 → 100 per pod. For 1,500 users at 20% concurrency = 300 active → 3 pods × 100 | `server/services/process-pool.ts` | 2h |
| 4.3 | **Increase DB connection pool** — From 20 → 50 per pod. Add statement timeout (30s). Add SSL enforcement in production | `server/db/index.ts` | 2h |
| 4.4 | **WebSocket sticky sessions** — Implement session-affinity routing (IP hash or cookie-based). Add Redis pub/sub for cross-pod process state | `server/index.ts`, new `server/services/redis-process-registry.ts` | 20h |
| 4.5 | **OAuth PKCE state → Redis** — Move from in-memory Map to Redis for multi-pod support | `server/routes/oauth.ts` | 4h |

### P0 — Observability

| # | Change | Details | Effort |
|---|--------|---------|--------|
| 4.6 | **Structured logging** — Replace all `console.log/error` (37 occurrences) with Pino. Add request correlation IDs. JSON format in production | New `server/middleware/logger.ts`, all server files | 12h |
| 4.7 | **Prometheus metrics** — Expose `/metrics` endpoint: HTTP request rate/latency, WebSocket connections, process pool utilization, DB pool stats, task queue depth | New `server/middleware/metrics.ts` | 8h |
| 4.8 | **Error tracking (Sentry)** — Capture unhandled exceptions, failed requests, WebSocket errors. Source maps in production | `server/index.ts` | 4h |
| 4.9 | **Health check improvements** — Separate `/healthz/live` (fast, for K8s liveness) and `/healthz/ready` (checks DB, Redis, for readiness). Remove internal stats from unauthenticated endpoint | `server/index.ts` | 3h |

### P0 — Storage

| # | Change | Details | Effort |
|---|--------|---------|--------|
| 4.10 | **S3 storage backend** — Implement `S3StorageService` using the existing `StorageService` interface. Support `STORAGE_BACKEND=s3` env var. Enable versioning | New `server/services/s3-storage.ts` | 12h |
| 4.11 | **Storage quotas** — Per-user (100MB) and per-team (5GB) quotas. Track in `storage_usage` table. Reject uploads over quota | New migration, `server/routes/files.ts` | 6h |

### P1 — Resilience

| # | Change | Details | Effort |
|---|--------|---------|--------|
| 4.12 | **Circuit breaker for LLM providers** — Track error rates per provider. Open circuit at 50% failure rate for 60s. Return 503 with user-friendly message instead of hanging | New `server/services/circuit-breaker.ts` | 8h |
| 4.13 | **Scheduler HA** — Leader election via PostgreSQL advisory locks. 2+ scheduler replicas with hot standby. Heartbeat every 5s | `server/scheduler/worker.ts`, new `server/scheduler/leader-election.ts` | 12h |
| 4.14 | **Config validation on startup** — Zod schema for all env vars. Fail fast with clear error messages if required config is missing | New `server/config.ts` | 4h |
| 4.15 | **Graceful shutdown improvements** — Stop accepting new WebSocket connections during drain. Wait for active sessions. Health check returns 503 during shutdown | `server/index.ts` | 4h |
| 4.16 | **Exponential backoff for job retries** — Replace hard 3-failure auto-disable with backoff: 1min → 5min → 30min with jitter | `server/scheduler/worker.ts` | 4h |

**Phase 4 Total: ~121 hours**

---

## Phase 5: Knowledge Management & Collaboration (Weeks 9–13)

> **Goal:** Enable the core use case — "AI with internal knowledge and expertise." Without this, users can only chat with a generic AI, which doesn't justify the platform.

### P0 — Team Knowledge Base

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 5.1 | **Team-shared file library** — Extend files from user-only to team-shared scope. Team admins can upload files visible to all team members. Scope selector (personal/team) on upload | `server/routes/files.ts`, `src/components/FilesPanel.ts`, migration | 16h |
| 5.2 | **File-aware agent sessions** — When a profile references `file_ids`, show which files are active in the chat header. Let users attach additional files per-session | `src/web-ui/ChatPanel.ts`, `server/agent-service.ts` | 8h |
| 5.3 | **Full-text search across files** — PostgreSQL `tsvector` indexing on file content (text files, extracted PDF text). Search UI in Files panel | Migration, `server/routes/files.ts`, `src/components/FilesPanel.ts` | 16h |

### P1 — RAG Pipeline

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 5.4 | **Document parsing & chunking** — Extract text from PDFs, DOCX, PPTX on upload. Chunk into ~500-token segments. Store chunks in DB | New `server/services/document-parser.ts`, migration | 20h |
| 5.5 | **Embedding generation** — Generate embeddings per chunk using configured provider. Store in `pgvector` extension | New `server/services/embeddings.ts`, migration | 16h |
| 5.6 | **Semantic search skill** — Auto-injected skill that queries embeddings when agent needs context. Returns top-K relevant chunks | New `server/extensions/knowledge-search.ts` | 12h |

### P1 — Collaboration

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 5.7 | **Session sharing** — Users can share a read-only link to a chat session with team members. Optional: collaborative sessions | `server/routes/sessions.ts`, new UI component | 12h |
| 5.8 | **Session export** — Export chat as PDF or Markdown. Available per-session via menu button | `server/routes/sessions.ts`, `src/web-ui/ChatPanel.ts` | 8h |
| 5.9 | **Session search** — Full-text search across all user sessions (message content). Search bar in sidebar | `server/routes/sessions.ts`, `src/main.ts` | 8h |

### P1 — Skills Marketplace

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 5.10 | **Curated skills library** — Pre-built platform skills: Web Search, Document Summary, Data Analysis, Email Draft, Translation. Installable with one click | `server/extensions/`, `src/components/SkillsPanel.ts` | 16h |
| 5.11 | **Skills discovery UI** — Browse available skills by category. Install/uninstall per user or team. Show what each skill does with examples | `src/components/SkillsPanel.ts` | 12h |

**Phase 5 Total: ~144 hours**

---

## Phase 6: Integrations & Polish (Weeks 13–16)

> **Goal:** Connect the platform to the enterprise ecosystem and polish the experience.

### P1 — Enterprise Integrations

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 6.1 | **Slack bot integration** — Chat with agents from Slack. Forward conversations to platform. Deliver scheduled job results to Slack channels | New `server/integrations/slack.ts` | 24h |
| 6.2 | **Microsoft Teams bot** — Same as Slack but for Teams. Leverage existing Teams webhook delivery as starting point | New `server/integrations/teams-bot.ts` | 24h |
| 6.3 | **Webhook API for external events** — Inbound webhooks that trigger agent tasks (e.g., "new Jira ticket → summarize and notify") | New `server/routes/webhooks.ts` | 12h |
| 6.4 | **Enterprise connector framework** — Pluggable connectors for SharePoint, Google Drive, Confluence. Read documents from external systems into knowledge base | New `server/connectors/` | 24h |

### P1 — UX Polish

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 6.5 | **Feature tour on first login** — 4-step overlay tour: sidebar navigation, agent profiles, file uploads, getting help | `src/main.ts`, new tour component | 8h |
| 6.6 | **Keyboard shortcuts help** — `?` key opens shortcut reference. Document Enter/Shift+Enter, Cmd+S in editor, Esc to cancel | New help dialog component | 4h |
| 6.7 | **Accessibility audit** — ARIA labels on all interactive elements, keyboard navigation for all panels, screen reader testing, color contrast fixes | All UI components | 16h |
| 6.8 | **Mobile-responsive layout** — Collapsible sidebar, touch-friendly controls, responsive chat width | `src/main.ts`, CSS | 12h |

### P2 — Nice-to-Have

| # | Feature | Details | Effort |
|---|---------|---------|--------|
| 6.9 | **Profile templates gallery** — Pre-built templates by department: "Finance Analyst", "HR Policy Expert", "Sales Helper", "Legal Reviewer" | Seed data + UI | 8h |
| 6.10 | **In-chat skill visibility** — When agent uses a tool, show friendly label: "Searching the web..." / "Looking up your documents..." instead of raw tool names | `src/web-ui/` tool renderers | 6h |
| 6.11 | **User feedback on responses** — Thumbs up/down on agent messages. Aggregate for analytics. Feed into prompt improvement | UI component + migration + API | 12h |
| 6.12 | **OpenTelemetry distributed tracing** — End-to-end request tracing across HTTP → WebSocket → RPC process | `server/index.ts`, instrumentation | 12h |

**Phase 6 Total: ~162 hours**

---

## Summary: Effort & Timeline

| Phase | Focus | Weeks | Effort | Status |
|-------|-------|-------|--------|--------|
| **Phase 1** | Security Hardening | 1–2 | ~40h | **14/15 done** (1.6 remaining) |
| **Phase 2** | Onboarding & UX | 2–4 | ~58h | **12/12 done** |
| **Phase 3** | Enterprise Auth & Admin | 4–7 | ~192h | Not started |
| **Phase 4** | Infrastructure & Scale | 6–9 | ~121h | Not started |
| **Phase 5** | Knowledge & Collaboration | 9–13 | ~144h | Not started |
| **Phase 6** | Integrations & Polish | 13–16 | ~162h | Not started |
| **Total** | | **16 weeks** | **~717h** | **~98h done (~14%)** |

> Note: Phases 3 and 4 overlap (weeks 6–7) as auth/admin work and infrastructure work are independent streams.

---

## Priority Matrix

```
                    HIGH IMPACT
                        |
   Phase 1: Security    |    Phase 2: Onboarding
   (DONE)               |    (DONE)
   Phase 3: SSO/Admin   |    Phase 5: Knowledge/RAG
                        |
  LOW EFFORT -----------+----------- HIGH EFFORT
                        |
                        |    Phase 6: Integrations
   Phase 4: Config      |    Phase 6: Accessibility
                        |
                    LOW IMPACT
```

**Next up → Phase 3 (enterprise auth & admin) + Phase 4 (infrastructure). These enable scaling to 1,500 users.**

---

## Key Metrics to Track

| Metric | Current | Target (6 months) |
|--------|---------|-------------------|
| Security vulnerabilities (critical/high) | ~~10~~ → 1 (env secrets) | 0 |
| Concurrent users supported | ~30 | 300+ |
| Time to first message (new user) | ~~~60s~~ → <15s (welcome screen) | <15s (guided) |
| Features discovered by avg user | ~~Chat only (~1/8)~~ → Improved (empty states, tooltips) | 4+ features |
| Agent profiles usage rate | Unknown | >50% of users have selected a non-default profile |
| Non-technical user satisfaction | Unmeasured | >4/5 (via in-app feedback) |
| Audit log coverage | Provider keys only | All state-changing operations |
| Mean time to detect issues | Unknown (no monitoring) | <5 minutes (alerts) |
