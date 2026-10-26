import React from 'react';
import { FileSpreadsheet, Mic, GitBranch, Calendar } from 'lucide-react';

interface GoogleSignInGateProps {
  onSignIn: () => Promise<void>;
  isLoading: boolean;
  error: string | null;
}

export const GoogleSignInGate: React.FC<GoogleSignInGateProps> = ({
  onSignIn,
  isLoading,
  error,
}) => {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <header className="flex items-center justify-between gap-8 px-8 py-4 bg-white border-b border-slate-200">
        <a
          href="/"
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          AI Review Automation Platform
        </a>
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a
            href="#intake"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            4-Column Intake
          </a>
          <a
            href="#voice-bot"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Employee Voice Bot
          </a>
          <a
            href="#github-review"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            GitHub Verification
          </a>
          <a
            href="#meet-sync"
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Workspace Sync
          </a>
        </nav>
        <div className="shrink-0">
          <button
            type="button"
            onClick={onSignIn}
            disabled={isLoading}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            {isLoading ? 'Signing in...' : 'Manager Sign In'}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-8 py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-7 space-y-6">
          <p className="text-xs font-medium text-slate-500">
            Manager Dashboard · Personalized Employee Voice Portal · Multi-Revision GitHub Review
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 leading-[1.12] max-w-2xl text-balance">
            Automated domain task assignment, spoken AI briefings, and GitHub verification.
          </h1>
          <p className="text-base text-slate-600 leading-relaxed max-w-xl">
            Upload a 4-column employee Excel or CSV sheet. The platform automatically groups engineers by technical domain, assigns verifiable tasks with timezone-locked deadlines, schedules Google Meet sessions, explains tasks and code errors by voice on each employee&apos;s dedicated portal, and verifies GitHub revisions until completion.
          </p>

          <div className="pt-2 space-y-3">
            <button
              type="button"
              onClick={onSignIn}
              disabled={isLoading}
              className="gsi-material-button"
            >
              <div className="gsi-material-button-content-wrapper">
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="gsi-material-button-contents">
                  {isLoading ? 'Authenticating...' : 'Sign in with Google'}
                </span>
              </div>
            </button>
            <p className="text-xs text-slate-500">
              Signs into Page One (Manager Dashboard) and authorizes Google Calendar Meet creation and Gmail dispatch with your permission. Employees open Page Two directly from their unique email link without signing in here.
            </p>
            {error && (
              <p className="text-xs font-medium text-red-600 pt-1">{error}</p>
            )}
          </div>
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="space-y-1 border-b border-slate-100 pb-4">
            <h2 className="text-sm font-semibold text-slate-900">
              Two-Page Autonomous Architecture
            </h2>
            <p className="text-xs text-slate-500">
              Zero manual task assignment or per-employee email drafting required.
            </p>
          </div>

          <div className="space-y-5">
            <div id="intake" className="flex items-start gap-3">
              <FileSpreadsheet className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
              <div>
                <h3 className="text-sm font-medium text-slate-900">
                  01. Four-Column Excel & CSV Import
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  Import Employee Name, Email Address, Phone Number, and Technical Domain only. Duplicate emails are isolated and domain tasks generate automatically.
                </p>
              </div>
            </div>

            <div id="voice-bot" className="flex items-start gap-3">
              <Mic className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
              <div>
                <h3 className="text-sm font-medium text-slate-900">
                  02. Interactive AI Voice Bot Portal
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  Each employee receives a private portal link where the AI voice assistant explains requirements, answers live spoken questions, and emails the full specification.
                </p>
              </div>
            </div>

            <div id="github-review" className="flex items-start gap-3">
              <GitBranch className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
              <div>
                <h3 className="text-sm font-medium text-slate-900">
                  03. Multi-Revision GitHub Code Review
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  Inspects real commits, compares fixed vs remaining issues across revisions, walks through file-level fixes by voice, and marks complete only when every required criterion is verified.
                </p>
              </div>
            </div>

            <div id="meet-sync" className="flex items-start gap-3">
              <Calendar className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
              <div>
                <h3 className="text-sm font-medium text-slate-900">
                  04. Google Meet & Idempotent Email Lifecycle
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  Creates authentic Google Calendar Meet links when authorized and preserves exact stored deadlines across every follow-up and retry.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
