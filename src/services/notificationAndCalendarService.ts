import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db, ensureDatabaseReady } from '../db/index.ts';
import { formatDeadlineInTimezone } from '../db/repositories.ts';
import {
  emailDeliveries,
  type AcceptanceCriterionSpec,
  type CodeIssueFinding,
  type CriterionVerificationResult,
} from '../db/schema.ts';

const recentOutboundTimestamps: number[] = [];
const MAX_EMAILS_PER_MINUTE = 30;

function allowOutboundSend(): boolean {
  const now = Date.now();
  while (recentOutboundTimestamps.length > 0 && now - recentOutboundTimestamps[0] > 60_000) {
    recentOutboundTimestamps.shift();
  }
  if (recentOutboundTimestamps.length >= MAX_EMAILS_PER_MINUTE) {
    return false;
  }
  recentOutboundTimestamps.push(now);
  return true;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendViaGmailWorkspaceApi(params: {
  workspaceToken: string;
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ providerMessageId: string }> {
  const mime = [
    `To: ${params.to}`,
    `Subject: =?utf-8?B?${Buffer.from(params.subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.bodyText,
  ].join('\r\n');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.workspaceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encodeBase64Url(mime) }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error('Gmail API did not return a confirmed message ID.');
  }
  return { providerMessageId: data.id };
}

async function sendViaSmtpServer(params: {
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ providerMessageId: string }> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.SMTP_FROM?.trim() || user || 'automation@example.org';

  if (!host || !user || !pass) {
    throw new Error('SMTP server credentials are not configured.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from,
    to: params.to,
    subject: params.subject,
    text: params.bodyText,
  });

  if (!info.messageId) {
    throw new Error('SMTP server did not confirm messageId.');
  }
  return { providerMessageId: info.messageId };
}

/**
 * Sends an automated email idempotently. Retrying a failed email updates the existing record
 * without ever duplicating already-delivered emails or altering stored task deadlines.
 */
export async function sendIdempotentEmployeeEmail(params: {
  taskId: number;
  employeeId: number;
  emailType:
    | 'initial_assignment'
    | 'post_briefing_summary'
    | 'review_feedback'
    | 'task_completed';
  recipientEmail: string;
  subject: string;
  bodyText: string;
  idempotencyKey: string;
  workspaceToken?: string;
}) {
  await ensureDatabaseReady();

  const existingRows = await db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.idempotencyKey, params.idempotencyKey))
    .limit(1);

  if (existingRows[0] && existingRows[0].deliveryStatus === 'delivered') {
    return existingRows[0];
  }

  const hasSmtp = Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim()
  );

  let channel = 'awaiting_provider';
  let deliveryStatus = 'awaiting_provider';
  let providerMessageId: string | null = null;
  let lastError: string | null = null;
  let sentAt: Date | null = null;

  if (!allowOutboundSend()) {
    deliveryStatus = 'failed';
    lastError = 'Outbound rate limit reached (max 30 emails/min); scheduled for retry.';
  } else if (params.workspaceToken) {
    channel = 'gmail_api';
    try {
      const result = await sendViaGmailWorkspaceApi({
        workspaceToken: params.workspaceToken,
        to: params.recipientEmail,
        subject: params.subject,
        bodyText: params.bodyText,
      });
      deliveryStatus = 'delivered';
      providerMessageId = result.providerMessageId;
      sentAt = new Date();
    } catch (err) {
      deliveryStatus = 'failed';
      lastError = err instanceof Error ? err.message : 'Gmail API delivery failed';
    }
  } else if (hasSmtp) {
    channel = 'smtp';
    try {
      const result = await sendViaSmtpServer({
        to: params.recipientEmail,
        subject: params.subject,
        bodyText: params.bodyText,
      });
      deliveryStatus = 'delivered';
      providerMessageId = result.providerMessageId;
      sentAt = new Date();
    } catch (err) {
      deliveryStatus = 'failed';
      lastError = err instanceof Error ? err.message : 'SMTP delivery failed';
    }
  } else {
    channel = 'awaiting_provider';
    deliveryStatus = 'awaiting_provider';
    lastError =
      'Email queued in outbox. Connect Google Workspace (Gmail) on Manager sign-in or set SMTP_HOST/SMTP_USER/SMTP_PASS to dispatch externally.';
  }

  if (existingRows[0]) {
    const [updated] = await db
      .update(emailDeliveries)
      .set({
        recipientEmail: params.recipientEmail,
        subject: params.subject,
        bodyText: params.bodyText,
        channel,
        deliveryStatus,
        providerMessageId,
        retryCount: existingRows[0].retryCount + 1,
        lastError,
        sentAt,
      })
      .where(eq(emailDeliveries.id, existingRows[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(emailDeliveries)
    .values({
      taskId: params.taskId,
      employeeId: params.employeeId,
      emailType: params.emailType,
      recipientEmail: params.recipientEmail,
      subject: params.subject,
      bodyText: params.bodyText,
      idempotencyKey: params.idempotencyKey,
      channel,
      deliveryStatus,
      providerMessageId,
      lastError,
      sentAt,
    })
    .returning();

  return created;
}

/**
 * Creates a genuine Google Calendar event with a real Google Meet conference link
 * ONLY when a valid Workspace OAuth token is available. Never fabricates a Meet URL.
 */
export async function createGoogleMeetCalendarSession(params: {
  workspaceToken?: string;
  summary: string;
  description: string;
  startAt: Date;
  durationMinutes?: number;
  timezone: string;
  attendeeEmail: string;
}): Promise<{
  meetLink: string | null;
  calendarEventId: string | null;
  integrationMode: 'google_calendar_meet_plus_embedded_voice' | 'embedded_voice_portal_only';
}> {
  if (!params.workspaceToken) {
    return {
      meetLink: null,
      calendarEventId: null,
      integrationMode: 'embedded_voice_portal_only',
    };
  }

  const endAt = new Date(
    params.startAt.getTime() + (params.durationMinutes ?? 30) * 60 * 1000
  );

  try {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.workspaceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: params.summary,
          description: params.description,
          start: { dateTime: params.startAt.toISOString(), timeZone: params.timezone || 'UTC' },
          end: { dateTime: endAt.toISOString(), timeZone: params.timezone || 'UTC' },
          attendees: [{ email: params.attendeeEmail }],
          conferenceData: {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.warn(`Google Calendar Meet creation returned ${res.status}: ${errBody.slice(0, 180)}`);
      return {
        meetLink: null,
        calendarEventId: null,
        integrationMode: 'embedded_voice_portal_only',
      };
    }

    const data = (await res.json()) as {
      id?: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: Array<{ uri?: string; entryPointType?: string }> };
    };

    const meetLink =
      data.hangoutLink ||
      data.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri ||
      null;

    return {
      meetLink,
      calendarEventId: data.id ?? null,
      integrationMode: meetLink
        ? 'google_calendar_meet_plus_embedded_voice'
        : 'embedded_voice_portal_only',
    };
  } catch (err) {
    console.warn('Google Calendar API call failed; falling back to embedded voice portal:', err);
    return {
      meetLink: null,
      calendarEventId: null,
      integrationMode: 'embedded_voice_portal_only',
    };
  }
}

export function composeInitialAssignmentEmail(params: {
  employeeName: string;
  technicalDomain: string;
  taskTitle: string;
  taskCode: string;
  portalUrl: string;
  deadlineAt: Date;
  timezone: string;
  meetLink: string | null;
  meetingStart: Date | null;
}): { subject: string; bodyText: string } {
  const formattedDeadline = formatDeadlineInTimezone(params.deadlineAt, params.timezone);
  const meetSection = params.meetLink
    ? `Scheduled Google Meet Session: ${params.meetLink}\nSession Time: ${
        params.meetingStart
          ? formatDeadlineInTimezone(params.meetingStart, params.timezone)
          : 'Available immediately'
      }\n(Note: Interactive live voice Q&A with your AI Task Bot runs directly inside your Employee AI Bot Portal link below.)`
    : `Interactive AI Voice Briefing Room: Available immediately inside your Employee AI Bot Portal link below (embedded live voice session).`;

  return {
    subject: `[Task Assigned] ${params.taskTitle} (${params.taskCode}) — AI Voice Briefing Ready`,
    bodyText: `Hello ${params.employeeName},

You have been automatically assigned a new ${params.technicalDomain} engineering task.

Task: ${params.taskTitle} (${params.taskCode})
Submission Deadline: ${formattedDeadline}

1. Open your personalized Employee AI Bot Portal to hear your interactive spoken task explanation and ask questions in real time:
${params.portalUrl}

2. Meeting & Voice Session Details:
${meetSection}

Once you complete the voice task-explanation conversation on your portal, the system will automatically email you the full written task requirements, acceptance criteria, and GitHub submission instructions.

Automated Engineering Task & Review System`,
  };
}

export function composePostBriefingFollowupEmail(params: {
  employeeName: string;
  taskTitle: string;
  taskCode: string;
  description: string;
  exactRequirements: string[];
  acceptanceCriteria: AcceptanceCriterionSpec[];
  deadlineAt: Date;
  timezone: string;
  portalUrl: string;
  reviewMeetLink: string | null;
  reviewMeetingStart: Date | null;
}): { subject: string; bodyText: string } {
  const formattedDeadline = formatDeadlineInTimezone(params.deadlineAt, params.timezone);
  const reviewMeetSection = params.reviewMeetLink
    ? `Scheduled Google Meet Review Link: ${params.reviewMeetLink}${
        params.reviewMeetingStart
          ? ` (${formatDeadlineInTimezone(params.reviewMeetingStart, params.timezone)})`
          : ''
      }\nInteractive AI Voice Review Fallback: ${params.portalUrl}`
    : `Interactive AI Voice Review Session Link: ${params.portalUrl}`;

  return {
    subject: `[Task Specification & Deadline] ${params.taskTitle} (${params.taskCode})`,
    bodyText: `Hello ${params.employeeName},

Thank you for completing your AI task-explanation session. Below is the complete specification for your assigned task.

TASK DESCRIPTION
${params.taskTitle} (${params.taskCode})
${params.description}

TECHNICAL REQUIREMENTS
${params.exactRequirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}

ACCEPTANCE CRITERIA
${params.acceptanceCriteria
  .map((ac) => `- [${ac.id}] ${ac.title}: ${ac.description}`)
  .join('\n')}

EXACT SUBMISSION DEADLINE
${formattedDeadline}

GITHUB REPOSITORY SUBMISSION INSTRUCTIONS
1. Push your complete implementation, automated tests, and README.md to a public GitHub repository.
2. Open your unique Employee Task Portal link below and submit the HTTPS GitHub repository URL.
3. The AI Review Bot will automatically inspect your commit, verify every acceptance criterion, and explain any required fixes in voice.

SCHEDULED REVIEW SESSION & PORTAL LINK
${reviewMeetSection}
Unique Employee Task Portal: ${params.portalUrl}

Automated Engineering Task & Review System`,
  };
}

export function composeReviewFeedbackEmail(params: {
  employeeName: string;
  taskTitle: string;
  taskCode: string;
  revisionNumber: number;
  repositoryUrl: string;
  commitSha: string;
  verdict: 'changes_requested' | 'unable_to_verify';
  summary: string;
  criterionResults: CriterionVerificationResult[];
  detectedIssues: CodeIssueFinding[];
  fixedIssuesFromPrevious: string[];
  portalUrl: string;
  reviewMeetLink: string | null;
  reviewMeetingStart: Date | null;
  deadlineAt: Date;
  timezone: string;
}): { subject: string; bodyText: string } {
  const completedReqs = params.criterionResults.filter(
    (c) => c.status === 'verified_complete'
  );
  const incompleteReqs = params.criterionResults.filter(
    (c) => c.status !== 'verified_complete'
  );

  const meetSection = params.reviewMeetLink
    ? `Next Review Google Meet Link: ${params.reviewMeetLink}${
        params.reviewMeetingStart
          ? ` (${formatDeadlineInTimezone(params.reviewMeetingStart, params.timezone)})`
          : ''
      }\nInteractive AI Voice Error Walkthrough (Live Now): ${params.portalUrl}`
    : `Interactive AI Voice Error Walkthrough (Live Now): ${params.portalUrl}`;

  return {
    subject: `[Revision #${params.revisionNumber} Review — Action Needed] ${params.taskTitle} (${params.taskCode})`,
    bodyText: `Hello ${params.employeeName},

Our automated GitHub Review Bot has completed the review for Revision #${params.revisionNumber} of "${params.taskTitle}".

REVIEWED REPOSITORY & COMMIT
Repository: ${params.repositoryUrl}
Reviewed Commit: ${params.commitSha}
Status: ${params.verdict === 'unable_to_verify' ? 'Unable to Verify (Action Required)' : 'Changes Requested'}

REVIEW SUMMARY
${params.summary}
${
  params.fixedIssuesFromPrevious.length > 0
    ? `\nFIXED SINCE PREVIOUS REVISION\n${params.fixedIssuesFromPrevious.map((f) => `- ${f}`).join('\n')}\n`
    : ''
}
VERIFIED COMPLETED REQUIREMENTS (${completedReqs.length}/${params.criterionResults.length})
${
  completedReqs.length > 0
    ? completedReqs
        .map((c) => `- [${c.criterionId}] ${c.title} (Evidence: ${c.evidenceFiles.join(', ')})`)
        .join('\n')
    : '- None verified complete yet.'
}

IDENTIFIED ERRORS & MISSING REQUIREMENTS (${incompleteReqs.length} remaining)
${incompleteReqs.map((c) => `- [${c.criterionId}] ${c.title}: ${c.explanation}`).join('\n')}

RECOMMENDED CORRECTIONS BY FILE
${
  params.detectedIssues.length > 0
    ? params.detectedIssues
        .map(
          (iss, idx) =>
            `${idx + 1}. [${iss.severity.toUpperCase()}] ${iss.title}\n   File: ${iss.affectedFile} (${iss.codeSection})\n   Why it matters: ${iss.whyItMatters}\n   How to fix: ${iss.howToFix}`
        )
        .join('\n\n')
    : '- Address the incomplete acceptance criteria listed above.'
}

VOICE REVIEW SESSION & RESUBMISSION INSTRUCTIONS
1. Open your Employee AI Bot Portal to discuss these errors in natural speech with the AI Review Bot:
   ${meetSection}
2. Commit your fixes to GitHub and submit the updated repository on your portal (${params.portalUrl}) before ${formatDeadlineInTimezone(
      params.deadlineAt,
      params.timezone
    )}.

Automated Engineering Task & Review System`,
  };
}

export function composeTaskCompletedEmail(params: {
  employeeName: string;
  taskTitle: string;
  taskCode: string;
  revisionNumber: number;
  repositoryUrl: string;
  commitSha: string;
  summary: string;
  criterionResults: CriterionVerificationResult[];
  portalUrl: string;
}): { subject: string; bodyText: string } {
  return {
    subject: `[Task Completed] ${params.taskTitle} (${params.taskCode}) — All Criteria Verified`,
    bodyText: `Hello ${params.employeeName},

Congratulations! Revision #${params.revisionNumber} of your submission for "${params.taskTitle}" (${params.taskCode}) has passed all required acceptance criteria and static verification checks.

Repository: ${params.repositoryUrl}
Verified Commit: ${params.commitSha}

SUMMARY
${params.summary}

VERIFIED ACCEPTANCE CRITERIA
${params.criterionResults
  .map((c) => `- [${c.criterionId}] ${c.title} — Verified (${c.evidenceFiles.join(', ')})`)
  .join('\n')}

You can review your final report and voice summary anytime at:
${params.portalUrl}

Automated Engineering Task & Review System`,
  };
}
