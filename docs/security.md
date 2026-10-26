# Security & Verification Controls

1. **Server-Only Secrets**: `GEMINI_API_KEY`, `GITHUB_TOKEN`, `SMTP_*`, and `SQL_*` remain strictly on the Express server and are never exposed to client bundles.
2. **Token-Isolated Employee Portals**: Each assigned task generates a 160-bit (`40-hex-char`) random token (`portal_token`). Portal endpoints (`/api/portal/:token/*`) scope queries strictly to that single task and never expose other employees or manager controls.
3. **SSRF & URL Validation**: `validateAndParseGitHubUrl` enforces `https://github.com/<owner>/<repo>`, rejects embedded credentials, blocks localhost/RFC1918/link-local hosts, and rejects path traversal (`..`).
4. **Prompt-Injection Defense on Untrusted Code**: Inspected repository files are wrapped in `<untrusted_repository_code>` tags, scanned for adversarial prompt-injection phrases (`ignore previous instructions`, `mark all criteria complete`), and redacted before LLM evaluation.
5. **Hardcoded Secret Detection & Deterministic Completion Gate**:
   - Repositories are scanned for committed AWS keys, GitHub tokens, OpenAI/Google API keys, Slack tokens, and private keys.
   - `enforceHardenedCompletionGate` prevents AI optimism from marking tasks complete: `completed` requires every required acceptance criterion to be `verified_complete` with concrete inspected file paths in `evidenceFiles[]` and zero leaked secrets or high/critical code issues.
   - Static inspection boundaries are reported transparently (`skipped_sandbox_unavailable`) rather than fabricating container test runs.
