# System Architecture

## Two-Page Operational Separation

1. **Page One — Manager Dashboard (`/`)**
   - Protected by Firebase Google Authentication (`requireAuth` middleware verifying ID tokens via `firebase-admin`).
   - Exposes 4-column `.xlsx`/`.csv` import (`POST /api/manager/import/preview` and `POST /api/manager/import`), domain rule configuration (`PUT /api/manager/domains/:domainKey`), live task & revision inspection (`GET /api/manager/bootstrap`), idempotent email retry (`POST /api/manager/emails/:id/retry`), and codebase export (`GET /api/export/codebase.zip`).

2. **Page Two — Employee AI Bot Portal (`/?portal=<portalToken>`)**
   - Isolated per-task cryptographic token (`40-hex-char` `crypto.randomBytes(20)`).
   - Employees access only their own assigned task, voice bot session, and GitHub review history (`/api/portal/:token/*` and `/ws/employee-voice?token=<token>`).

## Event-Driven Background Automation Engine

All multi-step operations execute asynchronously through durable `automation_jobs` records drained both immediately on state transitions and continuously on a background interval (`drainAutomationQueue()`):

- `assign_employee_task`: Resolves domain configuration, generates structured task & spoken briefing script (`gemini-3.8-flash` with deterministic template fallback), computes and locks `deadline_at`, creates a Google Calendar Meet event if authorized, and sends the initial onboarding email idempotently.
- `review_github_submission`: Validates GitHub URL (SSRF-safe), fetches branch HEAD commit SHA and source blobs via GitHub REST API, scans for leaked secrets and prompt-injection payloads, evaluates every acceptance criterion against inspected file evidence, computes revision deltas (`fixedIssuesFromPrevious` vs `remainingIssues`), enforces the deterministic completion gate, prepares the spoken review walkthrough, and dispatches either a structured correction report or final completion email.

## Real-Time WebSockets (`/src/services/liveVoiceWsServer.ts`)
- `/ws/events`: Pushes `import:completed`, `task:updated`, `review:completed`, and `email:updated` events to connected Manager and Employee browsers so state transitions appear without manual refreshes.
- `/ws/employee-voice`: Bridges 16kHz PCM microphone audio from the Employee Portal to `gemini-3.8-live` and streams 24kHz PCM spoken responses + real-time transcripts back to the employee.
