import crypto from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db, ensureDatabaseReady } from '../db/index.ts';
import {
  buildEmployeePortalUrl,
  calculateConsistentDeadline,
  enqueueAutomationJob,
  ensureDefaultDomainConfigs,
  fetchDueAutomationJobs,
  makeCode,
  parseEmployeeSheetBuffer,
  recordAuditLog,
  validateTimezone,
} from '../db/repositories.ts';
import {
  automationJobs,
  domainTaskConfigs,
  emailDeliveries,
  employees,
  employeeTasks,
  githubSubmissions,
  importBatches,
  submissionReviews,
  users,
  voiceSessions,
} from '../db/schema.ts';
import {
  evaluateEmployeeRepositorySubmission,
  generateTaskForDomainConfig,
} from './aiTaskAndReviewService.ts';
import {
  inspectGitHubRepository,
  runControlledVerification,
  validateAndParseGitHubUrl,
} from './githubEvaluationService.ts';
import {
  composeInitialAssignmentEmail,
  composePostBriefingFollowupEmail,
  composeReviewFeedbackEmail,
  composeTaskCompletedEmail,
  createGoogleMeetCalendarSession,
  sendIdempotentEmployeeEmail,
} from './notificationAndCalendarService.ts';

type RealtimeEventPublisher = (eventType: string, payload: Record<string, unknown>) => void;

let eventPublisher: RealtimeEventPublisher = () => {};
// Ephemeral in-memory map of manager uid -> latest Workspace OAuth token for background Meet/Gmail calls
const managerWorkspaceTokens = new Map<string, string>();

export function registerRealtimePublisher(fn: RealtimeEventPublisher) {
  eventPublisher = fn;
}

export function cacheManagerWorkspaceToken(uid: string, token?: string) {
  if (uid && token && token.trim().length > 0) {
    managerWorkspaceTokens.set(uid, token.trim());
  }
}

export function getAnyCachedWorkspaceToken(preferredUid?: string): string | undefined {
  if (preferredUid && managerWorkspaceTokens.has(preferredUid)) {
    return managerWorkspaceTokens.get(preferredUid);
  }
  const first = managerWorkspaceTokens.values().next();
  return first.done ? undefined : first.value;
}

/**
 * Step 1: Manager uploads .xlsx or .csv containing ONLY:
 * Employee name, Email address, Phone number, Technical domain.
 * Validates rows, deduplicates emails, groups by technical domain, persists records,
 * and automatically triggers task generation, Meet link creation, and initial email delivery.
 */
export async function processEmployeeImportAndAutoAssign(params: {
  fileBuffer: Buffer;
  fileName: string;
  managerUid: string;
  workspaceToken?: string;
  baseUrl: string;
}) {
  await ensureDatabaseReady();
  await ensureDefaultDomainConfigs();
  cacheManagerWorkspaceToken(params.managerUid, params.workspaceToken);

  const existingEmpRows = await db.select({ email: employees.email }).from(employees);
  const existingEmailSet = new Set(existingEmpRows.map((e) => e.email.toLowerCase()));

  const parsed = parseEmployeeSheetBuffer(
    params.fileBuffer,
    params.fileName,
    existingEmailSet
  );

  const [batch] = await db
    .insert(importBatches)
    .values({
      batchCode: makeCode('IMP'),
      fileName: params.fileName,
      totalRows: parsed.totalRows,
      validCount: parsed.validRows.length,
      duplicateCount: parsed.duplicateCount,
      invalidCount: parsed.invalidCount,
      domainsDetected: parsed.domainsDetected,
      tasksAssignedCount: 0,
      rowErrors: parsed.rowErrors,
      importedByUid: params.managerUid,
    })
    .returning();

  const createdEmployeeIds: number[] = [];

  for (const row of parsed.validRows) {
    const [emp] = await db
      .insert(employees)
      .values({
        employeeCode: makeCode('EMP'),
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        technicalDomain: row.technicalDomain,
        domainKey: row.domainKey,
        importBatchId: batch.id,
        status: 'active',
      })
      .returning();

    createdEmployeeIds.push(emp.id);

    await enqueueAutomationJob({
      jobType: 'assign_employee_task',
      employeeId: emp.id,
      idempotencyKey: `assign-initial-task-emp-${emp.id}`,
      payload: {
        employeeId: emp.id,
        batchId: batch.id,
        managerUid: params.managerUid,
        baseUrl: params.baseUrl,
      },
    });
  }

  await recordAuditLog({
    actor: params.managerUid,
    eventType: 'employee_batch_imported',
    summary: `Imported ${parsed.validRows.length} eligible employee(s) from ${params.fileName} across ${parsed.domainsDetected.length} technical domain(s).`,
    metadata: {
      batchCode: batch.batchCode,
      validCount: parsed.validRows.length,
      duplicateCount: parsed.duplicateCount,
      invalidCount: parsed.invalidCount,
      domainsDetected: parsed.domainsDetected,
    },
  });

  // Trigger immediate asynchronous drain of queued assignment jobs so automation starts right away
  void drainAutomationQueue();

  eventPublisher('import:completed', {
    batchId: batch.id,
    validCount: parsed.validRows.length,
  });

  return {
    batch,
    importedEmployeesCount: createdEmployeeIds.length,
    rowErrors: parsed.rowErrors,
  };
}

export async function executeAssignEmployeeTask(payload: {
  employeeId: number;
  batchId?: number;
  managerUid?: string;
  baseUrl?: string;
}) {
  await ensureDatabaseReady();

  // Idempotency guard: if employee already has an initial task for this onboarding, skip duplicate creation
  const existingTask = await db
    .select()
    .from(employeeTasks)
    .where(eq(employeeTasks.employeeId, payload.employeeId))
    .limit(1);

  if (existingTask[0]) {
    return existingTask[0];
  }

  const [emp] = await db
    .select()
    .from(employees)
    .where(eq(employees.id, payload.employeeId))
    .limit(1);
  if (!emp) {
    throw new Error(`Employee ${payload.employeeId} not found.`);
  }

  const [manager] = payload.managerUid
    ? await db.select().from(users).where(eq(users.uid, payload.managerUid)).limit(1)
    : [];

  const [domainCfg] = await db
    .select()
    .from(domainTaskConfigs)
    .where(eq(domainTaskConfigs.domainKey, emp.domainKey))
    .limit(1);

  const timezone = validateTimezone(
    domainCfg?.timezone || manager?.timezone || process.env.DEFAULT_TIMEZONE || 'UTC'
  );
  const deadlineDays = domainCfg?.deadlineDays ?? manager?.defaultDeadlineDays ?? 2;
  const generationMode: 'ai_dynamic' | 'template' =
    manager?.autoGenerateTasks === false
      ? 'template'
      : ((domainCfg?.generationMode as 'ai_dynamic' | 'template') ?? 'ai_dynamic');

  const assignedAt = new Date();
  const deadlineAt = calculateConsistentDeadline(assignedAt, deadlineDays);

  const generatedSpec = await generateTaskForDomainConfig({
    employeeName: emp.fullName,
    technicalDomain: emp.technicalDomain,
    generationMode,
    templateConfig: domainCfg ?? null,
    deadlineAt,
    timezone,
  });

  const portalToken = crypto.randomBytes(20).toString('hex');
  const baseUrl = payload.baseUrl || process.env.APP_URL || 'http://localhost:3000';
  const portalUrl = buildEmployeePortalUrl(baseUrl, portalToken);

  const workspaceToken = getAnyCachedWorkspaceToken(payload.managerUid);
  const onboardingStart = new Date(Date.now() + 15 * 60 * 1000);

  const meetSession = await createGoogleMeetCalendarSession({
    workspaceToken,
    summary: `AI Task Briefing: ${generatedSpec.title} (${emp.fullName})`,
    description: `Automated ${emp.technicalDomain} task briefing.\nInteractive AI Voice Bot Portal: ${portalUrl}`,
    startAt: onboardingStart,
    durationMinutes: 25,
    timezone,
    attendeeEmail: emp.email,
  });

  const [createdTask] = await db
    .insert(employeeTasks)
    .values({
      taskCode: makeCode('TSK'),
      employeeId: emp.id,
      domainKey: emp.domainKey,
      technicalDomain: emp.technicalDomain,
      portalToken,
      title: generatedSpec.title,
      description: generatedSpec.description,
      whyRequired: generatedSpec.whyRequired,
      exactRequirements: generatedSpec.exactRequirements,
      expectedOutput: generatedSpec.expectedOutput,
      implementationSteps: generatedSpec.implementationSteps,
      acceptanceCriteria: generatedSpec.acceptanceCriteria,
      timezone,
      assignedAt,
      deadlineAt,
      status: 'assigned',
      onboardingMeetLink: meetSession.meetLink,
      onboardingCalendarEventId: meetSession.calendarEventId,
      onboardingMeetingStart: meetSession.meetLink ? onboardingStart : null,
      meetingIntegrationMode: meetSession.integrationMode,
      currentRevisionNumber: 0,
      voiceBriefingScript: generatedSpec.voiceBriefingScript,
    })
    .returning();

  if (payload.batchId) {
    const [batch] = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, payload.batchId))
      .limit(1);
    if (batch) {
      await db
        .update(importBatches)
        .set({ tasksAssignedCount: batch.tasksAssignedCount + 1 })
        .where(eq(importBatches.id, batch.id));
    }
  }

  const emailContent = composeInitialAssignmentEmail({
    employeeName: emp.fullName,
    technicalDomain: emp.technicalDomain,
    taskTitle: createdTask.title,
    taskCode: createdTask.taskCode,
    portalUrl,
    deadlineAt: createdTask.deadlineAt,
    timezone: createdTask.timezone,
    meetLink: createdTask.onboardingMeetLink,
    meetingStart: createdTask.onboardingMeetingStart,
  });

  await sendIdempotentEmployeeEmail({
    taskId: createdTask.id,
    employeeId: emp.id,
    emailType: 'initial_assignment',
    recipientEmail: emp.email,
    subject: emailContent.subject,
    bodyText: emailContent.bodyText,
    idempotencyKey: `email-initial-assignment-task-${createdTask.id}`,
    workspaceToken,
  });

  await recordAuditLog({
    actor: 'automation_engine',
    eventType: 'task_auto_assigned',
    taskId: createdTask.id,
    employeeId: emp.id,
    summary: `Assigned "${createdTask.title}" (${createdTask.taskCode}) to ${emp.fullName} [${emp.technicalDomain}] and queued initial portal + meeting email.`,
  });

  eventPublisher('task:updated', { taskId: createdTask.id, status: createdTask.status });
  return createdTask;
}

/**
 * Step 2b: Automatically triggered when the employee finishes their initial AI Voice task-explanation
 * conversation. Never resets or alters `deadlineAt`, schedules the review Google Meet session if supported,
 * and dispatches the Post-Briefing Specification & Deadline Email idempotently.
 */
export async function completeInitialVoiceBriefingAndSendEmail(params: {
  portalToken: string;
  baseUrl?: string;
}) {
  await ensureDatabaseReady();

  const [task] = await db
    .select()
    .from(employeeTasks)
    .where(eq(employeeTasks.portalToken, params.portalToken))
    .limit(1);
  if (!task) {
    throw new Error('Employee task not found.');
  }

  const [emp] = await db
    .select()
    .from(employees)
    .where(eq(employees.id, task.employeeId))
    .limit(1);
  if (!emp) {
    throw new Error('Employee record not found.');
  }

  const workspaceToken = getAnyCachedWorkspaceToken();
  let reviewMeetLink = task.reviewMeetLink;
  let reviewCalendarEventId = task.reviewCalendarEventId;
  let reviewMeetingStart = task.reviewMeetingStart;

  if (!reviewMeetLink && workspaceToken) {
    // Schedule review session 2 hours before the stored deadline (or +24h if sooner)
    const suggestedReviewStart = new Date(
      Math.max(Date.now() + 60 * 60 * 1000, task.deadlineAt.getTime() - 2 * 60 * 60 * 1000)
    );
    const meet = await createGoogleMeetCalendarSession({
      workspaceToken,
      summary: `AI Code Review Session: ${task.title} (${emp.fullName})`,
      description: `Scheduled GitHub review session for ${task.taskCode}.`,
      startAt: suggestedReviewStart,
      durationMinutes: 30,
      timezone: task.timezone,
      attendeeEmail: emp.email,
    });
    reviewMeetLink = meet.meetLink;
    reviewCalendarEventId = meet.calendarEventId;
    reviewMeetingStart = meet.meetLink ? suggestedReviewStart : null;
  }

  const nextStatus = task.status === 'assigned' ? 'voice_briefing_completed' : task.status;
  // CRITICAL: deadlineAt is NEVER modified here or on email retries!
  const [updatedTask] = await db
    .update(employeeTasks)
    .set({
      status: nextStatus,
      briefingCompletedAt: task.briefingCompletedAt ?? new Date(),
      reviewMeetLink,
      reviewCalendarEventId,
      reviewMeetingStart,
      updatedAt: new Date(),
    })
    .where(eq(employeeTasks.id, task.id))
    .returning();

  // Mark active onboarding voice sessions completed
  await db
    .update(voiceSessions)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(voiceSessions.taskId, task.id));

  const baseUrl = params.baseUrl || process.env.APP_URL || 'http://localhost:3000';
  const portalUrl = buildEmployeePortalUrl(baseUrl, task.portalToken);

  const followupEmail = composePostBriefingFollowupEmail({
    employeeName: emp.fullName,
    taskTitle: updatedTask.title,
    taskCode: updatedTask.taskCode,
    description: updatedTask.description,
    exactRequirements: updatedTask.exactRequirements,
    acceptanceCriteria: updatedTask.acceptanceCriteria,
    deadlineAt: updatedTask.deadlineAt, // Exact stored deadline preserved
    timezone: updatedTask.timezone,
    portalUrl,
    reviewMeetLink: updatedTask.reviewMeetLink,
    reviewMeetingStart: updatedTask.reviewMeetingStart,
  });

  const emailRecord = await sendIdempotentEmployeeEmail({
    taskId: updatedTask.id,
    employeeId: emp.id,
    emailType: 'post_briefing_summary',
    recipientEmail: emp.email,
    subject: followupEmail.subject,
    bodyText: followupEmail.bodyText,
    idempotencyKey: `email-post-briefing-task-${updatedTask.id}`,
    workspaceToken,
  });

  await recordAuditLog({
    actor: emp.email,
    eventType: 'voice_briefing_completed',
    taskId: updatedTask.id,
    employeeId: emp.id,
    summary: `${emp.fullName} completed initial AI voice briefing; post-briefing specification & deadline email triggered.`,
  });

  eventPublisher('task:updated', { taskId: updatedTask.id, status: updatedTask.status });
  return { task: updatedTask, emailRecord };
}

/**
 * Step 3-6: Employee submits or updates a public GitHub repository URL on their portal.
 * Automatically queues and executes full commit inspection, requirement verification,
 * revision delta comparison, voice error script preparation, and review/completion email dispatch.
 */
export async function submitEmployeeGitHubRepo(params: {
  portalToken: string;
  repositoryUrl: string;
  branch?: string;
  baseUrl?: string;
}) {
  await ensureDatabaseReady();

  // Validate URL format & SSRF rules immediately before queuing
  const parsedUrl = validateAndParseGitHubUrl(params.repositoryUrl);

  const [task] = await db
    .select()
    .from(employeeTasks)
    .where(eq(employeeTasks.portalToken, params.portalToken))
    .limit(1);

  if (!task) {
    throw new Error('Invalid employee task token.');
  }

  const nextRevision = task.currentRevisionNumber + 1;

  await db
    .update(employeeTasks)
    .set({
      status: 'review_queued',
      updatedAt: new Date(),
    })
    .where(eq(employeeTasks.id, task.id));

  const job = await enqueueAutomationJob({
    jobType: 'review_github_submission',
    taskId: task.id,
    employeeId: task.employeeId,
    idempotencyKey: `review-sub-task-${task.id}-rev-${nextRevision}`,
    payload: {
      taskId: task.id,
      revisionNumber: nextRevision,
      repositoryUrl: parsedUrl.normalizedUrl,
      branch: params.branch?.trim() || parsedUrl.branchHint || '',
      baseUrl: params.baseUrl || process.env.APP_URL || 'http://localhost:3000',
    },
  });

  eventPublisher('task:updated', { taskId: task.id, status: 'review_queued' });
  void drainAutomationQueue();

  return { queuedJobId: job.id, revisionNumber: nextRevision };
}

export async function executeReviewGitHubSubmissionJob(payload: {
  taskId: number;
  revisionNumber: number;
  repositoryUrl: string;
  branch?: string;
  baseUrl?: string;
}) {
  await ensureDatabaseReady();

  const [task] = await db
    .select()
    .from(employeeTasks)
    .where(eq(employeeTasks.id, payload.taskId))
    .limit(1);
  if (!task) throw new Error(`Task ${payload.taskId} not found.`);

  const [emp] = await db
    .select()
    .from(employees)
    .where(eq(employees.id, task.employeeId))
    .limit(1);
  if (!emp) throw new Error(`Employee ${task.employeeId} not found.`);

  // Load previous review if this is a resubmission (revision >= 2)
  const prevReviews = await db
    .select()
    .from(submissionReviews)
    .where(eq(submissionReviews.taskId, task.id))
    .orderBy(desc(submissionReviews.revisionNumber))
    .limit(1);

  let inspection;
  try {
    inspection = await inspectGitHubRepository(
      payload.repositoryUrl,
      payload.branch || undefined
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'GitHub repository inaccessible';
    const [failedSub] = await db
      .insert(githubSubmissions)
      .values({
        taskId: task.id,
        employeeId: emp.id,
        revisionNumber: payload.revisionNumber,
        repositoryUrl: payload.repositoryUrl,
        repoOwner: 'unverified',
        repoName: 'unverified',
        branch: payload.branch || 'main',
        commitSha: 'unreachable',
        testExecutionStatus: 'unable_to_verify',
        testExecutionSummary: errMsg,
        limitationsNote: errMsg,
      })
      .returning();

    const spokenScript = `Hello ${
      emp.fullName.split(' ')[0]
    }, I tried to inspect your submitted GitHub repository for revision ${
      payload.revisionNumber
    }, but encountered an access issue: ${errMsg}. Please ensure the repository is public and the branch name is accurate, then submit again.`;

    const [failedReview] = await db
      .insert(submissionReviews)
      .values({
        submissionId: failedSub.id,
        taskId: task.id,
        revisionNumber: payload.revisionNumber,
        overallVerdict: 'unable_to_verify',
        scorePercent: 0,
        summary: `Unable to retrieve repository: ${errMsg}`,
        criterionResults: task.acceptanceCriteria.map((ac) => ({
          criterionId: ac.id,
          title: ac.title,
          required: ac.required,
          status: 'unable_to_verify' as const,
          evidenceFiles: [],
          explanation: errMsg,
        })),
        detectedIssues: [
          {
            id: 'REPO-ACCESS',
            severity: 'high',
            affectedFile: payload.repositoryUrl,
            codeSection: 'Repository visibility / branch',
            title: 'Repository could not be retrieved from GitHub API',
            whyItMatters: 'Source files and commits must be readable to verify task requirements.',
            howToFix: 'Confirm the GitHub repository is public and the branch exists, then resubmit.',
          },
        ],
        fixedIssuesFromPrevious: [],
        remainingIssues: [errMsg],
        spokenExplanationScript: spokenScript,
        modelUsed: 'github-inspector',
      })
      .returning();

    await db
      .update(employeeTasks)
      .set({
        status: 'unable_to_verify',
        currentRevisionNumber: payload.revisionNumber,
        latestReviewVoiceScript: spokenScript,
        updatedAt: new Date(),
      })
      .where(eq(employeeTasks.id, task.id));

    const portalUrl = buildEmployeePortalUrl(
      payload.baseUrl || process.env.APP_URL || 'http://localhost:3000',
      task.portalToken
    );

    const feedbackMail = composeReviewFeedbackEmail({
      employeeName: emp.fullName,
      taskTitle: task.title,
      taskCode: task.taskCode,
      revisionNumber: payload.revisionNumber,
      repositoryUrl: payload.repositoryUrl,
      commitSha: 'unreachable',
      verdict: 'unable_to_verify',
      summary: failedReview.summary,
      criterionResults: failedReview.criterionResults,
      detectedIssues: failedReview.detectedIssues,
      fixedIssuesFromPrevious: [],
      portalUrl,
      reviewMeetLink: task.reviewMeetLink,
      reviewMeetingStart: task.reviewMeetingStart,
      deadlineAt: task.deadlineAt,
      timezone: task.timezone,
    });

    await sendIdempotentEmployeeEmail({
      taskId: task.id,
      employeeId: emp.id,
      emailType: 'review_feedback',
      recipientEmail: emp.email,
      subject: feedbackMail.subject,
      bodyText: feedbackMail.bodyText,
      idempotencyKey: `email-review-task-${task.id}-rev-${payload.revisionNumber}`,
      workspaceToken: getAnyCachedWorkspaceToken(),
    });

    eventPublisher('review:completed', {
      taskId: task.id,
      revisionNumber: payload.revisionNumber,
      verdict: 'unable_to_verify',
    });
    return failedReview;
  }

  const verifications = runControlledVerification(inspection);

  const [submission] = await db
    .insert(githubSubmissions)
    .values({
      taskId: task.id,
      employeeId: emp.id,
      revisionNumber: payload.revisionNumber,
      repositoryUrl: inspection.normalizedUrl,
      repoOwner: inspection.owner,
      repoName: inspection.repo,
      branch: inspection.branch,
      commitSha: inspection.commitSha,
      commitMessage: inspection.commitMessage,
      commitAuthor: inspection.commitAuthor,
      commitTimestamp: inspection.commitTimestamp,
      detectedLanguages: inspection.detectedLanguages,
      inspectedFiles: inspection.inspectedFiles,
      readmeFound: inspection.readmeFound,
      testsFound: inspection.testsFound,
      lintConfigFound: inspection.lintConfigFound,
      secretsDetected: inspection.hardcodedSecretsDetected,
      promptInjectionFlags: inspection.promptInjectionFlags,
      testExecutionStatus: verifications[0]?.status ?? 'static_verification',
      testExecutionSummary: verifications
        .map((v) => `${v.executionMode}: ${v.status} ${v.stdoutExcerpt || v.stderrExcerpt}`)
        .join(' | '),
      limitationsNote: verifications.map((v) => v.limitationsNote).join(' '),
    })
    .returning();

  const evaluated = await evaluateEmployeeRepositorySubmission({
    employeeName: emp.fullName,
    taskTitle: task.title,
    taskDescription: task.description,
    exactRequirements: task.exactRequirements,
    acceptanceCriteria: task.acceptanceCriteria,
    revisionNumber: payload.revisionNumber,
    inspection,
    verifications,
    previousReview: prevReviews[0]
      ? {
          revisionNumber: prevReviews[0].revisionNumber,
          detectedIssues: prevReviews[0].detectedIssues,
          criterionResults: prevReviews[0].criterionResults,
        }
      : null,
  });

  const [savedReview] = await db
    .insert(submissionReviews)
    .values({
      submissionId: submission.id,
      taskId: task.id,
      revisionNumber: payload.revisionNumber,
      overallVerdict: evaluated.overallVerdict,
      scorePercent: evaluated.scorePercent,
      summary: evaluated.summary,
      criterionResults: evaluated.criterionResults,
      detectedIssues: evaluated.detectedIssues,
      fixedIssuesFromPrevious: evaluated.fixedIssuesFromPrevious,
      remainingIssues: evaluated.remainingIssues,
      spokenExplanationScript: evaluated.spokenExplanationScript,
      modelUsed: evaluated.modelUsed,
    })
    .returning();

  const workspaceToken = getAnyCachedWorkspaceToken();
  let reviewMeetLink = task.reviewMeetLink;
  let reviewMeetingStart = task.reviewMeetingStart;
  let reviewCalendarEventId = task.reviewCalendarEventId;

  if (evaluated.overallVerdict !== 'completed' && workspaceToken && !reviewMeetLink) {
    const nextMeetTime = new Date(Date.now() + 30 * 60 * 1000);
    const meet = await createGoogleMeetCalendarSession({
      workspaceToken,
      summary: `AI Review Walkthrough (Rev #${payload.revisionNumber}): ${task.title}`,
      description: `Review findings discussion for ${emp.fullName}.`,
      startAt: nextMeetTime,
      durationMinutes: 25,
      timezone: task.timezone,
      attendeeEmail: emp.email,
    });
    reviewMeetLink = meet.meetLink;
    reviewCalendarEventId = meet.calendarEventId;
    reviewMeetingStart = meet.meetLink ? nextMeetTime : null;
  }

  await db
    .update(employeeTasks)
    .set({
      status: evaluated.overallVerdict,
      currentRevisionNumber: payload.revisionNumber,
      latestReviewVoiceScript: evaluated.spokenExplanationScript,
      reviewMeetLink,
      reviewCalendarEventId,
      reviewMeetingStart,
      completedAt: evaluated.overallVerdict === 'completed' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(employeeTasks.id, task.id));

  const portalUrl = buildEmployeePortalUrl(
    payload.baseUrl || process.env.APP_URL || 'http://localhost:3000',
    task.portalToken
  );

  if (evaluated.overallVerdict === 'completed') {
    const completedMail = composeTaskCompletedEmail({
      employeeName: emp.fullName,
      taskTitle: task.title,
      taskCode: task.taskCode,
      revisionNumber: payload.revisionNumber,
      repositoryUrl: inspection.normalizedUrl,
      commitSha: inspection.commitSha,
      summary: evaluated.summary,
      criterionResults: evaluated.criterionResults,
      portalUrl,
    });
    await sendIdempotentEmployeeEmail({
      taskId: task.id,
      employeeId: emp.id,
      emailType: 'task_completed',
      recipientEmail: emp.email,
      subject: completedMail.subject,
      bodyText: completedMail.bodyText,
      idempotencyKey: `email-completed-task-${task.id}-rev-${payload.revisionNumber}`,
      workspaceToken,
    });
  } else {
    const feedbackMail = composeReviewFeedbackEmail({
      employeeName: emp.fullName,
      taskTitle: task.title,
      taskCode: task.taskCode,
      revisionNumber: payload.revisionNumber,
      repositoryUrl: inspection.normalizedUrl,
      commitSha: inspection.commitSha,
      verdict: evaluated.overallVerdict,
      summary: evaluated.summary,
      criterionResults: evaluated.criterionResults,
      detectedIssues: evaluated.detectedIssues,
      fixedIssuesFromPrevious: evaluated.fixedIssuesFromPrevious,
      portalUrl,
      reviewMeetLink,
      reviewMeetingStart,
      deadlineAt: task.deadlineAt,
      timezone: task.timezone,
    });
    await sendIdempotentEmployeeEmail({
      taskId: task.id,
      employeeId: emp.id,
      emailType: 'review_feedback',
      recipientEmail: emp.email,
      subject: feedbackMail.subject,
      bodyText: feedbackMail.bodyText,
      idempotencyKey: `email-review-task-${task.id}-rev-${payload.revisionNumber}`,
      workspaceToken,
    });
  }

  await recordAuditLog({
    actor: 'automation_engine',
    eventType: 'github_submission_reviewed',
    taskId: task.id,
    employeeId: emp.id,
    summary: `Reviewed Revision #${payload.revisionNumber} (${inspection.commitSha.slice(
      0,
      7
    )}) for ${emp.fullName}: ${evaluated.overallVerdict} (${evaluated.scorePercent}%).`,
    metadata: {
      commitSha: inspection.commitSha,
      verdict: evaluated.overallVerdict,
      issuesCount: evaluated.detectedIssues.length,
    },
  });

  eventPublisher('review:completed', {
    taskId: task.id,
    revisionNumber: payload.revisionNumber,
    verdict: evaluated.overallVerdict,
  });

  return savedReview;
}

export async function retryEmailDeliveryById(emailId: number, workspaceToken?: string) {
  await ensureDatabaseReady();
  const [existing] = await db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.id, emailId))
    .limit(1);
  if (!existing || !existing.taskId || !existing.employeeId) {
    throw new Error('Email delivery record not found.');
  }
  // Retrying email strictly reuses stored subject & bodyText without touching task.deadlineAt!
  const updated = await sendIdempotentEmployeeEmail({
    taskId: existing.taskId,
    employeeId: existing.employeeId,
    emailType: existing.emailType as
      | 'initial_assignment'
      | 'post_briefing_summary'
      | 'review_feedback'
      | 'task_completed',
    recipientEmail: existing.recipientEmail,
    subject: existing.subject,
    bodyText: existing.bodyText,
    idempotencyKey: existing.idempotencyKey,
    workspaceToken: workspaceToken || getAnyCachedWorkspaceToken(),
  });
  eventPublisher('email:updated', { emailId: updated.id, status: updated.deliveryStatus });
  return updated;
}

let activeDrainPromise: Promise<void> | null = null;
let rerunRequested = false;

async function runDrainLoop(): Promise<void> {
  do {
    rerunRequested = false;
    while (true) {
      const dueJobs = await fetchDueAutomationJobs(5);
      if (dueJobs.length === 0) break;

      for (const job of dueJobs) {
        const attemptNumber = job.attempts + 1;
        await db
          .update(automationJobs)
          .set({
            status: 'running',
            attempts: attemptNumber,
          })
          .where(eq(automationJobs.id, job.id));

        try {
          if (job.jobType === 'assign_employee_task') {
            await executeAssignEmployeeTask(job.payload as {
              employeeId: number;
              batchId?: number;
              managerUid?: string;
              baseUrl?: string;
            });
          } else if (job.jobType === 'review_github_submission') {
            await executeReviewGitHubSubmissionJob(job.payload as {
              taskId: number;
              revisionNumber: number;
              repositoryUrl: string;
              branch?: string;
              baseUrl?: string;
            });
          }

          await db
            .update(automationJobs)
            .set({
              status: 'completed',
              completedAt: new Date(),
              lastError: null,
            })
            .where(eq(automationJobs.id, job.id));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Automation job failed';
          const canRetry = attemptNumber < job.maxAttempts;
          const backoffMs = Math.min(60_000, 1500 * Math.pow(2, attemptNumber));
          await db
            .update(automationJobs)
            .set({
              status: canRetry ? 'retrying' : 'dead_letter',
              runAt: new Date(Date.now() + backoffMs),
              lastError: message,
            })
            .where(eq(automationJobs.id, job.id));
        }
      }
    }
  } while (rerunRequested);
}

export async function drainAutomationQueue(): Promise<void> {
  if (activeDrainPromise) {
    rerunRequested = true;
    return activeDrainPromise;
  }
  activeDrainPromise = runDrainLoop().finally(() => {
    activeDrainPromise = null;
  });
  return activeDrainPromise;
}
