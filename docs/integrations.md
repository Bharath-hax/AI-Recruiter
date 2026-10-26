# External Integrations & Honest Architectural Boundaries

## 1. Google Calendar & Google Meet Links
- When a manager signs in with Google Workspace permissions (`calendar.events`), `createGoogleMeetCalendarSession` calls `https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1` to create a genuine Calendar event and retrieve an authentic `meet.google.com/...` URL.
- **Architectural Honesty**: Creating a Google Meet link via Google Calendar schedules the real video conference URL, which does **not** by itself place an autonomous headless audio bot inside Google Meet's proprietary WebRTC media room.
- Therefore:
  1. Authentic Google Meet links are attached whenever Workspace Calendar authorization is active (never fabricated when unauthorized).
  2. Real-time spoken AI conversations (`gemini-3.8-live` + `gemini-3.8-flash-lite-tts`) run directly inside the Employee AI Bot Portal (`/?portal=<token>`), clearly labeled for the employee.

## 2. Outbound Email Delivery (Gmail API + SMTP)
- Supports two real delivery channels via `sendIdempotentEmployeeEmail`:
  1. **Nodemailer SMTP** when `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` are configured.
  2. **Gmail REST API** (`gmail.send`) when a manager Google Workspace access token is active.
- If neither channel is configured in a local test environment, emails are recorded honestly as `recorded_pending_config` (never marked `sent`).
- Every email uses a deterministic `idempotency_key` to prevent duplicate sends, and retrying a failed email strictly reuses the stored `deadlineAt` without resetting deadlines.

## 3. Gemini Server-Side AI (`@google/genai`)
- All Gemini calls run strictly on the server using `process.env.GEMINI_API_KEY`:
  - `gemini-3.8-flash`: Structured domain task generation, evidence-backed GitHub code review, and employee Q&A.
  - `gemini-3.8-live`: Bidirectional real-time voice conversations over `/ws/employee-voice`.
  - `gemini-3.8-flash-lite-tts`: Natural 24kHz mono 16-bit WAV speech synthesis for spoken task & code-review briefings.

## 4. GitHub REST API Inspection
- `inspectGitHubRepository` validates public `https://github.com/<owner>/<repo>` URLs, resolves branch HEAD `commitSha`, inspects the recursive Git tree, fetches prioritized source/test/README files, and optionally uses `GITHUB_TOKEN` for higher rate limits.
