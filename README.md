# AI Review Automation Platform — Automated Task Assignment, Voice Bot & GitHub Review System

A full-stack autonomous engineering onboarding, spoken AI task briefing, Google Meet scheduling, and multi-revision GitHub code verification platform built with **two strictly separated web pages**:

1. **Page One — Manager Dashboard (`/`)**
   - Upload an Excel (`.xlsx`) or CSV (`.csv`) sheet containing **only** 4 columns:
     - `Employee Name`
     - `Email Address`
     - `Phone Number`
     - `Technical Domain`
   - Automatically validates rows, isolates duplicate emails, groups employees by technical domain, generates verifiable tasks with timezone-locked deadlines, creates unique Employee AI Bot links, schedules Google Calendar + Google Meet sessions when Workspace is authorized, and dispatches onboarding emails.
   - Configure domain-to-task rules, requirements, acceptance criteria, deadlines, and timezones, monitor multi-revision GitHub reviews in real time over WebSocket, retry emails without altering deadlines, and export the codebase archive.

2. **Page Two — Employee AI Bot Portal (`/?portal=<unique_token>`)**
   - Token-isolated personalized workspace opened directly from the link in the employee's email (no manager login required).
   - **Interactive AI Voice Bot**:
     - Real-time two-way microphone conversation via `gemini-3.8-live` (`/ws/employee-voice`, 16kHz PCM input / 24kHz gapless PCM output) plus instant spoken briefings via `gemini-3.8-flash-lite-tts` (`audio/wav`) and spoken Q&A.
     - Automatically welcomes the employee and explains what the task is about, why it is required, exact requirements, expected output, recommended implementation steps, acceptance criteria, and exact timezone deadline.
   - **Post-Briefing Follow-Up Email**: Sends full written task details, acceptance criteria, locked deadline, GitHub submission instructions, and scheduled review Meet link once the initial voice briefing concludes.
   - **Automated Multi-Revision GitHub Review Loop**:
     - Inspects public GitHub commits, source files, tests, README, hardcoded secrets, and prompt-injection strings.
     - Evaluates against original task requirements and compares against prior revisions (`fixedIssuesFromPrevious` vs `remainingIssues`).
     - Walks through every detected error, affected file, reason, and step-by-step fix by voice and email, repeating revisions (`#1`, `#2`, ...) until every required criterion is verified complete.

---

## Quick Start

### 1. Environment Configuration
Copy `.env.example` to `.env` and configure:
- `GEMINI_API_KEY` — Server-side Gemini API key (`gemini-3.8-flash`, `gemini-3.8-live`, `gemini-3.8-flash-lite-tts`).
- `APP_URL` — Public base URL used for unique Employee AI Bot Portal links.
- `SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME` — PostgreSQL / Cloud SQL connection fields (automatically falls back to embedded PostgreSQL 16 via `@electric-sql/pglite` when running locally without a proxy socket).
- Optional: `GITHUB_TOKEN` (higher GitHub REST rate limits), `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` (SMTP email delivery alongside Google Workspace Gmail API), `DEFAULT_TIMEZONE`.

### 2. Install & Run
```bash
npm install
npm run dev
```
Open `http://localhost:3000`.

### 3. Run Automated Tests & Typecheck
```bash
npx tsx --test tests/automation.test.ts
npm run lint
npm run build
```

---

## Documentation
- [System Architecture](docs/architecture.md)
- [Database Schema](docs/database.md)
- [Google Meet, Voice Bot, Email & GitHub Integrations](docs/integrations.md)
- [Security & Verification Honesty](docs/security.md)
