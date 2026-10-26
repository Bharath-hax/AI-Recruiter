import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderGit2,
  Layers,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { apiDownloadBlob, apiFetch } from '../services/apiClient.ts';
import type {
  AcceptanceCriterionSpec,
  DomainTaskConfigRecord,
  EmailDeliveryRecord,
  EmployeeTaskEnriched,
  ImportRowIssue,
  ManagerDashboardBootstrap,
  TaskWorkflowStatus,
} from '../types/platform.ts';

type ManagerSection = 'import' | 'tasks' | 'domains' | 'operations';

interface ParsedImportPreview {
  validRows: Array<{
    rowNumber: number;
    fullName: string;
    email: string;
    phone: string;
    technicalDomain: string;
    domainKey: string;
  }>;
  rowErrors: ImportRowIssue[];
  totalRows: number;
  duplicateCount: number;
  invalidCount: number;
  domainsDetected: string[];
}

interface PendingBatchConfirmation {
  fileName: string;
  base64Data: string;
  preview: ParsedImportPreview;
}

interface QuickRosterRow {
  fullName: string;
  email: string;
  phone: string;
  technicalDomain: string;
}

interface ManagerDashboardPageProps {
  workspaceConnected: boolean;
  onReconnectWorkspace: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onOpenEmployeePortal: (portalToken: string) => void;
}

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function formatTaskStatus(status: TaskWorkflowStatus): string {
  switch (status) {
    case 'assigned':
      return 'Assigned';
    case 'voice_briefing_completed':
      return 'Briefing Completed';
    case 'in_progress':
      return 'In Progress';
    case 'review_queued':
      return 'Review Running';
    case 'changes_requested':
      return 'Changes Requested';
    case 'unable_to_verify':
      return 'Unable to Verify';
    case 'completed':
      return 'Completed';
    default:
      return status;
  }
}

function escapeCsvCell(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ').trim();
  if (clean.includes(',') || clean.includes('"')) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  return clean;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export const ManagerDashboardPage: React.FC<ManagerDashboardPageProps> = ({
  workspaceConnected,
  onReconnectWorkspace,
  onSignOut,
  onOpenEmployeePortal,
}) => {
  const [activeSection, setActiveSection] = useState<ManagerSection>('import');
  const [bootstrap, setBootstrap] = useState<ManagerDashboardBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [wsLive, setWsLive] = useState(false);

  // Import state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingPreview, setUploadingPreview] = useState(false);
  const [committingImport, setCommittingImport] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<PendingBatchConfirmation | null>(null);
  const [quickRows, setQuickRows] = useState<QuickRosterRow[]>([
    { fullName: '', email: '', phone: '', technicalDomain: 'Backend Engineering' },
  ]);

  // Tasks filter & drawer state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  // Domain configurator state
  const [selectedDomainKey, setSelectedDomainKey] = useState<string>('');
  const [editingDomain, setEditingDomain] = useState<{
    domainKey: string;
    domainName: string;
    generationMode: 'ai_dynamic' | 'template';
    taskTitleTemplate: string;
    taskDescriptionTemplate: string;
    whyRequiredTemplate: string;
    requirementsText: string;
    expectedOutputTemplate: string;
    stepsText: string;
    criteria: AcceptanceCriterionSpec[];
    deadlineDays: number;
    timezone: string;
  } | null>(null);
  const [savingDomain, setSavingDomain] = useState(false);
  const [savingGlobalSettings, setSavingGlobalSettings] = useState(false);
  const [globalTz, setGlobalTz] = useState('UTC');
  const [globalDeadlineDays, setGlobalDeadlineDays] = useState(2);
  const [globalAutoGenerate, setGlobalAutoGenerate] = useState(true);

  // Email retry confirmation modal state
  const [emailToRetry, setEmailToRetry] = useState<EmailDeliveryRecord | null>(null);
  const [retryingEmail, setRetryingEmail] = useState(false);
  const [drainingJobs, setDrainingJobs] = useState(false);
  const [exportingZip, setExportingZip] = useState(false);

  const loadWorkspace = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiFetch<ManagerDashboardBootstrap>('/api/manager/bootstrap');
      setBootstrap(data);
      setGlobalTz(data.currentUser.timezone || 'UTC');
      setGlobalDeadlineDays(data.currentUser.defaultDeadlineDays || 2);
      setGlobalAutoGenerate(data.currentUser.autoGenerateTasks);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load manager workspace.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace(false);
  }, [loadWorkspace]);

  // Connect to /ws/events for real-time task, review, and email updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    ws.onopen = () => setWsLive(true);
    ws.onclose = () => setWsLive(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type?: string };
        if (
          msg.type === 'import:completed' ||
          msg.type === 'task:updated' ||
          msg.type === 'review:completed' ||
          msg.type === 'email:updated'
        ) {
          void loadWorkspace(true);
        }
      } catch {
        // Ignore malformed event
      }
    };
    return () => {
      ws.close();
    };
  }, [loadWorkspace]);

  const populateDomainEditor = useCallback((cfg: DomainTaskConfigRecord) => {
    setSelectedDomainKey(cfg.domainKey);
    setEditingDomain({
      domainKey: cfg.domainKey,
      domainName: cfg.domainName,
      generationMode: cfg.generationMode,
      taskTitleTemplate: cfg.taskTitleTemplate,
      taskDescriptionTemplate: cfg.taskDescriptionTemplate,
      whyRequiredTemplate: cfg.whyRequiredTemplate,
      requirementsText: cfg.requirementsTemplate.join('\n'),
      expectedOutputTemplate: cfg.expectedOutputTemplate,
      stepsText: cfg.implementationStepsTemplate.join('\n'),
      criteria:
        cfg.acceptanceCriteriaTemplate.length > 0
          ? cfg.acceptanceCriteriaTemplate
          : [
              {
                id: 'AC-1',
                title: 'Core Domain Implementation',
                description: 'Implements primary module cleanly.',
                required: true,
                verificationHint: 'Inspect repository source files.',
              },
            ],
      deadlineDays: cfg.deadlineDays,
      timezone: cfg.timezone,
    });
  }, []);

  useEffect(() => {
    if (bootstrap?.domainConfigs.length && !editingDomain) {
      populateDomainEditor(bootstrap.domainConfigs[0]);
    }
  }, [bootstrap?.domainConfigs, editingDomain, populateDomainEditor]);

  const previewAndStageSheet = async (fileName: string, base64Data: string) => {
    setUploadingPreview(true);
    setError(null);
    setBannerMessage(null);
    try {
      const res = await apiFetch<{ preview: ParsedImportPreview }>(
        '/api/manager/import/preview',
        {
          method: 'POST',
          body: JSON.stringify({ fileName, base64Data }),
        }
      );
      setPendingBatch({
        fileName,
        base64Data,
        preview: res.preview,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to parse spreadsheet.');
    } finally {
      setUploadingPreview(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const base64Data = arrayBufferToBase64(buf);
    await previewAndStageSheet(file.name, base64Data);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleQuickRosterStage = async (e: React.FormEvent) => {
    e.preventDefault();
    const nonBlank = quickRows.filter(
      (r) =>
        r.fullName.trim() || r.email.trim() || r.phone.trim() || r.technicalDomain.trim()
    );
    if (nonBlank.length === 0) {
      setError('Enter at least one employee row to validate and assign.');
      return;
    }
    const header = 'Employee Name,Email Address,Phone Number,Technical Domain';
    const lines = nonBlank.map((r) =>
      [
        escapeCsvCell(r.fullName),
        escapeCsvCell(r.email),
        escapeCsvCell(r.phone),
        escapeCsvCell(r.technicalDomain),
      ].join(',')
    );
    const csvContent = `${header}\n${lines.join('\n')}\n`;
    await previewAndStageSheet('inline_roster_import.csv', utf8ToBase64(csvContent));
  };

  const handleConfirmAutomatedImport = async () => {
    if (!pendingBatch) return;
    setCommittingImport(true);
    setError(null);
    try {
      const outcome = await apiFetch<{
        importedEmployeesCount: number;
        rowErrors: ImportRowIssue[];
      }>('/api/manager/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: pendingBatch.fileName,
          base64Data: pendingBatch.base64Data,
        }),
      });
      setPendingBatch(null);
      setQuickRows([
        { fullName: '', email: '', phone: '', technicalDomain: 'Backend Engineering' },
      ]);
      setBannerMessage(
        `Imported ${outcome.importedEmployeesCount} eligible employee(s). Domain task generation, unique AI Bot Portal links, Google Meet scheduling, and onboarding emails are running automatically.`
      );
      setActiveSection('tasks');
      await loadWorkspace(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Automated import failed.');
    } finally {
      setCommittingImport(false);
    }
  };

  const handleSaveGlobalSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGlobalSettings(true);
    setError(null);
    try {
      await apiFetch('/api/manager/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          timezone: globalTz,
          defaultDeadlineDays: globalDeadlineDays,
          autoGenerateTasks: globalAutoGenerate,
        }),
      });
      setBannerMessage('Saved global manager timezone and task-generation defaults.');
      await loadWorkspace(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save global settings.');
    } finally {
      setSavingGlobalSettings(false);
    }
  };

  const handleSaveDomainRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDomain) return;
    setSavingDomain(true);
    setError(null);
    try {
      const slug =
        editingDomain.domainKey.trim() ||
        editingDomain.domainName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '');

      await apiFetch(`/api/manager/domains/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: JSON.stringify({
          domainName: editingDomain.domainName,
          generationMode: editingDomain.generationMode,
          taskTitleTemplate: editingDomain.taskTitleTemplate,
          taskDescriptionTemplate: editingDomain.taskDescriptionTemplate,
          whyRequiredTemplate: editingDomain.whyRequiredTemplate,
          requirementsTemplate: editingDomain.requirementsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          expectedOutputTemplate: editingDomain.expectedOutputTemplate,
          implementationStepsTemplate: editingDomain.stepsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          acceptanceCriteriaTemplate: editingDomain.criteria,
          deadlineDays: editingDomain.deadlineDays,
          timezone: editingDomain.timezone,
          isActive: true,
        }),
      });
      setBannerMessage(`Saved domain task mapping for "${editingDomain.domainName}".`);
      await loadWorkspace(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save domain rule.');
    } finally {
      setSavingDomain(false);
    }
  };

  const handleConfirmRetryEmail = async () => {
    if (!emailToRetry) return;
    setRetryingEmail(true);
    setError(null);
    try {
      const res = await apiFetch<{ email: EmailDeliveryRecord }>(
        `/api/manager/emails/${emailToRetry.id}/retry`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      );
      setEmailToRetry(null);
      setBannerMessage(
        `Retried email to ${res.email.recipientEmail} (status: ${res.email.deliveryStatus}) without altering stored task deadline.`
      );
      await loadWorkspace(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Email retry failed.');
    } finally {
      setRetryingEmail(false);
    }
  };

  const handleDrainQueue = async () => {
    setDrainingJobs(true);
    try {
      await apiFetch('/api/manager/jobs/drain', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadWorkspace(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Queue execution failed.');
    } finally {
      setDrainingJobs(false);
    }
  };

  const handleExportZip = async () => {
    setExportingZip(true);
    try {
      await apiDownloadBlob(
        '/api/export/codebase.zip',
        'ai-task-voice-github-review-system.zip'
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Codebase export failed.');
    } finally {
      setExportingZip(false);
    }
  };

  const copyPortalUrl = async (portalUrl: string, token: string) => {
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      // Clipboard blocked fallback
    }
  };

  const uniqueDomains = useMemo(() => {
    if (!bootstrap) return [];
    const set = new Set<string>();
    for (const t of bootstrap.tasks) {
      set.add(t.technicalDomain);
    }
    return Array.from(set).sort();
  }, [bootstrap]);

  const filteredTasks = useMemo(() => {
    if (!bootstrap) return [];
    const q = searchQuery.trim().toLowerCase();
    return bootstrap.tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (domainFilter !== 'all' && t.technicalDomain !== domainFilter) return false;
      if (!q) return true;
      return (
        t.employee.fullName.toLowerCase().includes(q) ||
        t.employee.email.toLowerCase().includes(q) ||
        t.technicalDomain.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.taskCode.toLowerCase().includes(q)
      );
    });
  }, [bootstrap, domainFilter, searchQuery, statusFilter]);

  const selectedTask: EmployeeTaskEnriched | null = useMemo(() => {
    if (!bootstrap || !selectedTaskId) return null;
    return bootstrap.tasks.find((t) => t.id === selectedTaskId) ?? null;
  }, [bootstrap, selectedTaskId]);

  const sectionLabel: Record<ManagerSection, string> = {
    import: 'Employee Import & Automation',
    tasks: 'Assigned Tasks & GitHub Reviews',
    domains: 'Domain Rules & Deadlines',
    operations: 'Email Outbox, Jobs & Audit',
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Sidebar Navigation (256px) */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col justify-between shrink-0">
        <div className="p-5 space-y-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {wsLive && (
                <span
                  className="w-2 h-2 rounded-full bg-emerald-600"
                  title="Real-time WebSocket stream connected"
                />
              )}
              <span className="text-sm font-bold tracking-tight text-slate-900 whitespace-nowrap">
                AI Review Automation
              </span>
            </div>
            <p className="text-xs text-slate-500">Manager Control Plane</p>
          </div>

          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveSection('import')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeSection === 'import'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 shrink-0" />
              <span>Employee Import</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('tasks')}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeSection === 'tasks'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <FolderGit2 className="w-4 h-4 shrink-0" />
                <span>Tasks & Reviews</span>
              </span>
              <span className="font-mono tabular-nums text-[11px] opacity-80">
                {bootstrap?.tasks.length ?? 0}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('domains')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeSection === 'domains'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Settings className="w-4 h-4 shrink-0" />
              <span>Domain Rules</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('operations')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                activeSection === 'operations'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Layers className="w-4 h-4 shrink-0" />
              <span>Outbox & Queue</span>
            </button>
          </nav>
        </div>

        <div className="p-5 border-t border-slate-200 space-y-3">
          {bootstrap?.currentUser && (
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-slate-900 truncate">
                {bootstrap.currentUser.displayName || 'Manager'}
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                {bootstrap.currentUser.email}
              </p>
              <p className="text-[11px] text-slate-500">
                Workspace:{' '}
                <span
                  className={
                    workspaceConnected
                      ? 'font-medium text-emerald-700'
                      : 'font-medium text-amber-700'
                  }
                >
                  {workspaceConnected ? 'Authorized' : 'Token Expired'}
                </span>
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={onSignOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Contextual Top Bar (SaaS Dashboard Contract) */}
        <header className="flex items-center justify-between gap-6 px-8 py-4 bg-white border-b border-slate-200">
          <div className="flex items-center gap-2 text-sm text-slate-500 min-w-0">
            <span className="whitespace-nowrap">Manager Workspace</span>
            <span aria-hidden="true">/</span>
            <span className="font-semibold text-slate-900 truncate">
              {sectionLabel[activeSection]}
            </span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onReconnectWorkspace}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              {workspaceConnected ? 'Refresh Gmail & Meet Auth' : 'Connect Gmail & Meet'}
            </button>
            <button
              type="button"
              onClick={handleExportZip}
              disabled={exportingZip}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{exportingZip ? 'Exporting...' : 'Export Codebase (.zip)'}</span>
            </button>
          </div>
        </header>

        <main className="flex-1 px-8 py-7 max-w-7xl w-full mx-auto space-y-6">
          {/* Metric Strip (Tabular Numerals, Flat Single-Elevation Divider Grid) */}
          {bootstrap && (
            <div className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
              <div className="p-4 space-y-1">
                <p className="text-xs text-slate-500">Imported Employees</p>
                <p className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                  {bootstrap.employees.length}
                </p>
                <p className="text-[11px] text-slate-500 tabular-nums">
                  {uniqueDomains.length} active technical domain(s)
                </p>
              </div>
              <div className="p-4 space-y-1">
                <p className="text-xs text-slate-500">Auto-Assigned Tasks</p>
                <p className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                  {bootstrap.tasks.length}
                </p>
                <p className="text-[11px] text-slate-500 tabular-nums">
                  {
                    bootstrap.tasks.filter(
                      (t) => t.status === 'voice_briefing_completed'
                    ).length
                  }{' '}
                  briefings completed
                </p>
              </div>
              <div className="p-4 space-y-1">
                <p className="text-xs text-slate-500">GitHub Review Cycles</p>
                <p className="text-2xl font-bold font-mono tabular-nums text-slate-900">
                  {bootstrap.tasks.reduce(
                    (sum, t) => sum + t.currentRevisionNumber,
                    0
                  )}
                </p>
                <p className="text-[11px] text-slate-500 tabular-nums">
                  {
                    bootstrap.tasks.filter((t) => t.status === 'changes_requested')
                      .length
                  }{' '}
                  awaiting fixes
                </p>
              </div>
              <div className="p-4 space-y-1">
                <p className="text-xs text-slate-500">Verified Completions</p>
                <p className="text-2xl font-bold font-mono tabular-nums text-emerald-700">
                  {bootstrap.tasks.filter((t) => t.status === 'completed').length}
                </p>
                <p className="text-[11px] text-slate-500 tabular-nums">
                  {
                    bootstrap.emails.filter((e) => e.deliveryStatus === 'sent').length
                  }{' '}
                  confirmed emails sent
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3.5 bg-red-50 border border-red-200 rounded-md flex items-center justify-between gap-4 text-xs text-red-800">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-red-600 hover:text-red-900 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {bannerMessage && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-md flex items-center justify-between gap-4 text-xs text-emerald-900">
              <span>{bannerMessage}</span>
              <button
                type="button"
                onClick={() => setBannerMessage(null)}
                className="text-emerald-700 hover:text-emerald-950 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-lg p-8 space-y-3">
              <div className="h-4 w-56 bg-slate-200 rounded" />
              <div className="h-10 w-full bg-slate-100 rounded" />
              <div className="h-10 w-full bg-slate-100 rounded" />
            </div>
          ) : (
            <>
              {/* ================================================================
                  VIEW 1: 4-COLUMN EMPLOYEE IMPORT & AUTOMATED DISPATCH
                 ================================================================ */}
              {activeSection === 'import' && bootstrap && (
                <div className="space-y-6">
                  <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 pb-4 border-b border-slate-100">
                      <div className="space-y-1 max-w-2xl">
                        <h1 className="text-lg font-semibold text-slate-900">
                          Upload 4-Column Employee Excel (.xlsx) or CSV
                        </h1>
                        <p className="text-xs text-slate-600 leading-relaxed">
                          Required columns only:{' '}
                          <span className="font-mono text-slate-900">
                            Employee Name, Email Address, Phone Number, Technical Domain
                          </span>
                          . Resumes, education, and experience fields are never required. Importing automatically validates records, flags duplicate emails, assigns domain-matched tasks, creates unique Employee AI Bot links, schedules Google Meet sessions, and sends onboarding emails.
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            void apiDownloadBlob(
                              '/api/manager/templates/sample.xlsx',
                              'employee_4col_import_template.xlsx'
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Blank .xlsx Template</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void apiDownloadBlob(
                              '/api/manager/templates/sample.csv',
                              'employee_4col_import_template.csv'
                            )
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Blank .csv Template</span>
                        </button>
                      </div>
                    </div>

                    {/* File Upload Drop Target */}
                    <div className="border border-dashed border-slate-300 rounded-lg p-8 text-center space-y-3 bg-slate-50/60">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={handleFileChange}
                        className="hidden"
                      />
                      <Upload className="w-6 h-6 text-slate-500 mx-auto" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-slate-900">
                          Select an Excel (.xlsx) or CSV (.csv) employee roster
                        </p>
                        <p className="text-xs text-slate-500">
                          Columns: Employee Name · Email Address · Phone Number · Technical Domain
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingPreview}
                        className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60"
                      >
                        {uploadingPreview
                          ? 'Validating File...'
                          : 'Choose Excel / CSV File'}
                      </button>
                    </div>

                    {/* Inline 4-Column Quick Roster Entry (Generates exact 4-col CSV buffer) */}
                    <div className="pt-4 border-t border-slate-100 space-y-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <h2 className="text-sm font-semibold text-slate-900">
                            Or Enter 4-Column Employee Rows Directly
                          </h2>
                          <p className="text-xs text-slate-500">
                            Runs through the identical CSV validation, duplicate check, and automated assignment pipeline.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setQuickRows((rows) => [
                              ...rows,
                              {
                                fullName: '',
                                email: '',
                                phone: '',
                                technicalDomain: 'Frontend Engineering',
                              },
                            ])
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add Row</span>
                        </button>
                      </div>

                      <form onSubmit={handleQuickRosterStage} className="space-y-3">
                        {quickRows.map((row, index) => (
                          <div
                            key={index}
                            className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center"
                          >
                            <input
                              type="text"
                              placeholder="Employee Name"
                              value={row.fullName}
                              onChange={(e) =>
                                setQuickRows((prev) =>
                                  prev.map((r, i) =>
                                    i === index ? { ...r, fullName: e.target.value } : r
                                  )
                                )
                              }
                              className="md:col-span-3 px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                            <input
                              type="email"
                              placeholder="Email Address"
                              value={row.email}
                              onChange={(e) =>
                                setQuickRows((prev) =>
                                  prev.map((r, i) =>
                                    i === index ? { ...r, email: e.target.value } : r
                                  )
                                )
                              }
                              className="md:col-span-3 px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                            <input
                              type="tel"
                              placeholder="Phone (+1 555 019 2834)"
                              value={row.phone}
                              onChange={(e) =>
                                setQuickRows((prev) =>
                                  prev.map((r, i) =>
                                    i === index ? { ...r, phone: e.target.value } : r
                                  )
                                )
                              }
                              className="md:col-span-2 px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                            <input
                              type="text"
                              list="domain-options"
                              placeholder="Technical Domain"
                              value={row.technicalDomain}
                              onChange={(e) =>
                                setQuickRows((prev) =>
                                  prev.map((r, i) =>
                                    i === index
                                      ? { ...r, technicalDomain: e.target.value }
                                      : r
                                  )
                                )
                              }
                              className="md:col-span-3 px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                            <div className="md:col-span-1 flex justify-end">
                              <button
                                type="button"
                                disabled={quickRows.length <= 1}
                                onClick={() =>
                                  setQuickRows((prev) =>
                                    prev.filter((_, i) => i !== index)
                                  )
                                }
                                className="p-2 text-slate-400 hover:text-red-600 disabled:opacity-30"
                                aria-label="Remove row"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}

                        <datalist id="domain-options">
                          {bootstrap.domainConfigs.map((d) => (
                            <option key={d.domainKey} value={d.domainName} />
                          ))}
                        </datalist>

                        <div className="flex justify-end pt-1">
                          <button
                            type="submit"
                            disabled={uploadingPreview}
                            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60"
                          >
                            Validate & Trigger Automated Assignment
                          </button>
                        </div>
                      </form>
                    </div>
                  </section>

                  {/* Import Batch History */}
                  <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                    <h2 className="text-base font-semibold text-slate-900">
                      Recent Import Batches & Duplicate Diagnostics
                    </h2>
                    {bootstrap.importBatches.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No spreadsheets imported yet. Upload a 4-column Excel or CSV file above to begin automated task assignment.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
                        {bootstrap.importBatches.map((batch) => (
                          <div key={batch.id} className="py-3.5 space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
                              <div className="flex flex-wrap items-center gap-2 text-slate-600">
                                <span className="font-mono font-semibold text-slate-900">
                                  {batch.batchCode}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-medium text-slate-800">
                                  {batch.fileName}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>{batch.validCount} eligible</span>
                                <span aria-hidden="true">·</span>
                                <span>{batch.duplicateCount} duplicates skipped</span>
                                <span aria-hidden="true">·</span>
                                <span>{batch.invalidCount} invalid</span>
                              </div>
                              <span className="font-mono text-slate-500">
                                {new Date(batch.createdAt).toLocaleString()}
                              </span>
                            </div>

                            {batch.rowErrors.length > 0 && (
                              <div className="text-xs text-amber-800 space-y-0.5">
                                {batch.rowErrors.slice(0, 5).map((err, i) => (
                                  <p key={i} className="font-mono text-[11px]">
                                    Row {err.rowNumber} ({err.email || 'no email'}):{' '}
                                    {err.reason}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              )}

              {/* ================================================================
                  VIEW 2: ASSIGNED TASKS, EMPLOYEE PORTAL LINKS & GITHUB REVIEWS
                 ================================================================ */}
              {activeSection === 'tasks' && bootstrap && (
                <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                  <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search employee, email, domain, or task code..."
                        className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <select
                        value={domainFilter}
                        onChange={(e) => setDomainFilter(e.target.value)}
                        className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                      >
                        <option value="all">All Technical Domains</option>
                        {uniqueDomains.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>

                      {/* Interactive Segmented Filter Buttons (Allowed per frontend-design) */}
                      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                        {[
                          { id: 'all', label: 'All' },
                          { id: 'assigned', label: 'Assigned' },
                          { id: 'voice_briefing_completed', label: 'Briefed' },
                          { id: 'changes_requested', label: 'Changes Needed' },
                          { id: 'completed', label: 'Completed' },
                        ].map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setStatusFilter(tab.id)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                              statusFilter === tab.id
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {filteredTasks.length === 0 ? (
                    <div className="py-12 text-center space-y-3 border-t border-slate-100">
                      <p className="text-sm font-medium text-slate-900">
                        {bootstrap.tasks.length === 0
                          ? 'No employee tasks assigned yet.'
                          : 'No tasks match your active filter.'}
                      </p>
                      <p className="text-xs text-slate-500 max-w-md mx-auto">
                        {bootstrap.tasks.length === 0
                          ? 'Import a 4-column employee Excel or CSV sheet to automatically generate domain tasks, unique Employee AI Voice Bot portals, and onboarding emails.'
                          : 'Clear your search or domain filter to see all assigned tasks.'}
                      </p>
                      {bootstrap.tasks.length === 0 && (
                        <button
                          type="button"
                          onClick={() => setActiveSection('import')}
                          className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
                        >
                          Go to Employee Import
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="overflow-x-auto border-t border-slate-200">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                            <th className="py-2.5 pr-4">Employee & Domain</th>
                            <th className="py-2.5 px-3">Assigned Task</th>
                            <th className="py-2.5 px-3">Status & Revisions</th>
                            <th className="py-2.5 px-3">Deadline</th>
                            <th className="py-2.5 pl-3 text-right">Actions & Bot Page</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {filteredTasks.map((t) => {
                            const verifiedCount =
                              t.latestReview?.criterionResults.filter(
                                (c) => c.status === 'verified_complete'
                              ).length ?? 0;

                            return (
                              <tr
                                key={t.id}
                                className="hover:bg-slate-50/80 transition-colors"
                              >
                                <td className="py-3 pr-4 align-top">
                                  <p className="font-semibold text-slate-900">
                                    {t.employee.fullName}
                                  </p>
                                  <p className="text-slate-500">
                                    {t.employee.email} · {t.technicalDomain}
                                  </p>
                                </td>

                                <td className="py-3 px-3 align-top max-w-xs">
                                  <p className="font-medium text-slate-900 truncate">
                                    {t.title}
                                  </p>
                                  <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                                    {t.taskCode} ·{' '}
                                    {t.onboardingMeetLink || t.reviewMeetLink
                                      ? 'Google Meet Scheduled'
                                      : 'Portal Voice Bot Ready'}
                                  </p>
                                </td>

                                <td className="py-3 px-3 align-top tabular-nums">
                                  <p
                                    className={
                                      t.status === 'completed'
                                        ? 'font-semibold text-emerald-700'
                                        : t.status === 'changes_requested' ||
                                          t.status === 'unable_to_verify'
                                        ? 'font-semibold text-amber-700'
                                        : 'font-medium text-slate-800'
                                    }
                                  >
                                    {formatTaskStatus(t.status)}
                                  </p>
                                  <p className="font-mono text-[11px] text-slate-500">
                                    Rev #{t.currentRevisionNumber} · {verifiedCount}/
                                    {t.acceptanceCriteria.length} criteria verified
                                  </p>
                                </td>

                                <td className="py-3 px-3 align-top font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                                  {t.formattedDeadline}
                                </td>

                                <td className="py-3 pl-3 align-top text-right whitespace-nowrap">
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onOpenEmployeePortal(t.portalToken)
                                      }
                                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded hover:bg-slate-800 whitespace-nowrap shrink-0"
                                    >
                                      <span>Open Bot Page</span>
                                      <ExternalLink className="w-3 h-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void copyPortalUrl(t.portalUrl, t.portalToken)
                                      }
                                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 whitespace-nowrap shrink-0"
                                      title="Copy unique employee portal link"
                                    >
                                      {copiedToken === t.portalToken ? (
                                        <>
                                          <Check className="w-3 h-3 text-emerald-700" />
                                          <span>Copied</span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3 h-3" />
                                          <span>Copy Link</span>
                                        </>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setSelectedTaskId(t.id)}
                                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50 whitespace-nowrap shrink-0"
                                    >
                                      Details
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}

              {/* ================================================================
                  VIEW 3: DOMAIN-TO-TASK MAPPINGS, REQUIREMENTS & DEADLINES
                 ================================================================ */}
              {activeSection === 'domains' && bootstrap && (
                <div className="space-y-6">
                  {/* Global Defaults */}
                  <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                    <h2 className="text-base font-semibold text-slate-900">
                      Global Task-Generation & Timezone Defaults
                    </h2>
                    <form
                      onSubmit={handleSaveGlobalSettings}
                      className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end"
                    >
                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Default Timezone (Consistent Across Emails & Portal)
                        </label>
                        <select
                          value={globalTz}
                          onChange={(e) => setGlobalTz(e.target.value)}
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                        >
                          {COMMON_TIMEZONES.map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Default Deadline (Days)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          value={globalDeadlineDays}
                          onChange={(e) =>
                            setGlobalDeadlineDays(Number(e.target.value) || 2)
                          }
                          className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                        />
                      </div>

                      <div className="md:col-span-3">
                        <label className="flex items-center gap-2 text-xs font-medium text-slate-700 py-2">
                          <input
                            type="checkbox"
                            checked={globalAutoGenerate}
                            onChange={(e) => setGlobalAutoGenerate(e.target.checked)}
                            className="rounded border-slate-300"
                          />
                          <span>Enable AI Dynamic Task Refinement</span>
                        </label>
                      </div>

                      <div className="md:col-span-2 flex justify-end">
                        <button
                          type="submit"
                          disabled={savingGlobalSettings}
                          className="w-full px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60"
                        >
                          {savingGlobalSettings ? 'Saving...' : 'Save Defaults'}
                        </button>
                      </div>
                    </form>
                  </section>

                  {/* Domain-to-Task Configurator */}
                  <section className="bg-white border border-slate-200 rounded-lg p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
                    <div className="lg:col-span-4 space-y-3 border-b lg:border-b-0 lg:border-r border-slate-100 pb-6 lg:pb-0 lg:pr-6">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">
                          Technical Domains
                        </h3>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDomainKey('custom_new');
                            setEditingDomain({
                              domainKey: '',
                              domainName: '',
                              generationMode: 'ai_dynamic',
                              taskTitleTemplate: '',
                              taskDescriptionTemplate: '',
                              whyRequiredTemplate: '',
                              requirementsText: '',
                              expectedOutputTemplate:
                                'A public GitHub repository containing modular source code, automated tests, and README.md.',
                              stepsText: '',
                              criteria: [
                                {
                                  id: 'AC-1',
                                  title: 'Core Domain Implementation',
                                  description:
                                    'Implements required module with input validation.',
                                  required: true,
                                  verificationHint: 'Inspect source files.',
                                },
                                {
                                  id: 'AC-2',
                                  title: 'Automated Tests & README',
                                  description:
                                    'Includes automated test suite and setup guide.',
                                  required: true,
                                  verificationHint: 'Inspect test files and README.md.',
                                },
                              ],
                              deadlineDays: globalDeadlineDays,
                              timezone: globalTz,
                            });
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 whitespace-nowrap shrink-0"
                        >
                          <Plus className="w-3 h-3" />
                          <span>New Domain</span>
                        </button>
                      </div>

                      <div className="space-y-1">
                        {bootstrap.domainConfigs.map((cfg) => (
                          <button
                            key={cfg.domainKey}
                            type="button"
                            onClick={() => populateDomainEditor(cfg)}
                            className={`w-full text-left px-3 py-2.5 rounded-md text-xs transition-colors ${
                              selectedDomainKey === cfg.domainKey
                                ? 'bg-slate-900 text-white'
                                : 'text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            <p className="font-semibold">{cfg.domainName}</p>
                            <p className="text-[11px] opacity-80 truncate">
                              {cfg.generationMode === 'ai_dynamic'
                                ? 'AI Dynamic'
                                : 'Strict Template'}{' '}
                              · {cfg.deadlineDays}d · {cfg.timezone}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>

                    {editingDomain && (
                      <form
                        onSubmit={handleSaveDomainRule}
                        className="lg:col-span-8 space-y-4"
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Domain Name
                            </label>
                            <input
                              type="text"
                              required
                              value={editingDomain.domainName}
                              onChange={(e) =>
                                setEditingDomain({
                                  ...editingDomain,
                                  domainName: e.target.value,
                                })
                              }
                              placeholder="e.g. Mobile Engineering"
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Generation Mode
                            </label>
                            <select
                              value={editingDomain.generationMode}
                              onChange={(e) =>
                                setEditingDomain({
                                  ...editingDomain,
                                  generationMode: e.target.value as
                                    | 'ai_dynamic'
                                    | 'template',
                                })
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            >
                              <option value="ai_dynamic">
                                AI Dynamic (Grounded in Baseline)
                              </option>
                              <option value="template">Exact Template Match</option>
                            </select>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs font-medium text-slate-700 mb-1">
                                Days
                              </label>
                              <input
                                type="number"
                                min={1}
                                max={30}
                                value={editingDomain.deadlineDays}
                                onChange={(e) =>
                                  setEditingDomain({
                                    ...editingDomain,
                                    deadlineDays: Number(e.target.value) || 2,
                                  })
                                }
                                className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-700 mb-1">
                                Timezone
                              </label>
                              <select
                                value={editingDomain.timezone}
                                onChange={(e) =>
                                  setEditingDomain({
                                    ...editingDomain,
                                    timezone: e.target.value,
                                  })
                                }
                                className="w-full px-2 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                              >
                                {COMMON_TIMEZONES.map((tz) => (
                                  <option key={tz} value={tz}>
                                    {tz}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Baseline Task Title
                          </label>
                          <input
                            type="text"
                            required
                            value={editingDomain.taskTitleTemplate}
                            onChange={(e) =>
                              setEditingDomain({
                                ...editingDomain,
                                taskTitleTemplate: e.target.value,
                              })
                            }
                            className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                          />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Task Description
                            </label>
                            <textarea
                              rows={3}
                              value={editingDomain.taskDescriptionTemplate}
                              onChange={(e) =>
                                setEditingDomain({
                                  ...editingDomain,
                                  taskDescriptionTemplate: e.target.value,
                                })
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Why This Task Is Required
                            </label>
                            <textarea
                              rows={3}
                              value={editingDomain.whyRequiredTemplate}
                              onChange={(e) =>
                                setEditingDomain({
                                  ...editingDomain,
                                  whyRequiredTemplate: e.target.value,
                                })
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Exact Technical Requirements (One per line)
                            </label>
                            <textarea
                              rows={4}
                              value={editingDomain.requirementsText}
                              onChange={(e) =>
                                setEditingDomain({
                                  ...editingDomain,
                                  requirementsText: e.target.value,
                                })
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Recommended Implementation Steps (One per line)
                            </label>
                            <textarea
                              rows={4}
                              value={editingDomain.stepsText}
                              onChange={(e) =>
                                setEditingDomain({
                                  ...editingDomain,
                                  stepsText: e.target.value,
                                })
                              }
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
                            />
                          </div>
                        </div>

                        <div className="space-y-2 pt-2 border-t border-slate-100">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-800">
                              Testable Acceptance Criteria ({editingDomain.criteria.length})
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setEditingDomain({
                                  ...editingDomain,
                                  criteria: [
                                    ...editingDomain.criteria,
                                    {
                                      id: `AC-${editingDomain.criteria.length + 1}`,
                                      title: '',
                                      description: '',
                                      required: true,
                                      verificationHint: 'Inspect repository files.',
                                    },
                                  ],
                                })
                              }
                              className="text-xs font-medium text-slate-700 hover:text-slate-900 whitespace-nowrap shrink-0"
                            >
                              + Add Criterion
                            </button>
                          </div>

                          {editingDomain.criteria.map((ac, idx) => (
                            <div
                              key={idx}
                              className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center"
                            >
                              <input
                                type="text"
                                value={ac.id}
                                onChange={(e) => {
                                  const next = [...editingDomain.criteria];
                                  next[idx] = { ...ac, id: e.target.value };
                                  setEditingDomain({ ...editingDomain, criteria: next });
                                }}
                                className="sm:col-span-2 px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded"
                              />
                              <input
                                type="text"
                                placeholder="Criterion title"
                                value={ac.title}
                                onChange={(e) => {
                                  const next = [...editingDomain.criteria];
                                  next[idx] = { ...ac, title: e.target.value };
                                  setEditingDomain({ ...editingDomain, criteria: next });
                                }}
                                className="sm:col-span-4 px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                              />
                              <input
                                type="text"
                                placeholder="Verification description"
                                value={ac.description}
                                onChange={(e) => {
                                  const next = [...editingDomain.criteria];
                                  next[idx] = { ...ac, description: e.target.value };
                                  setEditingDomain({ ...editingDomain, criteria: next });
                                }}
                                className="sm:col-span-5 px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                              />
                              <button
                                type="button"
                                disabled={editingDomain.criteria.length <= 1}
                                onClick={() =>
                                  setEditingDomain({
                                    ...editingDomain,
                                    criteria: editingDomain.criteria.filter(
                                      (_, i) => i !== idx
                                    ),
                                  })
                                }
                                className="sm:col-span-1 p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>

                        <div className="flex justify-end pt-2">
                          <button
                            type="submit"
                            disabled={savingDomain}
                            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60"
                          >
                            {savingDomain ? 'Saving Rule...' : 'Save Domain Mapping'}
                          </button>
                        </div>
                      </form>
                    )}
                  </section>
                </div>
              )}

              {/* ================================================================
                  VIEW 4: OUTBOX, AUTOMATION JOBS & AUDIT TRAIL
                 ================================================================ */}
              {activeSection === 'operations' && bootstrap && (
                <div className="space-y-6">
                  {/* Email Deliveries */}
                  <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900">
                          Automated Email Outbox & Idempotent Retry Log
                        </h2>
                        <p className="text-xs text-slate-500">
                          Retrying an email reuses its exact stored specification and never resets or shifts task deadlines.
                        </p>
                      </div>
                    </div>

                    {bootstrap.emails.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No automated emails queued yet.
                      </p>
                    ) : (
                      <div className="overflow-x-auto border-t border-slate-200">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                              <th className="py-2.5 pr-4">Recipient & Type</th>
                              <th className="py-2.5 px-3">Subject</th>
                              <th className="py-2.5 px-3">Channel & Status</th>
                              <th className="py-2.5 pl-3 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {bootstrap.emails.map((em) => (
                              <tr key={em.id}>
                                <td className="py-2.5 pr-4 align-top">
                                  <p className="font-medium text-slate-900">
                                    {em.recipientEmail}
                                  </p>
                                  <p className="font-mono text-[11px] text-slate-500">
                                    {em.emailType}
                                  </p>
                                </td>
                                <td className="py-2.5 px-3 align-top max-w-md">
                                  <p className="text-slate-800 truncate">{em.subject}</p>
                                  {em.lastError && (
                                    <p className="text-[11px] text-amber-800 truncate">
                                      {em.lastError}
                                    </p>
                                  )}
                                </td>
                                <td className="py-2.5 px-3 align-top font-mono text-[11px] tabular-nums">
                                  <span
                                    className={
                                      em.deliveryStatus === 'sent'
                                        ? 'text-emerald-700 font-semibold'
                                        : 'text-amber-700 font-semibold'
                                    }
                                  >
                                    {em.deliveryStatus}
                                  </span>{' '}
                                  · {em.channel} · retries: {em.retryCount}
                                </td>
                                <td className="py-2.5 pl-3 align-top text-right">
                                  {em.deliveryStatus !== 'sent' && (
                                    <button
                                      type="button"
                                      onClick={() => setEmailToRetry(em)}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-800 bg-slate-100 rounded hover:bg-slate-200 whitespace-nowrap shrink-0"
                                    >
                                      <Mail className="w-3 h-3" />
                                      <span>Retry Send</span>
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  {/* Background Automation Queue & Audit Log */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                      <div className="flex items-center justify-between gap-4">
                        <h3 className="text-sm font-semibold text-slate-900">
                          Background Automation Queue
                        </h3>
                        <button
                          type="button"
                          onClick={handleDrainQueue}
                          disabled={drainingJobs}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>{drainingJobs ? 'Running...' : 'Run Queue Sweep'}</span>
                        </button>
                      </div>

                      <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto text-xs">
                        {bootstrap.automationJobs.length === 0 ? (
                          <p className="text-slate-500 py-2">No background jobs logged.</p>
                        ) : (
                          bootstrap.automationJobs.map((job) => (
                            <div
                              key={job.id}
                              className="py-2.5 flex items-center justify-between gap-3 tabular-nums"
                            >
                              <div>
                                <p className="font-mono font-medium text-slate-900">
                                  {job.jobType}
                                </p>
                                {job.lastError && (
                                  <p className="text-[11px] text-red-600 truncate max-w-xs">
                                    {job.lastError}
                                  </p>
                                )}
                              </div>
                              <span className="font-mono text-[11px] text-slate-600">
                                {job.status} · attempt {job.attempts}/{job.maxAttempts}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </section>

                    <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                      <h3 className="text-sm font-semibold text-slate-900">
                        System Audit Trail
                      </h3>
                      <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto text-xs">
                        {bootstrap.auditLogs.length === 0 ? (
                          <p className="text-slate-500 py-2">No audit events yet.</p>
                        ) : (
                          bootstrap.auditLogs.map((log) => (
                            <div key={log.id} className="py-2.5 space-y-0.5 tabular-nums">
                              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                                <span className="font-mono text-slate-700">
                                  {log.eventType}
                                </span>
                                <span className="font-mono">
                                  {new Date(log.createdAt).toLocaleTimeString()}
                                </span>
                              </div>
                              <p className="text-slate-700">{log.summary}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* ======================================================================
          MODAL 1: BATCH IMPORT & WORKSPACE GMAIL / CALENDAR MEET CONFIRMATION
         ====================================================================== */}
      {pendingBatch && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-xl w-full p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Confirm Automated Batch Task Assignment & Workspace Dispatch
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  File: <span className="font-mono">{pendingBatch.fileName}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPendingBatch(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-2 text-xs text-slate-700 tabular-nums">
              <p>
                <strong className="text-slate-900">
                  {pendingBatch.preview.validRows.length}
                </strong>{' '}
                valid employee(s) ready for automated onboarding ·{' '}
                <strong>{pendingBatch.preview.duplicateCount}</strong> duplicate email(s)
                skipped · <strong>{pendingBatch.preview.invalidCount}</strong> invalid row(s)
                skipped.
              </p>
              {pendingBatch.preview.domainsDetected.length > 0 && (
                <p>
                  Detected Technical Domains:{' '}
                  <span className="font-medium text-slate-900">
                    {pendingBatch.preview.domainsDetected.join(' · ')}
                  </span>
                </p>
              )}
              <p className="text-slate-600 pt-1">
                {workspaceConnected
                  ? `Confirming will automatically create ${pendingBatch.preview.validRows.length} domain-matched task(s), schedule Google Calendar + Google Meet briefing event(s), and send onboarding email(s) via your connected Google Workspace account.`
                  : `Confirming will automatically create ${pendingBatch.preview.validRows.length} domain-matched task(s), generate unique Employee AI Voice Bot Portal links, and queue/send onboarding notifications via configured SMTP.`}
              </p>
            </div>

            {pendingBatch.preview.rowErrors.length > 0 && (
              <div className="max-h-32 overflow-y-auto p-3 bg-amber-50 border border-amber-200 rounded-md text-[11px] font-mono text-amber-900 space-y-1">
                {pendingBatch.preview.rowErrors.map((err, idx) => (
                  <p key={idx}>
                    Row {err.rowNumber}: {err.reason}
                  </p>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setPendingBatch(null)}
                disabled={committingImport}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  committingImport || pendingBatch.preview.validRows.length === 0
                }
                onClick={handleConfirmAutomatedImport}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {committingImport
                  ? 'Assigning & Dispatching...'
                  : `Confirm & Auto-Assign (${pendingBatch.preview.validRows.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================
          MODAL 2: EMAIL RETRY WORKSPACE CONFIRMATION
         ====================================================================== */}
      {emailToRetry && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              Confirm Outbound Email Retry
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Send stored email{' '}
              <strong className="text-slate-900">{emailToRetry.subject}</strong> to{' '}
              <span className="font-mono text-slate-900">
                {emailToRetry.recipientEmail}
              </span>
              ? The original task deadline will remain strictly unchanged.
            </p>
            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setEmailToRetry(null)}
                disabled={retryingEmail}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRetryEmail}
                disabled={retryingEmail}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                {retryingEmail ? 'Sending...' : 'Confirm & Send Email'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================
          DRAWER: TASK, VOICE TRANSCRIPT & MULTI-REVISION GITHUB INSPECTOR
         ====================================================================== */}
      {selectedTask && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 flex justify-end">
          <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-6 space-y-6 border-l border-slate-200">
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
              <div className="space-y-1">
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  {selectedTask.taskCode} · {selectedTask.employee.fullName} ·{' '}
                  {selectedTask.technicalDomain}
                </p>
                <h2 className="text-lg font-bold text-slate-900">
                  {selectedTask.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTaskId(null)}
                className="p-1.5 text-slate-400 hover:text-slate-800 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-md text-xs">
              <div className="space-y-0.5 tabular-nums">
                <p className="font-medium text-slate-900">
                  Employee AI Bot Link:{' '}
                  <span className="font-mono text-slate-600">
                    {selectedTask.portalUrl}
                  </span>
                </p>
                <p className="text-slate-500">
                  Locked Deadline: {selectedTask.formattedDeadline}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenEmployeePortal(selectedTask.portalToken)}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Open Employee Bot Page
              </button>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-900">
                Acceptance Criteria & Verification Evidence
              </h3>
              <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
                {selectedTask.acceptanceCriteria.map((ac) => {
                  const res = selectedTask.latestReview?.criterionResults.find(
                    (c) => c.criterionId === ac.id
                  );
                  return (
                    <div key={ac.id} className="py-2.5 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-900">
                          {ac.id} · {ac.title}
                        </span>
                        <span className="font-mono text-[11px] text-slate-600">
                          {res ? res.status : 'pending'}
                        </span>
                      </div>
                      <p className="text-slate-600">{ac.description}</p>
                      {res && res.evidenceFiles.length > 0 && (
                        <p className="font-mono text-[11px] text-slate-500">
                          Evidence: {res.evidenceFiles.join(', ')}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-900 tabular-nums">
                Submitted GitHub Revisions ({selectedTask.submissions.length})
              </h3>
              {selectedTask.submissions.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Employee has not submitted a GitHub repository yet.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 border-t border-b border-slate-100 text-xs">
                  {selectedTask.submissions.map((sub) => (
                    <div key={sub.id} className="py-3 space-y-1.5 tabular-nums">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-slate-900">
                          Revision #{sub.revisionNumber} · {sub.commitSha.slice(0, 8)} (
                          {sub.branch})
                        </span>
                        <span className="font-mono text-slate-700">
                          {sub.review?.overallVerdict || sub.testExecutionStatus} (
                          {sub.review?.scorePercent ?? 0}%)
                        </span>
                      </div>
                      <p className="font-mono text-[11px] text-slate-500">
                        {sub.repositoryUrl}
                      </p>
                      {sub.review && (
                        <p className="text-slate-700">{sub.review.summary}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedTask.voiceSessions.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-900 tabular-nums">
                  AI Voice Bot Session Log ({selectedTask.voiceSessions.length})
                </h3>
                <div className="space-y-2 text-xs text-slate-600">
                  {selectedTask.voiceSessions.map((vs) => (
                    <div
                      key={vs.id}
                      className="p-3 bg-slate-50 border border-slate-200 rounded space-y-1 tabular-nums"
                    >
                      <p className="font-medium text-slate-900">
                        {vs.sessionType} · {vs.questionsAskedCount} question(s) asked ·{' '}
                        {vs.status}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
