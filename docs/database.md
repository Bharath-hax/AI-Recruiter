# Database Schema (PostgreSQL + Drizzle ORM)

Defined in `/src/db/schema.ts` and bootstrapped idempotently via `/src/db/bootstrapSql.ts`. Connects to Cloud SQL PostgreSQL via `pg.Pool` Object Method (`SQL_HOST`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DB_NAME`) or embedded PostgreSQL 16 (`@electric-sql/pglite`).

## Tables

1. **`users`**: Manager profiles, default timezone, default deadline days, and dynamic AI task generation preference.
2. **`domain_task_configs`**: Domain-to-task rules (`domain_key`, `domain_name`, `generation_mode`, baseline title/description/whyRequired, `requirements_template`, `expected_output_template`, `implementation_steps_template`, `acceptance_criteria_template`, `deadline_days`, `timezone`).
3. **`import_batches`**: Spreadsheet upload records tracking total rows, valid count, duplicate email count, invalid count, detected domains, and row-level rejection diagnostics.
4. **`employees`**: Strictly stores the 4 imported employee attributes (`full_name`, unique `email`, `phone`, `technical_domain`, normalized `domain_key`) plus `employee_code` and `import_batch_id`.
5. **`employee_tasks`**: Assigned tasks with unique `portal_token`, structured requirements, testable `acceptance_criteria`, immutable `deadline_at`, `timezone`, `status`, Google Calendar/Meet links, `current_revision_number`, and spoken scripts.
6. **`voice_sessions`**: Records `initial_task_explanation` and `review_error_explanation` voice sessions, turn-by-turn transcripts, and question counts.
7. **`github_submissions`**: Revision-numbered (`#1`, `#2`, ...) snapshots of `repository_url`, `branch`, `commit_sha`, inspected file snippets, secret scan alerts, prompt-injection flags, and honest verification notes.
8. **`submission_reviews`**: Structured evaluation verdicts (`completed`, `changes_requested`, `unable_to_verify`), criterion-by-criterion file evidence, actionable `detected_issues`, `fixed_issues_from_previous`, `remaining_issues`, and `spoken_explanation_script`.
9. **`email_deliveries`**: Outbound notifications protected by unique `idempotency_key`, tracking channel (`gmail_api`, `smtp`, `recorded_pending_config`), retry count, and provider message IDs.
10. **`automation_jobs`**: Durable background queue with exponential retry backoff and dead-letter state.
11. **`audit_logs`**: Immutable chronological log of manager actions, automated assignments, voice briefings, and GitHub reviews.
