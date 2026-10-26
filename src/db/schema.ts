import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export interface AcceptanceCriterionSpec {
  id: string;
  title: string;
  description: string;
  required: boolean;
  verificationHint: string;
}

export interface ImportRowIssue {
  rowNumber: number;
  employeeName?: string;
  email?: string;
  technicalDomain?: string;
  issueType: 'invalid' | 'duplicate_in_file' | 'duplicate_existing';
  reason: string;
}

export interface VoiceTranscriptTurn {
  speaker: 'ai_bot' | 'employee';
  text: string;
  timestamp: string;
}

export interface InspectedRepoFile {
  path: string;
  size: number;
  sha: string;
  language: string;
  snippet: string;
}

export interface CriterionVerificationResult {
  criterionId: string;
  title: string;
  required: boolean;
  status: 'verified_complete' | 'incomplete' | 'unable_to_verify';
  evidenceFiles: string[];
  explanation: string;
}

export interface CodeIssueFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  affectedFile: string;
  codeSection: string;
  title: string;
  whyItMatters: string;
  howToFix: string;
  relatedCriterionId?: string;
}

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('manager'),
  githubUsername: text('github_username'),
  timezone: text('timezone').notNull().default('UTC'),
  defaultDeadlineDays: integer('default_deadline_days').notNull().default(2),
  autoGenerateTasks: boolean('auto_generate_tasks').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const domainTaskConfigs = pgTable('domain_task_configs', {
  id: serial('id').primaryKey(),
  domainKey: text('domain_key').notNull().unique(),
  domainName: text('domain_name').notNull(),
  generationMode: text('generation_mode').notNull().default('ai_dynamic'), // 'ai_dynamic' | 'template'
  taskTitleTemplate: text('task_title_template').notNull(),
  taskDescriptionTemplate: text('task_description_template').notNull(),
  whyRequiredTemplate: text('why_required_template').notNull(),
  requirementsTemplate: jsonb('requirements_template')
    .$type<string[]>()
    .notNull()
    .default([]),
  expectedOutputTemplate: text('expected_output_template').notNull(),
  implementationStepsTemplate: jsonb('implementation_steps_template')
    .$type<string[]>()
    .notNull()
    .default([]),
  acceptanceCriteriaTemplate: jsonb('acceptance_criteria_template')
    .$type<AcceptanceCriterionSpec[]>()
    .notNull()
    .default([]),
  deadlineDays: integer('deadline_days').notNull().default(2),
  timezone: text('timezone').notNull().default('UTC'),
  isActive: boolean('is_active').notNull().default(true),
  updatedByUid: text('updated_by_uid'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const importBatches = pgTable('employee_import_batches', {
  id: serial('id').primaryKey(),
  batchCode: text('batch_code').notNull().unique(),
  fileName: text('file_name').notNull(),
  totalRows: integer('total_rows').notNull(),
  validCount: integer('valid_count').notNull(),
  duplicateCount: integer('duplicate_count').notNull(),
  invalidCount: integer('invalid_count').notNull(),
  domainsDetected: jsonb('domains_detected').$type<string[]>().notNull().default([]),
  tasksAssignedCount: integer('tasks_assigned_count').notNull().default(0),
  rowErrors: jsonb('row_errors').$type<ImportRowIssue[]>().notNull().default([]),
  importedByUid: text('imported_by_uid').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const employees = pgTable('platform_employees', {
  id: serial('id').primaryKey(),
  employeeCode: text('employee_code').notNull().unique(),
  fullName: text('full_name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone').notNull(),
  technicalDomain: text('technical_domain').notNull(),
  domainKey: text('domain_key').notNull(),
  importBatchId: integer('import_batch_id').references(() => importBatches.id),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const employeeTasks = pgTable('employee_tasks', {
  id: serial('id').primaryKey(),
  taskCode: text('task_code').notNull().unique(),
  employeeId: integer('employee_id')
    .references(() => employees.id)
    .notNull(),
  domainKey: text('domain_key').notNull(),
  technicalDomain: text('technical_domain').notNull(),
  portalToken: text('portal_token').notNull().unique(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  whyRequired: text('why_required').notNull(),
  exactRequirements: jsonb('exact_requirements').$type<string[]>().notNull().default([]),
  expectedOutput: text('expected_output').notNull(),
  implementationSteps: jsonb('implementation_steps').$type<string[]>().notNull().default([]),
  acceptanceCriteria: jsonb('acceptance_criteria')
    .$type<AcceptanceCriterionSpec[]>()
    .notNull()
    .default([]),
  timezone: text('timezone').notNull().default('UTC'),
  assignedAt: timestamp('assigned_at').defaultNow().notNull(),
  deadlineAt: timestamp('deadline_at').notNull(),
  status: text('status').notNull().default('assigned'), // 'assigned' | 'voice_briefing_completed' | 'in_progress' | 'review_queued' | 'changes_requested' | 'unable_to_verify' | 'completed'
  briefingCompletedAt: timestamp('briefing_completed_at'),
  onboardingMeetLink: text('onboarding_meet_link'),
  onboardingCalendarEventId: text('onboarding_calendar_event_id'),
  onboardingMeetingStart: timestamp('onboarding_meeting_start'),
  reviewMeetLink: text('review_meet_link'),
  reviewCalendarEventId: text('review_calendar_event_id'),
  reviewMeetingStart: timestamp('review_meeting_start'),
  meetingIntegrationMode: text('meeting_integration_mode')
    .notNull()
    .default('embedded_voice_portal_only'),
  currentRevisionNumber: integer('current_revision_number').notNull().default(0),
  voiceBriefingScript: text('voice_briefing_script').notNull(),
  latestReviewVoiceScript: text('latest_review_voice_script'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const voiceSessions = pgTable('employee_voice_sessions', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .references(() => employeeTasks.id)
    .notNull(),
  employeeId: integer('employee_id')
    .references(() => employees.id)
    .notNull(),
  sessionType: text('session_type').notNull(), // 'initial_task_explanation' | 'review_error_explanation'
  revisionNumber: integer('revision_number').notNull().default(0),
  transcriptTurns: jsonb('transcript_turns')
    .$type<VoiceTranscriptTurn[]>()
    .notNull()
    .default([]),
  questionsAskedCount: integer('questions_asked_count').notNull().default(0),
  status: text('status').notNull().default('started'), // 'started' | 'completed'
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export const githubSubmissions = pgTable('employee_github_submissions', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .references(() => employeeTasks.id)
    .notNull(),
  employeeId: integer('employee_id')
    .references(() => employees.id)
    .notNull(),
  revisionNumber: integer('revision_number').notNull(),
  repositoryUrl: text('repository_url').notNull(),
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  branch: text('branch').notNull().default('main'),
  commitSha: text('commit_sha').notNull(),
  commitMessage: text('commit_message'),
  commitAuthor: text('commit_author'),
  commitTimestamp: text('commit_timestamp'),
  detectedLanguages: jsonb('detected_languages').$type<string[]>().notNull().default([]),
  inspectedFiles: jsonb('inspected_files')
    .$type<InspectedRepoFile[]>()
    .notNull()
    .default([]),
  readmeFound: boolean('readme_found').notNull().default(false),
  testsFound: boolean('tests_found').notNull().default(false),
  lintConfigFound: boolean('lint_config_found').notNull().default(false),
  secretsDetected: jsonb('secrets_detected').$type<string[]>().notNull().default([]),
  promptInjectionFlags: jsonb('prompt_injection_flags').$type<string[]>().notNull().default([]),
  testExecutionStatus: text('test_execution_status').notNull().default('static_verification'),
  testExecutionSummary: text('test_execution_summary').notNull().default(''),
  limitationsNote: text('limitations_note').notNull().default(''),
  submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const submissionReviews = pgTable('employee_submission_reviews', {
  id: serial('id').primaryKey(),
  submissionId: integer('submission_id')
    .references(() => githubSubmissions.id)
    .notNull(),
  taskId: integer('task_id')
    .references(() => employeeTasks.id)
    .notNull(),
  revisionNumber: integer('revision_number').notNull(),
  overallVerdict: text('overall_verdict').notNull(), // 'completed' | 'changes_requested' | 'unable_to_verify'
  scorePercent: integer('score_percent').notNull(),
  summary: text('summary').notNull(),
  criterionResults: jsonb('criterion_results')
    .$type<CriterionVerificationResult[]>()
    .notNull()
    .default([]),
  detectedIssues: jsonb('detected_issues')
    .$type<CodeIssueFinding[]>()
    .notNull()
    .default([]),
  fixedIssuesFromPrevious: jsonb('fixed_issues_from_previous')
    .$type<string[]>()
    .notNull()
    .default([]),
  remainingIssues: jsonb('remaining_issues').$type<string[]>().notNull().default([]),
  spokenExplanationScript: text('spoken_explanation_script').notNull(),
  modelUsed: text('model_used').notNull().default('gemini-3.8-flash'),
  reviewedAt: timestamp('reviewed_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const emailDeliveries = pgTable('employee_email_deliveries', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').references(() => employeeTasks.id),
  employeeId: integer('employee_id').references(() => employees.id),
  emailType: text('email_type').notNull(), // 'initial_assignment' | 'post_briefing_summary' | 'review_feedback' | 'task_completed'
  recipientEmail: text('recipient_email').notNull(),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  channel: text('channel').notNull().default('awaiting_provider'), // 'gmail_api' | 'smtp' | 'awaiting_provider'
  deliveryStatus: text('delivery_status').notNull().default('queued'), // 'queued' | 'delivered' | 'failed' | 'awaiting_provider'
  providerMessageId: text('provider_message_id'),
  retryCount: integer('retry_count').notNull().default(0),
  lastError: text('last_error'),
  sentAt: timestamp('sent_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const automationJobs = pgTable('employee_automation_jobs', {
  id: serial('id').primaryKey(),
  jobType: text('job_type').notNull(), // 'assign_employee_task' | 'post_briefing_followup' | 'review_github_submission' | 'retry_email_delivery'
  taskId: integer('task_id').references(() => employeeTasks.id),
  employeeId: integer('employee_id').references(() => employees.id),
  status: text('status').notNull().default('queued'), // 'queued' | 'running' | 'completed' | 'retrying' | 'dead_letter'
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  idempotencyKey: text('idempotency_key').unique(),
  runAt: timestamp('run_at').defaultNow().notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lastError: text('last_error'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('platform_audit_logs', {
  id: serial('id').primaryKey(),
  actor: text('actor').notNull(),
  eventType: text('event_type').notNull(),
  taskId: integer('task_id'),
  employeeId: integer('employee_id'),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
