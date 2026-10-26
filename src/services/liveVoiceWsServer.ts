import type { Server as HttpServer } from 'node:http';
import { GoogleGenAI, type LiveServerMessage, Modality } from '@google/genai';
import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';
import { db, ensureDatabaseReady } from '../db/index.ts';
import { loadEmployeePortalByToken } from '../db/repositories.ts';
import { voiceSessions, type VoiceTranscriptTurn } from '../db/schema.ts';
import { registerRealtimePublisher } from './automationEngine.ts';

function getLiveAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length === 0) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function attachRealtimeAndVoiceWebSockets(httpServer: HttpServer) {
  const eventsWss = new WebSocketServer({ noServer: true });
  const voiceWss = new WebSocketServer({ noServer: true });

  const connectedEventClients = new Set<WebSocket>();

  eventsWss.on('connection', (ws) => {
    connectedEventClients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    ws.on('close', () => {
      connectedEventClients.delete(ws);
    });
  });

  registerRealtimePublisher((eventType, payload) => {
    const message = JSON.stringify({
      type: eventType,
      payload,
      timestamp: new Date().toISOString(),
    });
    for (const client of connectedEventClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  voiceWss.on('connection', async (clientWs, reqUrl: string) => {
    try {
      await ensureDatabaseReady();
      const urlObj = new URL(reqUrl, 'http://localhost:3000');
      const portalToken = urlObj.searchParams.get('token') || '';
      const modeParam = urlObj.searchParams.get('mode') || 'auto'; // 'onboarding' | 'review' | 'auto'

      const portalData = await loadEmployeePortalByToken(portalToken);
      if (!portalData) {
        clientWs.send(
          JSON.stringify({ type: 'error', error: 'Invalid or expired employee task token.' })
        );
        clientWs.close();
        return;
      }

      const ai = getLiveAiClient();
      if (!ai) {
        clientWs.send(
          JSON.stringify({
            type: 'error',
            error: 'GEMINI_API_KEY is not configured for real-time Live Voice streaming.',
          })
        );
        clientWs.close();
        return;
      }

      const isReviewSession =
        modeParam === 'review' ||
        (modeParam === 'auto' && Boolean(portalData.latestReview));

      const transcriptTurns: VoiceTranscriptTurn[] = [];
      let questionsAskedCount = 0;

      const [sessionRow] = await db
        .insert(voiceSessions)
        .values({
          taskId: portalData.task.id,
          employeeId: portalData.employee.id,
          sessionType: isReviewSession
            ? 'review_error_explanation'
            : 'initial_task_explanation',
          revisionNumber: portalData.task.currentRevisionNumber,
          transcriptTurns: [],
          questionsAskedCount: 0,
          status: 'started',
        })
        .returning()
        .catch(() => [null]);

      const reviewContextBlock = portalData.latestReview
        ? `LATEST GITHUB REVIEW (Revision #${portalData.latestReview.revisionNumber}):
Verdict: ${portalData.latestReview.overallVerdict} (Score: ${portalData.latestReview.scorePercent}%)
Summary: ${portalData.latestReview.summary}
Fixed Since Previous Revision: ${portalData.latestReview.fixedIssuesFromPrevious.join('; ') || 'None'}
Criterion Verification Status:
${portalData.latestReview.criterionResults
  .map((c) => `- [${c.criterionId}] ${c.title}: ${c.status} (${c.explanation})`)
  .join('\n')}
Detected Code Issues & Corrections:
${portalData.latestReview.detectedIssues
  .map(
    (iss) =>
      `- [${iss.severity}] ${iss.title} in ${iss.affectedFile} (${iss.codeSection}). Why: ${iss.whyItMatters}. Fix: ${iss.howToFix}`
  )
  .join('\n')}`
        : 'No GitHub repository submitted yet.';

      const systemInstruction = `You are the interactive AI Engineering Mentor & Code Review Voice Bot speaking directly with ${portalData.employee.fullName} (${portalData.employee.technicalDomain}).

ASSIGNED TASK (${portalData.task.taskCode}): ${portalData.task.title}
WHAT IT IS ABOUT: ${portalData.task.description}
WHY IT IS REQUIRED: ${portalData.task.whyRequired}
EXACT TECHNICAL REQUIREMENTS:
${portalData.task.exactRequirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}
EXPECTED OUTPUT: ${portalData.task.expectedOutput}
RECOMMENDED IMPLEMENTATION STEPS:
${portalData.task.implementationSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
ACCEPTANCE CRITERIA:
${portalData.task.acceptanceCriteria
  .map((ac) => `- ${ac.id} (${ac.title}): ${ac.description}`)
  .join('\n')}
EXACT SUBMISSION DEADLINE: ${portalData.task.formattedDeadline}

${reviewContextBlock}

VOICE CONVERSATION GUIDELINES:
- Speak warmly, clearly, and concisely in natural conversational English.
- During initial task explanation, welcome ${portalData.employee.fullName.split(' ')[0]} and cover what the task is about, why it is required, the exact requirements, expected output, implementation steps, acceptance criteria, and the submission deadline, then invite their questions.
- During a review session, clearly explain the review outcome, each detected error, affected file, why the error matters, step-by-step corrections, which criteria are verified complete, and which remain incomplete.
- Answer every question accurately based on the task and review evidence above. Never fabricate test passes or claim unverified features work.`;

      let modelTranscriptBuffer = '';
      let userTranscriptBuffer = '';

      const sessionPromise = ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: 'session_ready',
                  sessionType: isReviewSession
                    ? 'review_error_explanation'
                    : 'initial_task_explanation',
                })
              );
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;

            const parts = message.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ type: 'audio', audio: part.inlineData.data }));
              }
            }

            const outTrans = (
              message.serverContent as { outputTranscription?: { text?: string } } | undefined
            )?.outputTranscription?.text;
            if (outTrans) {
              modelTranscriptBuffer += outTrans;
              clientWs.send(
                JSON.stringify({
                  type: 'transcript',
                  speaker: 'ai_bot',
                  text: outTrans,
                })
              );
            }

            const inTrans = (
              message.serverContent as { inputTranscription?: { text?: string } } | undefined
            )?.inputTranscription?.text;
            if (inTrans) {
              userTranscriptBuffer += inTrans;
              clientWs.send(
                JSON.stringify({
                  type: 'transcript',
                  speaker: 'employee',
                  text: inTrans,
                })
              );
            }

            if (message.serverContent?.turnComplete) {
              if (userTranscriptBuffer.trim()) {
                questionsAskedCount++;
                transcriptTurns.push({
                  speaker: 'employee',
                  text: userTranscriptBuffer.trim(),
                  timestamp: new Date().toISOString(),
                });
                userTranscriptBuffer = '';
              }
              if (modelTranscriptBuffer.trim()) {
                transcriptTurns.push({
                  speaker: 'ai_bot',
                  text: modelTranscriptBuffer.trim(),
                  timestamp: new Date().toISOString(),
                });
                modelTranscriptBuffer = '';
              }
              clientWs.send(JSON.stringify({ type: 'turn_complete' }));
            }

            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }
          },
          onerror: (err) => {
            console.error('Gemini Live session error:', err);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: 'error',
                  error: 'Live voice connection encountered an error.',
                })
              );
            }
          },
          onclose: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          },
        },
      });

      // Kick off automatic initial greeting & explanation immediately upon connection
      sessionPromise
        .then((session) => {
          const kickoffPrompt = isReviewSession
            ? `Greet ${portalData.employee.fullName.split(' ')[0]} and explain the Revision #${
                portalData.latestReview?.revisionNumber ?? 1
              } GitHub code review outcome in natural speech: cover verified completed criteria, each detected error with its file and reason, how to fix each issue before resubmitting, and invite any questions.`
            : `Welcome ${
                portalData.employee.fullName.split(' ')[0]
              } warmly and explain their assigned task "${
                portalData.task.title
              }" in clear spoken prose: cover what it is about, why it is required, exact requirements, expected output, recommended implementation steps, acceptance criteria, and the deadline (${
                portalData.task.formattedDeadline
              }), then ask if they have any questions.`;

          session.sendRealtimeInput({ text: kickoffPrompt });
        })
        .catch((err) => {
          console.error('Failed to initialize Gemini Live session:', err);
        });

      clientWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            audio?: string;
            text?: string;
          };
          sessionPromise
            .then((session) => {
              if (msg.audio) {
                session.sendRealtimeInput({
                  audio: {
                    data: msg.audio,
                    mimeType: 'audio/pcm;rate=16000',
                  },
                });
              } else if (msg.text && msg.text.trim()) {
                questionsAskedCount++;
                transcriptTurns.push({
                  speaker: 'employee',
                  text: msg.text.trim(),
                  timestamp: new Date().toISOString(),
                });
                session.sendRealtimeInput({ text: msg.text.trim() });
              }
            })
            .catch(() => {});
        } catch {
          // Ignore malformed WS frame
        }
      });

      clientWs.on('close', () => {
        sessionPromise
          .then((session) => {
            session.close();
          })
          .catch(() => {});

        if (sessionRow?.id) {
          void db
            .update(voiceSessions)
            .set({
              transcriptTurns,
              questionsAskedCount,
              status: 'completed',
              completedAt: new Date(),
            })
            .where(eq(voiceSessions.id, sessionRow.id))
            .catch(() => {});
        }
      });
    } catch (err) {
      console.error('Voice WS setup failed:', err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    }
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const reqUrl = request.url || '';
    if (reqUrl.startsWith('/ws/events')) {
      eventsWss.handleUpgrade(request, socket, head, (ws) => {
        eventsWss.emit('connection', ws, request);
      });
    } else if (reqUrl.startsWith('/ws/employee-voice')) {
      voiceWss.handleUpgrade(request, socket, head, (ws) => {
        voiceWss.emit('connection', ws, reqUrl);
      });
    }
    // Leave other upgrade paths (if any) untouched
  });
}
