import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { db, ensureDatabaseReady } from './src/db/index.ts';
import { voiceSessions, type AcceptanceCriterionSpec } from './src/db/schema.ts';
import { getOrCreateUser, updateManagerSettings } from './src/db/users.ts';
import {
  generateSampleEmployeeTemplateCsv,
  generateSampleEmployeeTemplateXlsx,
  loadEmployeePortalByToken,
  loadManagerBootstrap,
  parseEmployeeSheetBuffer,
  recordAuditLog,
  upsertDomainTaskConfig,
  validateTimezone,
} from './src/db/repositories.ts';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import {
  answerEmployeeTaskQuestion,
  synthesizeNaturalSpeechWav,
} from './src/services/aiTaskAndReviewService.ts';
import {
  cacheManagerWorkspaceToken,
  completeInitialVoiceBriefingAndSendEmail,
  drainAutomationQueue,
  processEmployeeImportAndAutoAssign,
  retryEmailDeliveryById,
  submitEmployeeGitHubRepo,
} from './src/services/automationEngine.ts';
import { buildCodebaseZipBuffer } from './src/services/codebaseExportService.ts';
import { attachRealtimeAndVoiceWebSockets } from './src/services/liveVoiceWsServer.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveRequestBaseUrl(req: express.Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const proto =
    (typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0]
      : req.protocol) || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

async function startServer() {
  await ensureDatabaseReady();

  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Health probe
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // ============================================================================
  // PAGE ONE — MANAGER DASHBOARD API (Authenticated)
  // ============================================================================

  app.get('/api/manager/bootstrap', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const email = req.user!.email || `${uid}@authenticated.user`;
      cacheManagerWorkspaceToken(uid, req.workspaceToken);

      const managerUser = await getOrCreateUser(uid, email, req.user!.name ?? null);
      const bootstrap = await loadManagerBootstrap(managerUser, resolveRequestBaseUrl(req));
      res.json(bootstrap);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load manager workspace.';
      res.status(500).json({ error: message });
    }
  });

  app.patch('/api/manager/settings', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      cacheManagerWorkspaceToken(uid, req.workspaceToken);

      const { timezone, defaultDeadlineDays, autoGenerateTasks } = req.body as {
        timezone?: string;
        defaultDeadlineDays?: number;
        autoGenerateTasks?: boolean;
      };

      const updated = await updateManagerSettings(uid, {
        ...(timezone !== undefined ? { timezone: validateTimezone(timezone) } : {}),
        ...(defaultDeadlineDays !== undefined
          ? {
              defaultDeadlineDays: Math.max(
                1,
                Math.min(30, Math.round(Number(defaultDeadlineDays) || 2))
              ),
            }
          : {}),
        ...(typeof autoGenerateTasks === 'boolean' ? { autoGenerateTasks } : {}),
      });

      await recordAuditLog({
        actor: uid,
        eventType: 'manager_settings_updated',
        summary: `Updated automation defaults (timezone: ${updated?.timezone}, deadline: ${updated?.defaultDeadlineDays}d, AI dynamic tasks: ${updated?.autoGenerateTasks}).`,
      });

      res.json({ currentUser: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update settings.';
      res.status(500).json({ error: message });
    }
  });

  app.put('/api/manager/domains/:domainKey', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      cacheManagerWorkspaceToken(uid, req.workspaceToken);

      const body = req.body as {
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
      };

      if (!body.domainName?.trim() || !body.taskTitleTemplate?.trim()) {
        res.status(400).json({ error: 'Domain name and baseline task title are required.' });
        return;
      }

      const saved = await upsertDomainTaskConfig({
        domainKey: req.params.domainKey,
        domainName: body.domainName,
        generationMode: body.generationMode,
        taskTitleTemplate: body.taskTitleTemplate,
        taskDescriptionTemplate: body.taskDescriptionTemplate || '',
        whyRequiredTemplate: body.whyRequiredTemplate || '',
        requirementsTemplate: Array.isArray(body.requirementsTemplate)
          ? body.requirementsTemplate
          : [],
        expectedOutputTemplate: body.expectedOutputTemplate || '',
        implementationStepsTemplate: Array.isArray(body.implementationStepsTemplate)
          ? body.implementationStepsTemplate
          : [],
        acceptanceCriteriaTemplate: Array.isArray(body.acceptanceCriteriaTemplate)
          ? body.acceptanceCriteriaTemplate
          : [],
        deadlineDays: Number(body.deadlineDays) || 2,
        timezone: body.timezone || 'UTC',
        isActive: body.isActive,
      });

      await recordAuditLog({
        actor: uid,
        eventType: 'domain_rule_configured',
        summary: `Configured domain task rule for "${saved.domainName}" (${saved.generationMode}, ${saved.deadlineDays}d deadline).`,
      });

      res.json({ domainConfig: saved });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save domain mapping.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/manager/templates/sample.csv', requireAuth, (_req: AuthRequest, res) => {
    const csv = generateSampleEmployeeTemplateCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="employee_4col_import_template.csv"'
    );
    res.send(csv);
  });

  app.get('/api/manager/templates/sample.xlsx', requireAuth, (_req: AuthRequest, res) => {
    const xlsxBuffer = generateSampleEmployeeTemplateXlsx();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="employee_4col_import_template.xlsx"'
    );
    res.send(xlsxBuffer);
  });

  // Preview 4-column sheet before confirming Workspace automated emails/meetings
  app.post('/api/manager/import/preview', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { fileName, base64Data } = req.body as {
        fileName: string;
        base64Data: string;
      };
      if (!base64Data) {
        res.status(400).json({ error: 'Missing uploaded Excel or CSV payload.' });
        return;
      }
      const buffer = Buffer.from(base64Data, 'base64');
      const existingRows = await db.query?.employees
        ? []
        : [];
      void existingRows;
      const { employees } = await import('./src/db/schema.ts');
      const existingEmps = await db.select({ email: employees.email }).from(employees);
      const existingEmailSet = new Set(existingEmps.map((e) => e.email.toLowerCase()));

      const preview = parseEmployeeSheetBuffer(
        buffer,
        fileName || 'employees.csv',
        existingEmailSet
      );
      res.json({ preview });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to validate file.';
      res.status(400).json({ error: message });
    }
  });

  // Execute full automated import -> domain grouping -> task assignment -> Meet link -> email delivery
  app.post('/api/manager/import', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const { fileName, base64Data } = req.body as {
        fileName: string;
        base64Data: string;
      };
      if (!base64Data) {
        res.status(400).json({ error: 'Missing Excel (.xlsx) or CSV (.csv) file payload.' });
        return;
      }

      const fileBuffer = Buffer.from(base64Data, 'base64');
      const outcome = await processEmployeeImportAndAutoAssign({
        fileBuffer,
        fileName: fileName || 'employees.xlsx',
        managerUid: uid,
        workspaceToken: req.workspaceToken,
        baseUrl: resolveRequestBaseUrl(req),
      });

      res.json(outcome);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Employee import failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/manager/emails/:id/retry', requireAuth, async (req: AuthRequest, res) => {
    try {
      cacheManagerWorkspaceToken(req.user!.uid, req.workspaceToken);
      const updated = await retryEmailDeliveryById(
        Number(req.params.id),
        req.workspaceToken
      );
      res.json({ email: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Email retry failed.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/manager/jobs/drain', requireAuth, async (req: AuthRequest, res) => {
    try {
      cacheManagerWorkspaceToken(req.user!.uid, req.workspaceToken);
      await drainAutomationQueue();
      res.json({ ok: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Queue drain failed.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/export/codebase.zip', requireAuth, async (req: AuthRequest, res) => {
    try {
      const zipBuffer = await buildCodebaseZipBuffer(__dirname);
      await recordAuditLog({
        actor: req.user!.uid,
        eventType: 'codebase_exported',
        summary: 'Exported full-stack codebase archive (.zip).',
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="ai-task-voice-github-review-system.zip"'
      );
      res.send(zipBuffer);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to export codebase.';
      res.status(500).json({ error: message });
    }
  });

  // ============================================================================
  // PAGE TWO — EMPLOYEE AI BOT PORTAL API (Token-Isolated, No Manager Login Needed)
  // ============================================================================

  app.get('/api/portal/:token', async (req, res) => {
    try {
      const portalData = await loadEmployeePortalByToken(req.params.token);
      if (!portalData) {
        res.status(404).json({
          error: 'Invalid or expired employee task link. Check the link sent to your email.',
        });
        return;
      }
      res.json(portalData);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load employee portal.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/portal/:token/tts', async (req, res) => {
    try {
      const portalData = await loadEmployeePortalByToken(req.params.token);
      if (!portalData) {
        res.status(404).json({ error: 'Invalid employee task link.' });
        return;
      }

      const { mode, customText } = req.body as {
        mode?: 'onboarding' | 'review';
        customText?: string;
      };

      const scriptToSpeak =
        customText?.trim() ||
        (mode === 'review' && portalData.task.latestReviewVoiceScript
          ? portalData.task.latestReviewVoiceScript
          : portalData.task.voiceBriefingScript);

      const tts = await synthesizeNaturalSpeechWav(scriptToSpeak);
      res.json({
        spokenText: scriptToSpeak,
        audioWavBase64: tts.audioWavBase64,
        voiceName: tts.voiceName,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Voice speech generation failed.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/portal/:token/ask-voice', async (req, res) => {
    try {
      const portalData = await loadEmployeePortalByToken(req.params.token);
      if (!portalData) {
        res.status(404).json({ error: 'Invalid employee task link.' });
        return;
      }

      const { question } = req.body as { question: string };
      if (!question || !question.trim()) {
        res.status(400).json({ error: 'Please ask or enter a question.' });
        return;
      }

      const result = await answerEmployeeTaskQuestion({
        employeeName: portalData.employee.fullName,
        question: question.trim(),
        taskContext: {
          task: portalData.task,
          latestReview: portalData.latestReview,
        },
      });

      // Record question & answer in voiceSessions history
      const existingSession = portalData.voiceSessions[0];
      const newTurns = [
        ...(existingSession?.transcriptTurns ?? []),
        {
          speaker: 'employee' as const,
          text: question.trim(),
          timestamp: new Date().toISOString(),
        },
        {
          speaker: 'ai_bot' as const,
          text: result.answerText,
          timestamp: new Date().toISOString(),
        },
      ];

      if (existingSession) {
        await db
          .update(voiceSessions)
          .set({
            transcriptTurns: newTurns,
            questionsAskedCount: existingSession.questionsAskedCount + 1,
          })
          .where(eq(voiceSessions.id, existingSession.id));
      } else {
        await db.insert(voiceSessions).values({
          taskId: portalData.task.id,
          employeeId: portalData.employee.id,
          sessionType: portalData.latestReview
            ? 'review_error_explanation'
            : 'initial_task_explanation',
          revisionNumber: portalData.task.currentRevisionNumber,
          transcriptTurns: newTurns,
          questionsAskedCount: 1,
          status: 'started',
        });
      }

      res.json(result);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to answer employee question.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/portal/:token/complete-briefing', async (req, res) => {
    try {
      const outcome = await completeInitialVoiceBriefingAndSendEmail({
        portalToken: req.params.token,
        baseUrl: resolveRequestBaseUrl(req),
      });
      const refreshed = await loadEmployeePortalByToken(req.params.token);
      res.json({
        ok: true,
        emailStatus: outcome.emailRecord.deliveryStatus,
        portal: refreshed,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to finalize voice briefing.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/portal/:token/submit-repo', async (req, res) => {
    try {
      const { repositoryUrl, branch } = req.body as {
        repositoryUrl: string;
        branch?: string;
      };
      if (!repositoryUrl?.trim()) {
        res.status(400).json({ error: 'Public GitHub repository URL is required.' });
        return;
      }

      const queued = await submitEmployeeGitHubRepo({
        portalToken: req.params.token,
        repositoryUrl: repositoryUrl.trim(),
        branch: branch?.trim(),
        baseUrl: resolveRequestBaseUrl(req),
      });

      res.json(queued);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'GitHub submission failed validation.';
      res.status(400).json({ error: message });
    }
  });

  // ============================================================================
  // STATIC / VITE SPA MIDDLEWARE & HTTP + WEBSOCKET SERVER
  // ============================================================================
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  attachRealtimeAndVoiceWebSockets(httpServer);

  // Background queue sweep every 4 seconds so retries and async jobs run even when browsers close
  const workerTimer = setInterval(() => {
    void drainAutomationQueue();
  }, 4000);
  workerTimer.unref();

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(
      `AI Review Automation Platform (HTTP + Live Voice WS) listening on http://0.0.0.0:${PORT}`
    );
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
