export const RECRUITER_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'manager',
  github_username TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  default_deadline_days INTEGER NOT NULL DEFAULT 2,
  auto_generate_tasks BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_deadline_days INTEGER NOT NULL DEFAULT 2;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_generate_tasks BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS domain_task_configs (
  id SERIAL PRIMARY KEY,
  domain_key TEXT NOT NULL UNIQUE,
  domain_name TEXT NOT NULL,
  generation_mode TEXT NOT NULL DEFAULT 'ai_dynamic',
  task_title_template TEXT NOT NULL,
  task_description_template TEXT NOT NULL,
  why_required_template TEXT NOT NULL,
  requirements_template JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_output_template TEXT NOT NULL,
  implementation_steps_template JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria_template JSONB NOT NULL DEFAULT '[]'::jsonb,
  deadline_days INTEGER NOT NULL DEFAULT 2,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by_uid TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_import_batches (
  id SERIAL PRIMARY KEY,
  batch_code TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  valid_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  invalid_count INTEGER NOT NULL,
  domains_detected JSONB NOT NULL DEFAULT '[]'::jsonb,
  tasks_assigned_count INTEGER NOT NULL DEFAULT 0,
  row_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_by_uid TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_employees (
  id SERIAL PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  technical_domain TEXT NOT NULL,
  domain_key TEXT NOT NULL,
  import_batch_id INTEGER REFERENCES employee_import_batches(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_tasks (
  id SERIAL PRIMARY KEY,
  task_code TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES platform_employees(id),
  domain_key TEXT NOT NULL,
  technical_domain TEXT NOT NULL,
  portal_token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  why_required TEXT NOT NULL,
  exact_requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_output TEXT NOT NULL,
  implementation_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deadline_at TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  briefing_completed_at TIMESTAMP,
  onboarding_meet_link TEXT,
  onboarding_calendar_event_id TEXT,
  onboarding_meeting_start TIMESTAMP,
  review_meet_link TEXT,
  review_calendar_event_id TEXT,
  review_meeting_start TIMESTAMP,
  meeting_integration_mode TEXT NOT NULL DEFAULT 'embedded_voice_portal_only',
  current_revision_number INTEGER NOT NULL DEFAULT 0,
  voice_briefing_script TEXT NOT NULL,
  latest_review_voice_script TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_voice_sessions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES employee_tasks(id),
  employee_id INTEGER NOT NULL REFERENCES platform_employees(id),
  session_type TEXT NOT NULL,
  revision_number INTEGER NOT NULL DEFAULT 0,
  transcript_turns JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions_asked_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_github_submissions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES employee_tasks(id),
  employee_id INTEGER NOT NULL REFERENCES platform_employees(id),
  revision_number INTEGER NOT NULL,
  repository_url TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  commit_sha TEXT NOT NULL,
  commit_message TEXT,
  commit_author TEXT,
  commit_timestamp TEXT,
  detected_languages JSONB NOT NULL DEFAULT '[]'::jsonb,
  inspected_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  readme_found BOOLEAN NOT NULL DEFAULT FALSE,
  tests_found BOOLEAN NOT NULL DEFAULT FALSE,
  lint_config_found BOOLEAN NOT NULL DEFAULT FALSE,
  secrets_detected JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_injection_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  test_execution_status TEXT NOT NULL DEFAULT 'static_verification',
  test_execution_summary TEXT NOT NULL DEFAULT '',
  limitations_note TEXT NOT NULL DEFAULT '',
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_submission_reviews (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES employee_github_submissions(id),
  task_id INTEGER NOT NULL REFERENCES employee_tasks(id),
  revision_number INTEGER NOT NULL,
  overall_verdict TEXT NOT NULL,
  score_percent INTEGER NOT NULL,
  summary TEXT NOT NULL,
  criterion_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  detected_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  fixed_issues_from_previous JSONB NOT NULL DEFAULT '[]'::jsonb,
  remaining_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  spoken_explanation_script TEXT NOT NULL,
  model_used TEXT NOT NULL DEFAULT 'gemini-3.8-flash',
  reviewed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_email_deliveries (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES employee_tasks(id),
  employee_id INTEGER REFERENCES platform_employees(id),
  email_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'awaiting_provider',
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  provider_message_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_automation_jobs (
  id SERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  task_id INTEGER REFERENCES employee_tasks(id),
  employee_id INTEGER REFERENCES platform_employees(id),
  status TEXT NOT NULL DEFAULT 'queued',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  run_at TIMESTAMP NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id SERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_id INTEGER,
  employee_id INTEGER,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
`;
