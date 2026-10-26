import type {
  AcceptanceCriterionSpec,
  CodeIssueFinding,
  CriterionVerificationResult,
  ImportRowIssue,
  InspectedRepoFile,
  VoiceTranscriptTurn,
} from '../db/schema.ts';

export type {
  AcceptanceCriterionSpec,
  CodeIssueFinding,
  CriterionVerificationResult,
  ImportRowIssue,
  InspectedRepoFile,
  VoiceTranscriptTurn,
};

export type TaskWorkflowStatus =
  | 'assigned'
  | 'voice_briefing_completed'
  | 'in_progress'
  | 'review_queued'
  | 'changes_requested'
  | 'unable_to_verify'
  | 'completed';

export interface ManagerUser {
  id: number;
  uid: string;
  email: string;
  displayName: string | null;
  role: string;
  timezone: string;
  defaultDeadlineDays: number;
  autoGenerateTasks: boolean;
}

export interface DomainTaskConfigRecord {
  id: number;
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
  isActive: boolean;
  updatedAt: string;
}

export interface ImportBatchRecord {
  id: number;
  batchCode: string;
  fileName: string;
  totalRows: number;
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
  domainsDetected: string[];
  tasksAssignedCount: number;
  rowErrors: ImportRowIssue[];
  importedByUid: string;
  createdAt: string;
}

export interface EmployeeRecord {
  id: number;
  employeeCode: string;
  fullName: string;
  email: string;
  phone: string;
  technicalDomain: string;
  domainKey: string;
  importBatchId: number | null;
  status: string;
  createdAt: string;
}

export interface SubmissionReviewRecord {
  id: number;
  submissionId: number;
  taskId: number;
  revisionNumber: number;
  overallVerdict: 'completed' | 'changes_requested' | 'unable_to_verify';
  scorePercent: number;
  summary: string;
  criterionResults: CriterionVerificationResult[];
  detectedIssues: CodeIssueFinding[];
  fixedIssuesFromPrevious: string[];
  remainingIssues: string[];
  spokenExplanationScript: string;
  modelUsed: string;
  reviewedAt: string;
}

export interface GithubSubmissionRecord {
  id: number;
  taskId: number;
  employeeId: number;
  revisionNumber: number;
  repositoryUrl: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitTimestamp: string | null;
  detectedLanguages: string[];
  inspectedFiles: InspectedRepoFile[];
  readmeFound: boolean;
  testsFound: boolean;
  lintConfigFound: boolean;
  secretsDetected: string[];
  promptInjectionFlags: string[];
  testExecutionStatus: string;
  testExecutionSummary: string;
  limitationsNote: string;
  submittedAt: string;
  review?: SubmissionReviewRecord | null;
}

export interface EmailDeliveryRecord {
  id: number;
  taskId: number | null;
  employeeId: number | null;
  emailType: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  idempotencyKey: string;
  channel: string;
  deliveryStatus: string;
  providerMessageId: string | null;
  retryCount: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface VoiceSessionRecord {
  id: number;
  taskId: number;
  employeeId: number;
  sessionType: 'initial_task_explanation' | 'review_error_explanation';
  revisionNumber: number;
  transcriptTurns: VoiceTranscriptTurn[];
  questionsAskedCount: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

export interface EmployeeTaskEnriched {
  id: number;
  taskCode: string;
  employeeId: number;
  domainKey: string;
  technicalDomain: string;
  portalToken: string;
  portalUrl: string;
  title: string;
  description: string;
  whyRequired: string;
  exactRequirements: string[];
  expectedOutput: string;
  implementationSteps: string[];
  acceptanceCriteria: AcceptanceCriterionSpec[];
  timezone: string;
  assignedAt: string;
  deadlineAt: string;
  formattedDeadline: string;
  status: TaskWorkflowStatus;
  briefingCompletedAt: string | null;
  onboardingMeetLink: string | null;
  onboardingMeetingStart: string | null;
  reviewMeetLink: string | null;
  reviewMeetingStart: string | null;
  meetingIntegrationMode: string;
  currentRevisionNumber: number;
  voiceBriefingScript: string;
  latestReviewVoiceScript: string | null;
  completedAt: string | null;
  employee: EmployeeRecord;
  submissions: GithubSubmissionRecord[];
  latestReview: SubmissionReviewRecord | null;
  emails: EmailDeliveryRecord[];
  voiceSessions: VoiceSessionRecord[];
}

export interface AutomationJobRecord {
  id: number;
  jobType: string;
  taskId: number | null;
  employeeId: number | null;
  status: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AuditLogRecord {
  id: number;
  actor: string;
  eventType: string;
  taskId: number | null;
  employeeId: number | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ManagerDashboardBootstrap {
  currentUser: ManagerUser;
  domainConfigs: DomainTaskConfigRecord[];
  importBatches: ImportBatchRecord[];
  employees: EmployeeRecord[];
  tasks: EmployeeTaskEnriched[];
  emails: EmailDeliveryRecord[];
  automationJobs: AutomationJobRecord[];
  auditLogs: AuditLogRecord[];
  integrationStatus: {
    geminiConfigured: boolean;
    smtpConfigured: boolean;
    githubTokenConfigured: boolean;
    googleMeetNote: string;
  };
}

export interface EmployeePortalBootstrap {
  employee: {
    id: number;
    fullName: string;
    email: string;
    technicalDomain: string;
  };
  task: {
    id: number;
    taskCode: string;
    title: string;
    description: string;
    whyRequired: string;
    exactRequirements: string[];
    expectedOutput: string;
    implementationSteps: string[];
    acceptanceCriteria: AcceptanceCriterionSpec[];
    timezone: string;
    assignedAt: string;
    deadlineAt: string;
    formattedDeadline: string;
    status: TaskWorkflowStatus;
    briefingCompletedAt: string | null;
    onboardingMeetLink: string | null;
    onboardingMeetingStart: string | null;
    reviewMeetLink: string | null;
    reviewMeetingStart: string | null;
    meetingIntegrationMode: string;
    currentRevisionNumber: number;
    voiceBriefingScript: string;
    latestReviewVoiceScript: string | null;
    completedAt: string | null;
  };
  submissions: GithubSubmissionRecord[];
  latestReview: SubmissionReviewRecord | null;
  voiceSessions: VoiceSessionRecord[];
  emailsSent: Array<{
    id: number;
    emailType: string;
    subject: string;
    deliveryStatus: string;
    createdAt: string;
  }>;
}
