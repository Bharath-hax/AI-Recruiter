import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { and, desc, eq, lte } from 'drizzle-orm';
import { db, ensureDatabaseReady } from './index.ts';
import {
  auditLogs,
  automationJobs,
  domainTaskConfigs,
  emailDeliveries,
  employees,
  employeeTasks,
  githubSubmissions,
  importBatches,
  submissionReviews,
  voiceSessions,
  type AcceptanceCriterionSpec,
  type ImportRowIssue,
} from './schema.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX = /^[+0-9()\-\s.]{7,24}$/;

export function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function validateEmailAddress(email: string): boolean {
  const clean = normalizeEmail(email);
  return clean.length >= 5 && clean.length <= 254 && EMAIL_REGEX.test(clean);
}

export function validatePhoneNumber(phone: string): boolean {
  const clean = String(phone || '').trim();
  const digits = clean.replace(/\D/g, '');
  return PHONE_REGEX.test(clean) && digits.length >= 7 && digits.length <= 16;
}

export function normalizeDomainKey(domain: string): string {
  const lower = String(domain || '')
    .trim()
    .toLowerCase();
  if (!lower) return 'general_software';
  if (lower.includes('backend') || lower.includes('api') || lower.includes('python') || lower.includes('java') || lower.includes('node')) {
    return 'backend_engineering';
  }
  if (lower.includes('frontend') || lower.includes('react') || lower.includes('ui') || lower.includes('web')) {
    return 'frontend_engineering';
  }
  if (lower.includes('data') || lower.includes('sql') || lower.includes('etl') || lower.includes('analytics')) {
    return 'data_engineering';
  }
  if (lower.includes('devops') || lower.includes('cloud') || lower.includes('sre') || lower.includes('infra') || lower.includes('docker')) {
    return 'devops_cloud';
  }
  if (lower.includes('ai') || lower.includes('ml') || lower.includes('machine learning') || lower.includes('llm')) {
    return 'ai_ml_engineering';
  }
  if (lower.includes('full') || lower.includes('fullstack')) {
    return 'fullstack_engineering';
  }
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'general_software';
}

export function validateTimezone(tz: string): string {
  const candidate = String(tz || 'UTC').trim() || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

export function calculateConsistentDeadline(assignedAt: Date, deadlineDays: number): Date {
  const safeDays = Math.max(1, Math.min(30, Math.round(Number(deadlineDays) || 2)));
  return new Date(assignedAt.getTime() + safeDays * 24 * 60 * 60 * 1000);
}

export function formatDeadlineInTimezone(deadline: Date | string, timezone: string): string {
  const dateObj = deadline instanceof Date ? deadline : new Date(deadline);
  const safeTz = validateTimezone(timezone);
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(dateObj);
    return `${formatted} (${safeTz})`;
  } catch {
    return `${dateObj.toISOString()} (UTC)`;
  }
}

export interface ParsedEmployeeImportRow {
  rowNumber: number;
  fullName: string;
  email: string;
  phone: string;
  technicalDomain: string;
  domainKey: string;
}

export function parseEmployeeSheetBuffer(
  buffer: Buffer,
  fileName: string,
  existingEmails: Set<string> = new Set()
): {
  validRows: ParsedEmployeeImportRow[];
  rowErrors: ImportRowIssue[];
  totalRows: number;
  duplicateCount: number;
  invalidCount: number;
  domainsDetected: string[];
} {
  const lowerName = fileName.toLowerCase();
  if (!lowerName.endsWith('.xlsx') && !lowerName.endsWith('.xls') && !lowerName.endsWith('.csv')) {
    throw new Error('Unsupported file format. Upload an Excel (.xlsx) or CSV (.csv) file.');
  }

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    return {
      validRows: [],
      rowErrors: [],
      totalRows: 0,
      duplicateCount: 0,
      invalidCount: 0,
      domainsDetected: [],
    };
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], {
    defval: '',
  });

  const validRows: ParsedEmployeeImportRow[] = [];
  const rowErrors: ImportRowIssue[] = [];
  const seenEmailsInFile = new Set<string>();
  const domainsSet = new Set<string>();
  let duplicateCount = 0;
  let invalidCount = 0;

  rawRows.forEach((raw, idx) => {
    const rowNumber = idx + 2;
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      normalized[k.trim().toLowerCase().replace(/[\s\-_/]+/g, '_')] = String(v ?? '').trim();
    }

    const fullName =
      normalized.employee_name ||
      normalized.name ||
      normalized.full_name ||
      normalized.employeename ||
      '';
    const email = normalizeEmail(
      normalized.email_address || normalized.email || normalized.mail || ''
    );
    const phone =
      normalized.phone_number ||
      normalized.phone ||
      normalized.mobile ||
      normalized.contact_number ||
      '';
    const technicalDomain =
      normalized.technical_domain ||
      normalized.domain ||
      normalized.department ||
      normalized.specialization ||
      normalized.track ||
      '';

    // Skip completely blank trailing rows
    if (!fullName && !email && !phone && !technicalDomain) {
      return;
    }

    if (!fullName || fullName.length < 2) {
      invalidCount++;
      rowErrors.push({
        rowNumber,
        employeeName: fullName,
        email,
        technicalDomain,
        issueType: 'invalid',
        reason: 'Employee name is required (minimum 2 characters).',
      });
      return;
    }

    if (!validateEmailAddress(email)) {
      invalidCount++;
      rowErrors.push({
        rowNumber,
        employeeName: fullName,
        email,
        technicalDomain,
        issueType: 'invalid',
        reason: 'Valid email address is required.',
      });
      return;
    }

    if (!validatePhoneNumber(phone)) {
      invalidCount++;
      rowErrors.push({
        rowNumber,
        employeeName: fullName,
        email,
        technicalDomain,
        issueType: 'invalid',
        reason: 'Valid phone number is required (7-16 digits).',
      });
      return;
    }

    if (!technicalDomain || technicalDomain.length < 2) {
      invalidCount++;
      rowErrors.push({
        rowNumber,
        employeeName: fullName,
        email,
        technicalDomain,
        issueType: 'invalid',
        reason: 'Technical domain is required (e.g. Backend Engineering, Frontend React).',
      });
      return;
    }

    if (seenEmailsInFile.has(email)) {
      duplicateCount++;
      rowErrors.push({
        rowNumber,
        employeeName: fullName,
        email,
        technicalDomain,
        issueType: 'duplicate_in_file',
        reason: `Duplicate email address "${email}" detected within uploaded file.`,
      });
      return;
    }

    if (existingEmails.has(email)) {
      duplicateCount++;
      rowErrors.push({
        rowNumber,
        employeeName: fullName,
        email,
        technicalDomain,
        issueType: 'duplicate_existing',
        reason: `Employee with email "${email}" already exists in the system.`,
      });
      return;
    }

    seenEmailsInFile.add(email);
    const domainKey = normalizeDomainKey(technicalDomain);
    domainsSet.add(technicalDomain);

    validRows.push({
      rowNumber,
      fullName,
      email,
      phone,
      technicalDomain,
      domainKey,
    });
  });

  return {
    validRows,
    rowErrors,
    totalRows: rawRows.length,
    duplicateCount,
    invalidCount,
    domainsDetected: Array.from(domainsSet),
  };
}

export function generateSampleEmployeeTemplateCsv(): string {
  return 'Employee Name,Email Address,Phone Number,Technical Domain\n';
}

export function generateSampleEmployeeTemplateXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Employee Name', 'Email Address', 'Phone Number', 'Technical Domain'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function makeCode(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export async function recordAuditLog(params: {
  actor: string;
  eventType: string;
  taskId?: number | null;
  employeeId?: number | null;
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await ensureDatabaseReady();
    const [row] = await db
      .insert(auditLogs)
      .values({
        actor: params.actor,
        eventType: params.eventType,
        taskId: params.taskId ?? null,
        employeeId: params.employeeId ?? null,
        summary: params.summary,
        metadata: params.metadata ?? {},
      })
      .returning();
    return row;
  } catch (error) {
    console.error('Failed to write audit log:', error);
    throw new Error('Failed to record audit entry.', { cause: error });
  }
}

const DEFAULT_DOMAIN_CONFIGS: Array<{
  domainKey: string;
  domainName: string;
  taskTitleTemplate: string;
  taskDescriptionTemplate: string;
  whyRequiredTemplate: string;
  requirementsTemplate: string[];
  expectedOutputTemplate: string;
  implementationStepsTemplate: string[];
  acceptanceCriteriaTemplate: AcceptanceCriterionSpec[];
}> = [
  {
    domainKey: 'backend_engineering',
    domainName: 'Backend Engineering',
    taskTitleTemplate: 'Idempotent Webhook & Order Event Processing API',
    taskDescriptionTemplate:
      'Build a REST API service that ingests payment/order webhook events with strict payload validation, idempotency protection, structured error responses, and automated tests.',
    whyRequiredTemplate:
      'Production backend services receive duplicate and out-of-order webhook retries; idempotency and schema validation prevent double-charging and state corruption.',
    requirementsTemplate: [
      'Expose POST /events and GET /events/:eventId endpoints with structured JSON schemas',
      'Enforce idempotency using event_id so duplicate deliveries return 200 without duplicating state',
      'Return 400/422 with field-level details on malformed payloads',
      'Include automated unit/integration tests and a clear README.md with run commands',
    ],
    expectedOutputTemplate:
      'A public GitHub repository containing the working API service, automated test suite, .env.example, and README.md.',
    implementationStepsTemplate: [
      'Initialize project structure with clear routing, validation, and storage layers',
      'Implement request payload validation and idempotency key lookup',
      'Write unit/integration tests covering valid ingestion, duplicate event_id, and invalid payload',
      'Document setup, environment variables, and test execution commands in README.md',
    ],
    acceptanceCriteriaTemplate: [
      {
        id: 'AC-1',
        title: 'Ingestion & Retrieval Endpoints',
        description: 'Implements POST ingestion and GET status lookup routes with clean HTTP status codes.',
        required: true,
        verificationHint: 'Inspect route definitions and handler implementation files.',
      },
      {
        id: 'AC-2',
        title: 'Idempotency Protection',
        description: 'Prevents duplicate state writes when identical event identifiers are submitted.',
        required: true,
        verificationHint: 'Inspect storage/service logic for unique key or deduplication checks.',
      },
      {
        id: 'AC-3',
        title: 'Input Validation & Error Handling',
        description: 'Validates incoming fields and handles malformed payloads without unhandled exceptions.',
        required: true,
        verificationHint: 'Inspect schema validator or request validation middleware.',
      },
      {
        id: 'AC-4',
        title: 'Automated Tests & Setup Documentation',
        description: 'Includes automated test files and README.md with setup and test commands.',
        required: true,
        verificationHint: 'Confirm presence of test suite assertions and README.md.',
      },
    ],
  },
  {
    domainKey: 'frontend_engineering',
    domainName: 'Frontend Engineering',
    taskTitleTemplate: 'Accessible Real-Time Incident Filter & Triage Interface',
    taskDescriptionTemplate:
      'Build a responsive React + TypeScript interface for filtering, sorting, and triaging operational incidents with URL/state persistence, keyboard accessibility, and component tests.',
    whyRequiredTemplate:
      'On-call engineers need zero-lag filtering, accessible keyboard controls, and resilient empty/loading/error states during incident response.',
    requirementsTemplate: [
      'Implement multi-criteria search, severity filter, and status triage controls in TypeScript',
      'Handle loading, empty, and error states cleanly without layout shift',
      'Ensure accessible labels, focus management, and keyboard operability',
      'Include automated component/logic tests and README setup instructions',
    ],
    expectedOutputTemplate:
      'A public GitHub repository with modular React + TypeScript components, tests, and README.md.',
    implementationStepsTemplate: [
      'Define strict TypeScript interfaces for incident items and filter state',
      'Build filter bar, incident data table, and detail drawer/panel',
      'Add empty, loading, and error states plus keyboard accessibility attributes',
      'Add automated tests for filtering/triage state transitions and document in README.md',
    ],
    acceptanceCriteriaTemplate: [
      {
        id: 'AC-1',
        title: 'Typed Filter & Triage Components',
        description: 'Provides typed React components supporting search, filtering, and status updates.',
        required: true,
        verificationHint: 'Inspect src/ components and TypeScript definitions.',
      },
      {
        id: 'AC-2',
        title: 'Complete UI States & Accessibility',
        description: 'Handles empty and error states and includes accessible ARIA/semantic controls.',
        required: true,
        verificationHint: 'Inspect JSX markup for empty/error handling and semantic controls.',
      },
      {
        id: 'AC-3',
        title: 'Automated Tests & README',
        description: 'Contains unit/component test files and clear README setup & test instructions.',
        required: true,
        verificationHint: 'Verify test files and README.md in repository.',
      },
    ],
  },
  {
    domainKey: 'data_engineering',
    domainName: 'Data Engineering',
    taskTitleTemplate: 'Validated Telemetry ETL & Anomaly Summary Pipeline',
    taskDescriptionTemplate:
      'Create a repeatable data ingestion and normalization pipeline that validates raw CSV/JSON records, quarantines corrupt rows with reasons, and outputs aggregated metrics.',
    whyRequiredTemplate:
      'Downstream analytics depend on deterministic schema enforcement, quarantine reporting for malformed records, and idempotent aggregation runs.',
    requirementsTemplate: [
      'Ingest structured CSV/JSON input records and validate schema types and ranges',
      'Separate valid records from quarantined malformed records with explicit rejection reasons',
      'Produce deterministic summary aggregations by category and time window',
      'Include unit tests with sample fixtures and README execution instructions',
    ],
    expectedOutputTemplate:
      'A public GitHub repository with modular ETL code, validation/quarantine logic, automated tests, and README.md.',
    implementationStepsTemplate: [
      'Implement parser and row-level schema validator with quarantine logging',
      'Implement deterministic aggregation and output writer',
      'Write unit tests verifying valid rows, corrupt rows, and duplicate handling',
      'Document CLI/script invocation and test commands in README.md',
    ],
    acceptanceCriteriaTemplate: [
      {
        id: 'AC-1',
        title: 'Schema Validation & Quarantine',
        description: 'Validates input records and logs malformed rows without crashing the pipeline.',
        required: true,
        verificationHint: 'Inspect parser/validator module.',
      },
      {
        id: 'AC-2',
        title: 'Deterministic Aggregations',
        description: 'Computes accurate summary metrics over validated records.',
        required: true,
        verificationHint: 'Inspect transformation/aggregation module.',
      },
      {
        id: 'AC-3',
        title: 'Automated Tests & README',
        description: 'Includes automated test cases and clear README documentation.',
        required: true,
        verificationHint: 'Verify test suite and README.md.',
      },
    ],
  },
  {
    domainKey: 'devops_cloud',
    domainName: 'DevOps & Cloud',
    taskTitleTemplate: 'Containerized Service Healthcheck, Non-Root Dockerfile & CI Pipeline',
    taskDescriptionTemplate:
      'Containerize an application service using a multi-stage non-root Dockerfile, healthcheck endpoint, environment template, and automated CI lint/test workflow.',
    whyRequiredTemplate:
      'Standardized non-root containers, health probes, and automated CI checks ensure safe, reproducible deployments across environments.',
    requirementsTemplate: [
      'Provide a multi-stage Dockerfile running as a non-root user with explicit HEALTHCHECK',
      'Expose a lightweight /healthz readiness endpoint with structured status output',
      'Configure a GitHub Actions workflow (.github/workflows) running lint and tests',
      'Include .env.example (zero hardcoded secrets) and operational README.md',
    ],
    expectedOutputTemplate:
      'A public GitHub repository containing Dockerfile, service health endpoint, CI workflow, tests, .env.example, and README.md.',
    implementationStepsTemplate: [
      'Implement lightweight service with /healthz readiness check and automated test',
      'Author multi-stage Dockerfile with non-root USER and HEALTHCHECK directive',
      'Add CI workflow YAML and .env.example without secrets',
      'Document build, run, and verification commands in README.md',
    ],
    acceptanceCriteriaTemplate: [
      {
        id: 'AC-1',
        title: 'Hardened Non-Root Container Configuration',
        description: 'Includes Dockerfile with non-root execution and healthcheck configuration.',
        required: true,
        verificationHint: 'Inspect Dockerfile directives.',
      },
      {
        id: 'AC-2',
        title: 'CI Workflow & Automated Verification',
        description: 'Includes automated test script and CI workflow configuration.',
        required: true,
        verificationHint: 'Inspect .github/workflows and test files.',
      },
      {
        id: 'AC-3',
        title: 'Secret Hygiene & Documentation',
        description: 'Zero hardcoded secrets, includes .env.example and setup README.md.',
        required: true,
        verificationHint: 'Check secret scan results, .env.example, and README.md.',
      },
    ],
  },
  {
    domainKey: 'ai_ml_engineering',
    domainName: 'AI & Machine Learning',
    taskTitleTemplate: 'Schema-Validated Prompt Evaluation & Guardrail Service',
    taskDescriptionTemplate:
      'Build an evaluation & guardrail module that sanitizes untrusted user prompts, enforces structured output validation with fallback handling, and logs evaluation metrics.',
    whyRequiredTemplate:
      'Production AI features require prompt-injection defenses, strict output schema validation, and deterministic fallback behavior when model outputs are malformed.',
    requirementsTemplate: [
      'Implement input sanitizer detecting prompt-injection directives and length violations',
      'Enforce strict output schema validation with deterministic retry/fallback handling',
      'Provide an evaluation runner scoring test cases and reporting pass/latency metrics',
      'Include unit tests covering malformed outputs and injection payloads plus README.md',
    ],
    expectedOutputTemplate:
      'A public GitHub repository with guardrail/schema validator, evaluation harness, unit tests, .env.example, and README.md.',
    implementationStepsTemplate: [
      'Implement input guardrail & injection detector',
      'Implement structured response schema validator and fallback handler',
      'Build evaluation test suite covering valid, malformed, and adversarial inputs',
      'Document configuration (.env.example) and test execution in README.md',
    ],
    acceptanceCriteriaTemplate: [
      {
        id: 'AC-1',
        title: 'Input Guardrail & Sanitization',
        description: 'Detects adversarial prompt-injection strings and enforces input bounds.',
        required: true,
        verificationHint: 'Inspect guardrail/sanitizer source file.',
      },
      {
        id: 'AC-2',
        title: 'Output Schema Validation & Fallback',
        description: 'Validates structured outputs and handles malformed responses safely.',
        required: true,
        verificationHint: 'Inspect validator and error handling implementation.',
      },
      {
        id: 'AC-3',
        title: 'Automated Tests & Secret Hygiene',
        description: 'Includes unit tests, .env.example without hardcoded keys, and README.md.',
        required: true,
        verificationHint: 'Inspect test files, secret scan, and README.md.',
      },
    ],
  },
  {
    domainKey: 'fullstack_engineering',
    domainName: 'Full-Stack Engineering',
    taskTitleTemplate: 'End-to-End Task Tracker API & Typed Client Module',
    taskDescriptionTemplate:
      'Build a cohesive backend REST endpoint pair and typed frontend state view with input validation, optimistic/error handling, automated tests, and clean documentation.',
    whyRequiredTemplate:
      'Full-stack delivery requires aligned API/UI TypeScript contracts, server-side validation, and end-to-end error resilience.',
    requirementsTemplate: [
      'Implement validated CRUD/state-transition API endpoints with consistent error responses',
      'Implement typed frontend view/client consuming the API with loading & error states',
      'Ensure zero hardcoded secrets (.env.example provided)',
      'Include automated tests and setup instructions in README.md',
    ],
    expectedOutputTemplate:
      'A public GitHub repository containing backend routes, typed frontend client/UI, automated tests, and README.md.',
    implementationStepsTemplate: [
      'Define shared data contracts and server-side validation logic',
      'Implement API endpoints and frontend data view with error states',
      'Write automated tests for core API/logic behavior',
      'Document local startup and test execution in README.md',
    ],
    acceptanceCriteriaTemplate: [
      {
        id: 'AC-1',
        title: 'Validated Backend Endpoints',
        description: 'Implements structured API routes with input validation and proper status codes.',
        required: true,
        verificationHint: 'Inspect backend route/controller modules.',
      },
      {
        id: 'AC-2',
        title: 'Typed Client / UI State Handling',
        description: 'Implements typed client/interface handling loading, empty, and error states.',
        required: true,
        verificationHint: 'Inspect frontend components and API client.',
      },
      {
        id: 'AC-3',
        title: 'Automated Tests & README',
        description: 'Includes automated test suite and reproducible README setup guide.',
        required: true,
        verificationHint: 'Verify test files and README.md.',
      },
    ],
  },
];

export async function ensureDefaultDomainConfigs() {
  await ensureDatabaseReady();
  const defaultTz = validateTimezone(process.env.DEFAULT_TIMEZONE || 'UTC');
  for (const cfg of DEFAULT_DOMAIN_CONFIGS) {
    await db
      .insert(domainTaskConfigs)
      .values({
        ...cfg,
        generationMode: 'ai_dynamic',
        deadlineDays: 2,
        timezone: defaultTz,
        isActive: true,
      })
      .onConflictDoNothing({ target: domainTaskConfigs.domainKey });
  }
}

export async function upsertDomainTaskConfig(params: {
  domainKey: string;
  domainName: string;
  generationMode: 'ai_dynamic' | 'template';
  taskTitleTemplate: string;
  taskDescriptionTemplate: string;
  whyRequiredTemplate: string;
  requirementsTemplate: string[];
  expectedOutputTemplate: string;
  implementationStepsTemplate: string[];
  acceptanceCriteriaTemplate: AcceptanceCriterionSpec[];
  deadlineDays: number;
  timezone: string;
  isActive?: boolean;
}) {
  await ensureDatabaseReady();
  const cleanKey = normalizeDomainKey(params.domainKey || params.domainName);
  const safeTz = validateTimezone(params.timezone);
  const safeDays = Math.max(1, Math.min(30, Math.round(Number(params.deadlineDays) || 2)));

  const [saved] = await db
    .insert(domainTaskConfigs)
    .values({
      domainKey: cleanKey,
      domainName: params.domainName.trim(),
      generationMode: params.generationMode === 'template' ? 'template' : 'ai_dynamic',
      taskTitleTemplate: params.taskTitleTemplate.trim(),
      taskDescriptionTemplate: params.taskDescriptionTemplate.trim(),
      whyRequiredTemplate: params.whyRequiredTemplate.trim(),
      requirementsTemplate: params.requirementsTemplate.map((s) => s.trim()).filter(Boolean),
      expectedOutputTemplate: params.expectedOutputTemplate.trim(),
      implementationStepsTemplate: params.implementationStepsTemplate
        .map((s) => s.trim())
        .filter(Boolean),
      acceptanceCriteriaTemplate: params.acceptanceCriteriaTemplate,
      deadlineDays: safeDays,
      timezone: safeTz,
      isActive: params.isActive !== false,
    })
    .onConflictDoUpdate({
      target: domainTaskConfigs.domainKey,
      set: {
        domainName: params.domainName.trim(),
        generationMode: params.generationMode === 'template' ? 'template' : 'ai_dynamic',
        taskTitleTemplate: params.taskTitleTemplate.trim(),
        taskDescriptionTemplate: params.taskDescriptionTemplate.trim(),
        whyRequiredTemplate: params.whyRequiredTemplate.trim(),
        requirementsTemplate: params.requirementsTemplate.map((s) => s.trim()).filter(Boolean),
        expectedOutputTemplate: params.expectedOutputTemplate.trim(),
        implementationStepsTemplate: params.implementationStepsTemplate
          .map((s) => s.trim())
          .filter(Boolean),
        acceptanceCriteriaTemplate: params.acceptanceCriteriaTemplate,
        deadlineDays: safeDays,
        timezone: safeTz,
        isActive: params.isActive !== false,
        updatedAt: new Date(),
      },
    })
    .returning();

  return saved;
}

export async function enqueueAutomationJob(params: {
  jobType: string;
  taskId?: number | null;
  employeeId?: number | null;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}) {
  await ensureDatabaseReady();
  if (params.idempotencyKey) {
    const existing = await db
      .select()
      .from(automationJobs)
      .where(eq(automationJobs.idempotencyKey, params.idempotencyKey))
      .limit(1);
    if (existing[0]) {
      return existing[0];
    }
  }

  const [created] = await db
    .insert(automationJobs)
    .values({
      jobType: params.jobType,
      taskId: params.taskId ?? null,
      employeeId: params.employeeId ?? null,
      status: 'queued',
      payload: params.payload,
      idempotencyKey: params.idempotencyKey ?? null,
      runAt: params.runAt ?? new Date(),
      maxAttempts: params.maxAttempts ?? 3,
    })
    .returning();
  return created;
}

export async function fetchDueAutomationJobs(limitCount = 6) {
  await ensureDatabaseReady();
  const now = new Date();
  const queued = await db
    .select()
    .from(automationJobs)
    .where(and(eq(automationJobs.status, 'queued'), lte(automationJobs.runAt, now)))
    .limit(limitCount);
  const retrying = await db
    .select()
    .from(automationJobs)
    .where(and(eq(automationJobs.status, 'retrying'), lte(automationJobs.runAt, now)))
    .limit(limitCount);
  return [...queued, ...retrying].slice(0, limitCount);
}

export function buildEmployeePortalUrl(baseUrl: string, portalToken: string): string {
  const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${cleanBase}/?portal=${encodeURIComponent(portalToken)}`;
}

export async function loadManagerBootstrap(
  currentUser: {
    id: number;
    uid: string;
    email: string;
    displayName: string | null;
    role: string;
    timezone: string;
    defaultDeadlineDays: number;
    autoGenerateTasks: boolean;
  },
  baseUrl: string
) {
  await ensureDatabaseReady();
  await ensureDefaultDomainConfigs();

  try {
    const [
      configs,
      batches,
      allEmployees,
      allTasks,
      allSubmissions,
      allReviews,
      allEmails,
      allVoiceSessions,
      allJobs,
      allAudits,
    ] = await Promise.all([
      db.select().from(domainTaskConfigs).orderBy(domainTaskConfigs.domainName),
      db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(50),
      db.select().from(employees).orderBy(desc(employees.createdAt)),
      db.select().from(employeeTasks).orderBy(desc(employeeTasks.updatedAt)),
      db.select().from(githubSubmissions).orderBy(desc(githubSubmissions.revisionNumber)),
      db.select().from(submissionReviews).orderBy(desc(submissionReviews.revisionNumber)),
      db.select().from(emailDeliveries).orderBy(desc(emailDeliveries.createdAt)).limit(200),
      db.select().from(voiceSessions).orderBy(desc(voiceSessions.startedAt)),
      db.select().from(automationJobs).orderBy(desc(automationJobs.createdAt)).limit(150),
      db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(200),
    ]);

    const empMap = new Map(allEmployees.map((e) => [e.id, e]));
    const reviewBySubmissionId = new Map(allReviews.map((r) => [r.submissionId, r]));

    const submissionsWithReview = allSubmissions.map((s) => ({
      ...s,
      review: reviewBySubmissionId.get(s.id) ?? null,
    }));

    const enrichedTasks = allTasks
      .map((t) => {
        const employee = empMap.get(t.employeeId);
        if (!employee) return null;
        const taskSubs = submissionsWithReview.filter((s) => s.taskId === t.id);
        const taskReviews = allReviews.filter((r) => r.taskId === t.id);
        const latestReview = taskReviews[0] ?? null;
        return {
          ...t,
          portalUrl: buildEmployeePortalUrl(baseUrl, t.portalToken),
          formattedDeadline: formatDeadlineInTimezone(t.deadlineAt, t.timezone),
          employee,
          submissions: taskSubs,
          latestReview,
          emails: allEmails.filter((em) => em.taskId === t.id),
          voiceSessions: allVoiceSessions.filter((vs) => vs.taskId === t.id),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      currentUser,
      domainConfigs: configs,
      importBatches: batches,
      employees: allEmployees,
      tasks: enrichedTasks,
      emails: allEmails,
      automationJobs: allJobs,
      auditLogs: allAudits,
      integrationStatus: {
        geminiConfigured: Boolean(
          process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
        ),
        smtpConfigured: Boolean(
          process.env.SMTP_HOST?.trim() &&
            process.env.SMTP_USER?.trim() &&
            process.env.SMTP_PASS?.trim()
        ),
        githubTokenConfigured: Boolean(process.env.GITHUB_TOKEN?.trim()),
        googleMeetNote:
          'Google Calendar API creates authentic Google Meet links when manager Workspace session is authorized. Real-time spoken AI sessions run directly inside the Employee AI Bot Portal via Gemini Live Audio.',
      },
    };
  } catch (error) {
    console.error('Failed to load manager bootstrap:', error);
    throw new Error('Failed to load manager dashboard data.', { cause: error });
  }
}

export async function loadEmployeePortalByToken(portalToken: string) {
  await ensureDatabaseReady();
  const cleanToken = String(portalToken || '').trim();
  if (!cleanToken || cleanToken.length < 12) {
    return null;
  }

  try {
    const [task] = await db
      .select()
      .from(employeeTasks)
      .where(eq(employeeTasks.portalToken, cleanToken))
      .limit(1);

    if (!task) return null;

    const [[employee], subs, reviews, sessions, emails] = await Promise.all([
      db.select().from(employees).where(eq(employees.id, task.employeeId)).limit(1),
      db
        .select()
        .from(githubSubmissions)
        .where(eq(githubSubmissions.taskId, task.id))
        .orderBy(desc(githubSubmissions.revisionNumber)),
      db
        .select()
        .from(submissionReviews)
        .where(eq(submissionReviews.taskId, task.id))
        .orderBy(desc(submissionReviews.revisionNumber)),
      db
        .select()
        .from(voiceSessions)
        .where(eq(voiceSessions.taskId, task.id))
        .orderBy(desc(voiceSessions.startedAt)),
      db
        .select({
          id: emailDeliveries.id,
          emailType: emailDeliveries.emailType,
          subject: emailDeliveries.subject,
          deliveryStatus: emailDeliveries.deliveryStatus,
          createdAt: emailDeliveries.createdAt,
        })
        .from(emailDeliveries)
        .where(eq(emailDeliveries.taskId, task.id))
        .orderBy(desc(emailDeliveries.createdAt)),
    ]);

    if (!employee) return null;

    const reviewBySubId = new Map(reviews.map((r) => [r.submissionId, r]));
    const submissionsWithReview = subs.map((s) => ({
      ...s,
      review: reviewBySubId.get(s.id) ?? null,
    }));

    return {
      employee: {
        id: employee.id,
        fullName: employee.fullName,
        email: employee.email,
        technicalDomain: employee.technicalDomain,
      },
      task: {
        id: task.id,
        taskCode: task.taskCode,
        title: task.title,
        description: task.description,
        whyRequired: task.whyRequired,
        exactRequirements: task.exactRequirements,
        expectedOutput: task.expectedOutput,
        implementationSteps: task.implementationSteps,
        acceptanceCriteria: task.acceptanceCriteria,
        timezone: task.timezone,
        assignedAt: task.assignedAt,
        deadlineAt: task.deadlineAt,
        formattedDeadline: formatDeadlineInTimezone(task.deadlineAt, task.timezone),
        status: task.status,
        briefingCompletedAt: task.briefingCompletedAt,
        onboardingMeetLink: task.onboardingMeetLink,
        onboardingMeetingStart: task.onboardingMeetingStart,
        reviewMeetLink: task.reviewMeetLink,
        reviewMeetingStart: task.reviewMeetingStart,
        meetingIntegrationMode: task.meetingIntegrationMode,
        currentRevisionNumber: task.currentRevisionNumber,
        voiceBriefingScript: task.voiceBriefingScript,
        latestReviewVoiceScript: task.latestReviewVoiceScript,
        completedAt: task.completedAt,
      },
      submissions: submissionsWithReview,
      latestReview: reviews[0] ?? null,
      voiceSessions: sessions,
      emailsSent: emails,
    };
  } catch (error) {
    console.error('Failed to load employee portal:', error);
    throw new Error('Failed to load employee task portal.', { cause: error });
  }
}
