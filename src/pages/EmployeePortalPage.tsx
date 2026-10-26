import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  GitBranch,
  Mic,
  MicOff,
  Play,
  Send,
  Square,
  Volume2,
  RefreshCw,
} from 'lucide-react';
import { portalFetch } from '../services/apiClient.ts';
import type {
  EmployeePortalBootstrap,
  TaskWorkflowStatus,
  VoiceTranscriptTurn,
} from '../types/platform.ts';

interface EmployeePortalPageProps {
  portalToken: string;
  canReturnToManager?: boolean;
  onReturnToManager?: () => void;
}

function formatStatusLabel(status: TaskWorkflowStatus): string {
  switch (status) {
    case 'assigned':
      return 'Assigned · Awaiting Initial Voice Briefing';
    case 'voice_briefing_completed':
      return 'Briefing Completed · Ready for GitHub Submission';
    case 'in_progress':
      return 'In Progress';
    case 'review_queued':
      return 'GitHub Review Running';
    case 'changes_requested':
      return 'Changes Requested · Resubmission Needed';
    case 'unable_to_verify':
      return 'Unable to Verify Repository';
    case 'completed':
      return 'Verified Complete';
    default:
      return status;
  }
}

function float32ToPcm16Base64(float32: Float32Array): string {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export const EmployeePortalPage: React.FC<EmployeePortalPageProps> = ({
  portalToken,
  canReturnToManager = false,
  onReturnToManager,
}) => {
  const [data, setData] = useState<EmployeePortalBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Voice conversation & TTS state
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveConnecting, setLiveConnecting] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [liveTurns, setLiveTurns] = useState<VoiceTranscriptTurn[]>([]);

  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [questionInput, setQuestionInput] = useState('');
  const [askingQuestion, setAskingQuestion] = useState(false);

  const [completingBriefing, setCompletingBriefing] = useState(false);
  const [briefingNotice, setBriefingNotice] = useState<string | null>(null);

  // GitHub submission state
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('main');
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [repoMessage, setRepoMessage] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);

  // Refs for Live Audio & WebSocket (strictly useRef inside audio callbacks per Gemini Live guidelines)
  const voiceWsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const micMutedRef = useRef<boolean>(false);
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const autoWelcomedRef = useRef<boolean>(false);
  const currentTaskIdRef = useRef<number | null>(null);

  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  const loadPortal = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    try {
      const res = await portalFetch<EmployeePortalBootstrap>(
        `/api/portal/${encodeURIComponent(portalToken)}`
      );
      setData(res);
      currentTaskIdRef.current = res.task.id;
      setLoadError(null);
      if (res.submissions[0]?.repositoryUrl && !repoUrl) {
        setRepoUrl(res.submissions[0].repositoryUrl);
        setRepoBranch(res.submissions[0].branch || 'main');
      }
    } catch (err: unknown) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load your employee task portal.'
      );
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [portalToken, repoUrl]);

  useEffect(() => {
    void loadPortal(false);
  }, [loadPortal]);

  // Subscribe to real-time WebSocket updates (/ws/events) so review completion updates immediately
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type?: string;
          payload?: { taskId?: number };
        };
        if (
          (msg.type === 'task:updated' || msg.type === 'review:completed') &&
          (!msg.payload?.taskId || msg.payload.taskId === currentTaskIdRef.current)
        ) {
          void loadPortal(true);
        }
      } catch {
        // Ignore malformed event
      }
    };
    return () => {
      ws.close();
    };
  }, [loadPortal]);

  // Automatic welcome transcript initialization on first portal load
  useEffect(() => {
    if (!data || autoWelcomedRef.current) return;
    autoWelcomedRef.current = true;
    const savedTurns = data.voiceSessions[0]?.transcriptTurns ?? [];
    if (savedTurns.length > 0) {
      setLiveTurns(savedTurns);
    } else {
      const initialGreeting = data.latestReview
        ? data.task.latestReviewVoiceScript || data.latestReview.spokenExplanationScript
        : data.task.voiceBriefingScript;
      setLiveTurns([
        {
          speaker: 'ai_bot',
          text: initialGreeting,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  }, [data]);

  const stopAllPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    if (htmlAudioRef.current) {
      htmlAudioRef.current.pause();
      htmlAudioRef.current.currentTime = 0;
      htmlAudioRef.current = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setTtsPlaying(false);
    setBotSpeaking(false);
  }, []);

  const stopLiveVoiceSession = useCallback(
    async (autoCompleteOnboarding = false) => {
      stopAllPlayback();

      if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current.onaudioprocess = null;
        scriptProcessorRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      if (inputAudioCtxRef.current) {
        void inputAudioCtxRef.current.close().catch(() => {});
        inputAudioCtxRef.current = null;
      }
      if (outputAudioCtxRef.current) {
        void outputAudioCtxRef.current.close().catch(() => {});
        outputAudioCtxRef.current = null;
      }
      if (voiceWsRef.current) {
        voiceWsRef.current.close();
        voiceWsRef.current = null;
      }

      setLiveConnected(false);
      setLiveConnecting(false);

      if (autoCompleteOnboarding && data?.task.status === 'assigned') {
        try {
          setCompletingBriefing(true);
          const res = await portalFetch<{
            ok: boolean;
            emailStatus: string;
            portal: EmployeePortalBootstrap;
          }>(`/api/portal/${encodeURIComponent(portalToken)}/complete-briefing`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (res.portal) setData(res.portal);
          setBriefingNotice(
            `Initial voice briefing completed. Follow-up specification and deadline summary email status: ${res.emailStatus}.`
          );
        } catch {
          // Non-fatal; user can also trigger manually
        } finally {
          setCompletingBriefing(false);
        }
      }
    },
    [data?.task.status, portalToken, stopAllPlayback]
  );

  useEffect(() => {
    return () => {
      void stopLiveVoiceSession(false);
    };
  }, [stopLiveVoiceSession]);

  const schedulePcm24kChunk = useCallback((base64Pcm: string) => {
    const outCtx = outputAudioCtxRef.current;
    if (!outCtx) return;

    const floatSamples = pcm16Base64ToFloat32(base64Pcm);
    if (floatSamples.length === 0) return;

    const audioBuffer = outCtx.createBuffer(1, floatSamples.length, 24000);
    audioBuffer.getChannelData(0).set(floatSamples);

    const source = outCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outCtx.destination);

    const now = outCtx.currentTime;
    if (nextStartTimeRef.current < now) {
      nextStartTimeRef.current = now + 0.02;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
    activeSourcesRef.current.add(source);
    setBotSpeaking(true);

    source.onended = () => {
      activeSourcesRef.current.delete(source);
      if (activeSourcesRef.current.size === 0) {
        setBotSpeaking(false);
      }
    };
  }, []);

  const startLiveVoiceSession = async (mode: 'onboarding' | 'review') => {
    setVoiceError(null);
    stopAllPlayback();
    setLiveConnecting(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = 0;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/employee-voice?token=${encodeURIComponent(
        portalToken
      )}&mode=${mode}`;
      const ws = new WebSocket(wsUrl);
      voiceWsRef.current = ws;

      let streamingBotText = '';
      let streamingEmpText = '';

      ws.onopen = () => {
        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        scriptProcessorRef.current = processor;

        processor.onaudioprocess = (event) => {
          if (micMutedRef.current) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          const channelData = event.inputBuffer.getChannelData(0);
          const base64Audio = float32ToPcm16Base64(channelData);
          ws.send(JSON.stringify({ audio: base64Audio }));
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            audio?: string;
            speaker?: 'employee' | 'ai_bot';
            text?: string;
            error?: string;
          };

          if (msg.type === 'session_ready') {
            setLiveConnecting(false);
            setLiveConnected(true);
          } else if (msg.type === 'audio' && msg.audio) {
            schedulePcm24kChunk(msg.audio);
          } else if (msg.type === 'interrupted') {
            for (const src of activeSourcesRef.current) {
              try {
                src.stop();
              } catch {
                // Ignore
              }
            }
            activeSourcesRef.current.clear();
            nextStartTimeRef.current = 0;
            setBotSpeaking(false);
          } else if (msg.type === 'transcript' && msg.text && msg.speaker) {
            if (msg.speaker === 'ai_bot') {
              streamingBotText += msg.text;
            } else {
              streamingEmpText += msg.text;
            }
          } else if (msg.type === 'turn_complete') {
            const additions: VoiceTranscriptTurn[] = [];
            if (streamingEmpText.trim()) {
              additions.push({
                speaker: 'employee',
                text: streamingEmpText.trim(),
                timestamp: new Date().toISOString(),
              });
              streamingEmpText = '';
            }
            if (streamingBotText.trim()) {
              additions.push({
                speaker: 'ai_bot',
                text: streamingBotText.trim(),
                timestamp: new Date().toISOString(),
              });
              streamingBotText = '';
            }
            if (additions.length > 0) {
              setLiveTurns((prev) => [...prev, ...additions]);
            }
          } else if (msg.type === 'error') {
            setVoiceError(msg.error || 'Live voice connection encountered an error.');
            void stopLiveVoiceSession(false);
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onerror = () => {
        setVoiceError(
          'Real-time microphone stream disconnected. You can also play the spoken briefing or ask questions below.'
        );
        void stopLiveVoiceSession(false);
      };

      ws.onclose = () => {
        setLiveConnected(false);
        setLiveConnecting(false);
      };
    } catch (err: unknown) {
      setLiveConnecting(false);
      setVoiceError(
        err instanceof Error
          ? `${err.message}. Use "Play Spoken Briefing" or ask questions below if microphone access is restricted.`
          : 'Microphone permission denied. Use "Play Spoken Briefing" below.'
      );
    }
  };

  const playWavOrFallbackSpeech = useCallback(
    async (audioWavBase64: string | null, fallbackText: string) => {
      stopAllPlayback();
      if (audioWavBase64) {
        const audio = new Audio(`data:audio/wav;base64,${audioWavBase64}`);
        htmlAudioRef.current = audio;
        setTtsPlaying(true);
        setBotSpeaking(true);
        audio.onended = () => {
          setTtsPlaying(false);
          setBotSpeaking(false);
          htmlAudioRef.current = null;
        };
        audio.onerror = () => {
          setTtsPlaying(false);
          setBotSpeaking(false);
          htmlAudioRef.current = null;
        };
        await audio.play();
        return;
      }

      if ('speechSynthesis' in window && fallbackText) {
        const utterance = new SpeechSynthesisUtterance(fallbackText);
        utterance.rate = 1.0;
        setTtsPlaying(true);
        setBotSpeaking(true);
        utterance.onend = () => {
          setTtsPlaying(false);
          setBotSpeaking(false);
        };
        window.speechSynthesis.speak(utterance);
      }
    },
    [stopAllPlayback]
  );

  const handlePlaySpokenBriefing = async (mode: 'onboarding' | 'review') => {
    setVoiceError(null);
    setTtsLoading(true);
    try {
      const res = await portalFetch<{
        spokenText: string;
        audioWavBase64: string | null;
      }>(`/api/portal/${encodeURIComponent(portalToken)}/tts`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });

      setLiveTurns((prev) => {
        const alreadyLast =
          prev.length > 0 && prev[prev.length - 1].text === res.spokenText;
        if (alreadyLast) return prev;
        return [
          ...prev,
          {
            speaker: 'ai_bot',
            text: res.spokenText,
            timestamp: new Date().toISOString(),
          },
        ];
      });

      await playWavOrFallbackSpeech(res.audioWavBase64, res.spokenText);
    } catch (err: unknown) {
      setVoiceError(
        err instanceof Error ? err.message : 'Unable to synthesize spoken briefing.'
      );
    } finally {
      setTtsLoading(false);
    }
  };

  const handleAskQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = questionInput.trim();
    if (!trimmed) return;
    setQuestionInput('');
    setVoiceError(null);

    // If Live WebSocket is active, send directly into the live conversational stream
    if (liveConnected && voiceWsRef.current?.readyState === WebSocket.OPEN) {
      setLiveTurns((prev) => [
        ...prev,
        { speaker: 'employee', text: trimmed, timestamp: new Date().toISOString() },
      ]);
      voiceWsRef.current.send(JSON.stringify({ text: trimmed }));
      return;
    }

    setAskingQuestion(true);
    setLiveTurns((prev) => [
      ...prev,
      { speaker: 'employee', text: trimmed, timestamp: new Date().toISOString() },
    ]);

    try {
      const res = await portalFetch<{
        answerText: string;
        audioWavBase64: string | null;
      }>(`/api/portal/${encodeURIComponent(portalToken)}/ask-voice`, {
        method: 'POST',
        body: JSON.stringify({ question: trimmed }),
      });

      setLiveTurns((prev) => [
        ...prev,
        {
          speaker: 'ai_bot',
          text: res.answerText,
          timestamp: new Date().toISOString(),
        },
      ]);

      await playWavOrFallbackSpeech(res.audioWavBase64, res.answerText);
    } catch (err: unknown) {
      setVoiceError(err instanceof Error ? err.message : 'Failed to answer question.');
    } finally {
      setAskingQuestion(false);
    }
  };

  const handleCompleteBriefingAndSendSpecEmail = async () => {
    setCompletingBriefing(true);
    setBriefingNotice(null);
    setVoiceError(null);
    try {
      const res = await portalFetch<{
        ok: boolean;
        emailStatus: string;
        portal: EmployeePortalBootstrap;
      }>(`/api/portal/${encodeURIComponent(portalToken)}/complete-briefing`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.portal) {
        setData(res.portal);
      }
      setBriefingNotice(
        `Follow-up task specification, acceptance criteria, and deadline summary email processed (${res.emailStatus}). Stored deadline remains locked.`
      );
    } catch (err: unknown) {
      setVoiceError(
        err instanceof Error ? err.message : 'Could not complete briefing step.'
      );
    } finally {
      setCompletingBriefing(false);
    }
  };

  const handleSubmitRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingRepo(true);
    setRepoError(null);
    setRepoMessage(null);
    try {
      const res = await portalFetch<{ queuedJobId: number; revisionNumber: number }>(
        `/api/portal/${encodeURIComponent(portalToken)}/submit-repo`,
        {
          method: 'POST',
          body: JSON.stringify({
            repositoryUrl: repoUrl.trim(),
            branch: repoBranch.trim() || 'main',
          }),
        }
      );
      setRepoMessage(
        `Revision #${res.revisionNumber} queued for automated GitHub commit inspection and requirement verification. This page updates automatically when the review completes.`
      );
      await loadPortal(true);
    } catch (err: unknown) {
      setRepoError(err instanceof Error ? err.message : 'Repository submission failed.');
    } finally {
      setSubmittingRepo(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-8">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6 space-y-3">
          <div className="h-4 w-48 bg-slate-200 rounded" />
          <div className="h-3 w-full bg-slate-100 rounded" />
          <div className="h-3 w-3/4 bg-slate-100 rounded" />
        </div>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-8">
        <div className="max-w-lg w-full bg-white border border-slate-200 rounded-lg p-8 space-y-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Employee Task Portal Unavailable
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            {loadError || 'Invalid or expired task portal token.'}
          </p>
          {canReturnToManager && onReturnToManager && (
            <button
              type="button"
              onClick={onReturnToManager}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Manager Dashboard</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const { employee, task, latestReview, submissions, emailsSent } = data;
  const hasReview = Boolean(latestReview);
  const activeMeetLink = task.reviewMeetLink || task.onboardingMeetLink;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-8 py-4 bg-white border-b border-slate-200">
        <a
          href={`/?portal=${encodeURIComponent(portalToken)}`}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          Employee AI Task Portal
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a
            href="#voice-studio"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Voice Briefing
          </a>
          <a
            href="#task-specification"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Task Specification
          </a>
          <a
            href="#github-submission"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Submit Repository
          </a>
          <a
            href="#review-findings"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Review Findings
          </a>
        </nav>

        <div className="shrink-0">
          <a
            href="#github-submission"
            className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            {task.status === 'completed' ? 'Task Completed' : 'Submit GitHub URL'}
          </a>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 sm:px-8 py-8 space-y-8">
        {/* Optional return link in workspace toolbar when previewed by manager */}
        {canReturnToManager && onReturnToManager && (
          <div className="flex items-center justify-between gap-4 pb-2 border-b border-slate-200 text-xs text-slate-600">
            <span>
              Viewing personalized Employee AI Bot Portal for{' '}
              <strong className="font-semibold text-slate-900">{employee.fullName}</strong>
            </span>
            <button
              type="button"
              onClick={onReturnToManager}
              className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-slate-900 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Return to Manager Dashboard</span>
            </button>
          </div>
        )}

        {/* Employee & Task Header Summary (Zero Static Pills — Unboxed Metadata with Separators) */}
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
            <span className="font-mono font-medium text-slate-700">{task.taskCode}</span>
            <span aria-hidden="true">·</span>
            <span>{employee.fullName}</span>
            <span aria-hidden="true">·</span>
            <span>{employee.technicalDomain}</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                task.status === 'completed'
                  ? 'font-semibold text-emerald-700'
                  : task.status === 'changes_requested' || task.status === 'unable_to_verify'
                  ? 'font-semibold text-amber-700'
                  : 'font-medium text-slate-800'
              }
            >
              {formatStatusLabel(task.status)}
            </span>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div className="space-y-2 max-w-3xl">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 text-balance">
                {task.title}
              </h1>
              <p className="text-sm text-slate-600 leading-relaxed">{task.description}</p>
            </div>

            <div className="shrink-0 space-y-1.5 text-left lg:text-right">
              <p className="text-xs text-slate-500">Submission Deadline</p>
              <p className="text-sm font-mono font-semibold text-slate-900 tabular-nums">
                {task.formattedDeadline}
              </p>
              <p className="text-xs text-slate-500 tabular-nums">
                Current Revision: #{task.currentRevisionNumber}
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
            <div>
              {activeMeetLink ? (
                <span>
                  Scheduled Google Meet Session:{' '}
                  <a
                    href={activeMeetLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono font-medium text-slate-900 underline hover:text-slate-700 inline-flex items-center gap-1"
                  >
                    <span>{activeMeetLink}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </span>
              ) : (
                <span>
                  Meeting Room: Embedded AI Voice Session below (Google Calendar Meet links are attached automatically when manager Workspace Calendar is connected).
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void loadPortal(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh Status</span>
            </button>
          </div>
        </section>

        {/* SECTION 1: INTERACTIVE AI VOICE BOT STUDIO */}
        <section
          id="voice-studio"
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-6"
        >
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-4 border-b border-slate-100">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                {liveConnected && (
                  <span
                    className="w-2 h-2 rounded-full bg-emerald-600"
                    title="Live WebSocket audio stream connected"
                  />
                )}
                <h2 className="text-base font-semibold text-slate-900">
                  Interactive AI Voice Briefing & Review Assistant
                </h2>
              </div>
              <p className="text-xs text-slate-500">
                {hasReview
                  ? `Revision #${latestReview!.revisionNumber} has been reviewed. Start a live voice session or play the spoken walkthrough to hear every finding and fix.`
                  : 'Listen to your personalized spoken task explanation, talk live with the AI assistant over your microphone, and ask any clarifying questions.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              {!liveConnected ? (
                <button
                  type="button"
                  onClick={() =>
                    void startLiveVoiceSession(hasReview ? 'review' : 'onboarding')
                  }
                  disabled={liveConnecting}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
                >
                  <Mic className="w-3.5 h-3.5" />
                  <span>
                    {liveConnecting
                      ? 'Connecting Microphone...'
                      : hasReview
                      ? 'Start Live Review Voice Call'
                      : 'Start Live Voice Conversation'}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setMicMuted((m) => !m)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
                  >
                    {micMuted ? (
                      <>
                        <MicOff className="w-3.5 h-3.5 text-red-600" />
                        <span>Unmute Mic</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-3.5 h-3.5 text-emerald-700" />
                        <span>Mic Live</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopLiveVoiceSession(!hasReview)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-md hover:bg-red-700 whitespace-nowrap shrink-0"
                  >
                    <Square className="w-3.5 h-3.5" />
                    <span>End Call & Send Summary</span>
                  </button>
                </>
              )}

              {!ttsPlaying ? (
                <button
                  type="button"
                  onClick={() =>
                    void handlePlaySpokenBriefing(hasReview ? 'review' : 'onboarding')
                  }
                  disabled={ttsLoading || liveConnected}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>
                    {ttsLoading
                      ? 'Generating Audio...'
                      : hasReview
                      ? 'Play Spoken Error Walkthrough'
                      : 'Play Spoken Task Briefing'}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopAllPlayback}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Stop Audio</span>
                </button>
              )}
            </div>
          </div>

          {botSpeaking && (
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <Volume2 className="w-4 h-4 text-slate-900" />
              <span>AI Engineering Assistant is speaking... (Speak or click Stop Audio anytime to interrupt)</span>
            </div>
          )}

          {voiceError && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
              {voiceError}
            </div>
          )}

          {briefingNotice && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-900">
              {briefingNotice}
            </div>
          )}

          {/* Conversation Transcript */}
          <div className="space-y-3 max-h-80 overflow-y-auto pr-1 divide-y divide-slate-100">
            {liveTurns.map((turn, idx) => (
              <div key={idx} className="pt-3 first:pt-0 space-y-1">
                <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
                  <span className="font-semibold text-slate-800">
                    {turn.speaker === 'ai_bot' ? 'AI Voice Bot' : employee.fullName}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">
                    {new Date(turn.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed">{turn.text}</p>
              </div>
            ))}
          </div>

          {/* Ask Clarifying Question Input + Post-Briefing Follow-Up Email Trigger */}
          <div className="pt-4 border-t border-slate-100 flex flex-col lg:flex-row lg:items-center gap-3">
            <form onSubmit={handleAskQuestion} className="flex-1 flex items-center gap-2">
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                placeholder="Ask a question about requirements, implementation steps, acceptance criteria, or review fixes..."
                className="flex-1 px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
              <button
                type="submit"
                disabled={askingQuestion || !questionInput.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{askingQuestion ? 'Answering...' : 'Ask & Speak Answer'}</span>
              </button>
            </form>

            <button
              type="button"
              onClick={handleCompleteBriefingAndSendSpecEmail}
              disabled={completingBriefing}
              className="px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              {completingBriefing
                ? 'Sending Summary...'
                : task.briefingCompletedAt
                ? 'Resend Full Spec Email'
                : 'Complete Briefing & Email Spec'}
            </button>
          </div>
        </section>

        {/* SECTION 2: TASK SPECIFICATION, STEPS & ACCEPTANCE CRITERIA */}
        <section
          id="task-specification"
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-8"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Why This Task Is Required
                </h2>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  {task.whyRequired}
                </p>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Exact Technical Requirements
                </h3>
                <ol className="mt-2 space-y-2 text-sm text-slate-700 list-decimal list-inside">
                  {task.exactRequirements.map((req, idx) => (
                    <li key={idx} className="leading-relaxed">
                      {req}
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Expected Output</h2>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  {task.expectedOutput}
                </p>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Recommended Implementation Steps
                </h3>
                <ol className="mt-2 space-y-2 text-sm text-slate-700 list-decimal list-inside">
                  {task.implementationSteps.map((step, idx) => (
                    <li key={idx} className="leading-relaxed">
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-slate-100 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-base font-semibold text-slate-900">
                Verification & Acceptance Criteria
              </h3>
              <span className="text-xs text-slate-500 tabular-nums">
                {task.acceptanceCriteria.length} Required Checkpoints
              </span>
            </div>

            <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
              {task.acceptanceCriteria.map((ac) => {
                const verResult = latestReview?.criterionResults.find(
                  (c) => c.criterionId === ac.id
                );
                return (
                  <div
                    key={ac.id}
                    className="py-3.5 flex flex-col md:flex-row md:items-start md:justify-between gap-3"
                  >
                    <div className="space-y-1 max-w-3xl">
                      <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
                        <span className="font-mono font-semibold text-slate-800">
                          {ac.id}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-slate-900 text-sm">
                          {ac.title}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{ac.required ? 'Required' : 'Optional'}</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        {ac.description}
                      </p>
                      {verResult && (
                        <p className="text-xs text-slate-700 pt-0.5">
                          <span className="font-medium">Review Finding:</span>{' '}
                          {verResult.explanation}
                          {verResult.evidenceFiles.length > 0 && (
                            <span className="font-mono text-slate-500">
                              {' '}
                              (Evidence: {verResult.evidenceFiles.join(', ')})
                            </span>
                          )}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0 text-xs font-medium tabular-nums">
                      {!verResult ? (
                        <span className="text-slate-500">Pending GitHub Submission</span>
                      ) : verResult.status === 'verified_complete' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Verified Complete</span>
                        </span>
                      ) : verResult.status === 'unable_to_verify' ? (
                        <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Unable to Verify</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Incomplete</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* SECTION 3: GITHUB REPOSITORY SUBMISSION */}
        <section
          id="github-submission"
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-4"
        >
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">
              {task.currentRevisionNumber === 0
                ? 'Submit Your Public GitHub Repository'
                : `Submit Updated GitHub Revision (Next: Revision #${
                    task.currentRevisionNumber + 1
                  })`}
            </h2>
            <p className="text-xs text-slate-500">
              Ensure your repository is public, commits are pushed to your target branch, zero secrets are hardcoded, and README.md plus automated tests are included. Submitting automatically starts the AI code review and sends a detailed feedback report.
            </p>
          </div>

          <form
            onSubmit={handleSubmitRepository}
            className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end"
          >
            <div className="md:col-span-7">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Public GitHub Repository URL
              </label>
              <input
                type="url"
                required
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repository-name"
                className="w-full px-3.5 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Branch
              </label>
              <input
                type="text"
                value={repoBranch}
                onChange={(e) => setRepoBranch(e.target.value)}
                placeholder="main"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={submittingRepo || task.status === 'review_queued'}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60 h-[38px]"
              >
                <GitBranch className="w-3.5 h-3.5" />
                <span>
                  {submittingRepo || task.status === 'review_queued'
                    ? 'Reviewing...'
                    : task.currentRevisionNumber > 0
                    ? 'Resubmit Repo'
                    : 'Submit Repo'}
                </span>
              </button>
            </div>
          </form>

          {repoMessage && (
            <p className="text-xs font-medium text-emerald-700">{repoMessage}</p>
          )}
          {repoError && <p className="text-xs font-medium text-red-600">{repoError}</p>}
        </section>

        {/* SECTION 4: MULTI-REVISION REVIEW FINDINGS & STEP-BY-STEP FIXES */}
        <section
          id="review-findings"
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Automated GitHub Review Findings & Revision History
              </h2>
              <p className="text-xs text-slate-500">
                Every commit revision is evaluated against the original requirements and compared against prior submissions.
              </p>
            </div>
            {latestReview && (
              <button
                type="button"
                onClick={() => void handlePlaySpokenBriefing('review')}
                disabled={ttsLoading}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-slate-100 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
              >
                <Volume2 className="w-3.5 h-3.5" />
                <span>Explain Latest Findings by Voice</span>
              </button>
            )}
          </div>

          {!latestReview ? (
            <div className="py-8 text-center space-y-2">
              <p className="text-sm font-medium text-slate-800">
                No GitHub revisions submitted yet.
              </p>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Once you submit your public GitHub URL above, the system will inspect your latest commit, verify each acceptance criterion, and walk you through any fixes by voice.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Latest Review Summary */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 tabular-nums">
                  <span className="font-mono font-semibold text-slate-900">
                    Revision #{latestReview.revisionNumber}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={
                      latestReview.overallVerdict === 'completed'
                        ? 'font-semibold text-emerald-700'
                        : latestReview.overallVerdict === 'unable_to_verify'
                        ? 'font-semibold text-amber-700'
                        : 'font-semibold text-red-700'
                    }
                  >
                    Verdict:{' '}
                    {latestReview.overallVerdict === 'completed'
                      ? 'Completed (All Required Criteria Verified)'
                      : latestReview.overallVerdict === 'unable_to_verify'
                      ? 'Unable to Verify'
                      : 'Changes Requested'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">
                    Criteria Score: {latestReview.scorePercent}%
                  </span>
                  {submissions[0] && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        Commit {submissions[0].commitSha.slice(0, 8)} ({submissions[0].branch})
                      </span>
                    </>
                  )}
                </div>
                <p className="text-sm text-slate-800 leading-relaxed">
                  {latestReview.summary}
                </p>
                {submissions[0]?.limitationsNote && (
                  <p className="text-xs text-slate-500">
                    Verification Scope Note: {submissions[0].limitationsNote}
                  </p>
                )}
              </div>

              {/* Delta Comparison for Revision >= 2 */}
              {(latestReview.fixedIssuesFromPrevious.length > 0 ||
                (latestReview.revisionNumber > 1 &&
                  latestReview.remainingIssues.length > 0)) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                  <div>
                    <h3 className="text-xs font-semibold text-emerald-800">
                      Resolved Since Previous Revision (
                      {latestReview.fixedIssuesFromPrevious.length})
                    </h3>
                    {latestReview.fixedIssuesFromPrevious.length === 0 ? (
                      <p className="text-xs text-slate-500 mt-1">
                        No prior issues marked resolved yet.
                      </p>
                    ) : (
                      <ul className="mt-1.5 space-y-1 text-xs text-slate-700 list-disc list-inside">
                        {latestReview.fixedIssuesFromPrevious.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-amber-800">
                      Remaining Unresolved Items ({latestReview.remainingIssues.length})
                    </h3>
                    <ul className="mt-1.5 space-y-1 text-xs text-slate-700 list-disc list-inside">
                      {latestReview.remainingIssues.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Actionable File-Level Error Findings */}
              <div className="pt-4 border-t border-slate-100 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 tabular-nums">
                  Detected Code Issues & Step-by-Step Corrections (
                  {latestReview.detectedIssues.length})
                </h3>

                {latestReview.detectedIssues.length === 0 ? (
                  <p className="text-xs text-emerald-700 font-medium">
                    Zero blocking code or security issues detected in this revision.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
                    {latestReview.detectedIssues.map((iss) => (
                      <div key={iss.id} className="py-4 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                          <span
                            className={
                              iss.severity === 'critical' || iss.severity === 'high'
                                ? 'font-semibold text-red-700'
                                : 'font-semibold text-amber-700'
                            }
                          >
                            Severity: {iss.severity}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-800">
                            {iss.affectedFile}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{iss.codeSection}</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900">{iss.title}</p>
                        <p className="text-xs text-slate-600">
                          <strong className="font-medium text-slate-800">
                            Why it matters:
                          </strong>{' '}
                          {iss.whyItMatters}
                        </p>
                        <p className="text-xs text-slate-700">
                          <strong className="font-medium text-slate-900">
                            How to fix:
                          </strong>{' '}
                          {iss.howToFix}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Prior Revisions Log */}
              {submissions.length > 1 && (
                <div className="pt-4 border-t border-slate-100 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-700">
                    All Submitted Revisions ({submissions.length})
                  </h3>
                  <div className="divide-y divide-slate-100">
                    {submissions.map((sub) => (
                      <div
                        key={sub.id}
                        className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 tabular-nums"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-medium text-slate-900">
                            Rev #{sub.revisionNumber}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{sub.commitSha.slice(0, 8)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{sub.inspectedFiles.length} files inspected</span>
                        </div>
                        <div>
                          <span>
                            {sub.review?.overallVerdict || sub.testExecutionStatus} (
                            {sub.review?.scorePercent ?? 0}%)
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Automated Emails Sent to Employee */}
          {emailsSent.length > 0 && (
            <div className="pt-4 border-t border-slate-100 space-y-2">
              <h3 className="text-xs font-semibold text-slate-700 tabular-nums">
                Automated Notifications Dispatched ({emailsSent.length})
              </h3>
              <div className="divide-y divide-slate-100 text-xs text-slate-600">
                {emailsSent.map((em) => (
                  <div
                    key={em.id}
                    className="py-2 flex flex-wrap items-center justify-between gap-2 tabular-nums"
                  >
                    <span className="truncate max-w-xl text-slate-800">{em.subject}</span>
                    <span className="font-mono text-slate-500">
                      {em.deliveryStatus} ·{' '}
                      {new Date(em.createdAt).toLocaleString([], {
                        month: 'short',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};
