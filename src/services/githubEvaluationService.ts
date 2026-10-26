import type { InspectedRepoFile } from '../db/schema.ts';

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  normalizedUrl: string;
  branchHint?: string;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  '169.254.169.254',
  'metadata.google.internal',
]);

function isPrivateOrReservedIp(hostname: string): boolean {
  if (BLOCKED_HOSTS.has(hostname.toLowerCase())) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) return true;
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return true;
  return false;
}

export function validateAndParseGitHubUrl(rawUrl: string): ParsedGitHubUrl {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('GitHub repository URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL format. Provide an https://github.com/<owner>/<repo> URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS GitHub URLs are permitted.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentials embedded in repository URLs are prohibited.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrReservedIp(hostname)) {
    throw new Error('Blocked internal or private network host (SSRF protection).');
  }
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    throw new Error('Only github.com repositories are allowed for automated inspection.');
  }

  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error('GitHub URL must include both repository owner and repository name.');
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');

  if (
    !/^[a-zA-Z0-9._-]+$/.test(owner) ||
    !/^[a-zA-Z0-9._-]+$/.test(repo) ||
    owner === '..' ||
    repo === '..'
  ) {
    throw new Error('Invalid GitHub owner or repository identifier.');
  }

  let branchHint: string | undefined;
  if (segments[2] === 'tree' && segments[3]) {
    branchHint = segments.slice(3).join('/');
  }

  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
    branchHint,
  };
}

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub Personal Access Token', regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { label: 'Google API Key', regex: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { label: 'Private Key Block', regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
];

const PROMPT_INJECTION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: 'Instruction Override Attempt',
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
  },
  {
    label: 'Score Manipulation Directive',
    regex: /(give|assign|award|output)\s+(this\s+candidate\s+|a\s+score\s+of\s+)?(100\s*\/\s*100|full\s+marks|maximum\s+score|perfect\s+score)/i,
  },
  {
    label: 'System Role Hijack Attempt',
    regex: /\b(system\s*prompt\s*override|you\s+are\s+now\s+in\s+developer\s+mode|bypass\s+rubric)\b/i,
  },
];

export function scanArtifactsForSecretsAndInjection(
  files: Array<{ path: string; content: string }>
): {
  hardcodedSecretsDetected: string[];
  promptInjectionFlags: string[];
} {
  const secrets = new Set<string>();
  const injections = new Set<string>();

  for (const file of files) {
    // Skip .env.example placeholder checks unless real key pattern appears
    for (const pat of SECRET_PATTERNS) {
      if (pat.regex.test(file.content)) {
        secrets.add(`${pat.label} in ${file.path}`);
      }
    }
    for (const inj of PROMPT_INJECTION_PATTERNS) {
      if (inj.regex.test(file.content)) {
        injections.add(`${inj.label} in ${file.path}`);
      }
    }
  }

  return {
    hardcodedSecretsDetected: Array.from(secrets),
    promptInjectionFlags: Array.from(injections),
  };
}

function inferLanguageFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'TypeScript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs')) return 'JavaScript';
  if (lower.endsWith('.py')) return 'Python';
  if (lower.endsWith('.go')) return 'Go';
  if (lower.endsWith('.rs')) return 'Rust';
  if (lower.endsWith('.java')) return 'Java';
  if (lower.endsWith('.kt')) return 'Kotlin';
  if (lower.endsWith('.cs')) return 'C#';
  if (lower.endsWith('.rb')) return 'Ruby';
  if (lower.endsWith('.sql')) return 'SQL';
  if (lower.endsWith('.md')) return 'Markdown';
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'Config';
  return 'Other';
}

export interface RepositoryInspectionResult {
  owner: string;
  repo: string;
  normalizedUrl: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  commitTimestamp: string;
  detectedLanguages: string[];
  detectedFrameworks: string[];
  entrypoints: string[];
  inspectedFiles: InspectedRepoFile[];
  readmeFound: boolean;
  testsFound: boolean;
  lintConfigFound: boolean;
  envExampleFound: boolean;
  hardcodedSecretsDetected: string[];
  promptInjectionFlags: string[];
  totalTreeFilesCount: number;
}

function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AI-Recruiter-Assessment-Bot',
  };
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim().length > 0) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  }
  return headers;
}

export async function inspectGitHubRepository(
  repositoryUrl: string,
  branchOverride?: string,
  commitShaOverride?: string
): Promise<RepositoryInspectionResult> {
  const parsed = validateAndParseGitHubUrl(repositoryUrl);
  const headers = buildGitHubHeaders();

  const repoResp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    { headers, signal: AbortSignal.timeout(15000) }
  );

  if (repoResp.status === 404) {
    throw new Error(
      `Repository ${parsed.owner}/${parsed.repo} was not found or is private without GITHUB_TOKEN access.`
    );
  }
  if (!repoResp.ok) {
    throw new Error(`GitHub API returned status ${repoResp.status} while inspecting repository.`);
  }

  const repoMeta = (await repoResp.json()) as {
    default_branch?: string;
    language?: string | null;
  };
  const targetBranch =
    branchOverride?.trim() || parsed.branchHint || repoMeta.default_branch || 'main';

  const commitRef = commitShaOverride?.trim() || targetBranch;
  const commitResp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
      parsed.repo
    )}/commits/${encodeURIComponent(commitRef)}`,
    { headers, signal: AbortSignal.timeout(15000) }
  );

  if (!commitResp.ok) {
    throw new Error(
      `Unable to resolve branch or commit "${commitRef}" in ${parsed.owner}/${parsed.repo} (HTTP ${commitResp.status}).`
    );
  }

  const commitJson = (await commitResp.json()) as {
    sha: string;
    commit?: {
      message?: string;
      author?: { name?: string; date?: string };
    };
  };

  const commitSha = commitJson.sha;
  const commitMessage = (commitJson.commit?.message || '').slice(0, 500);
  const commitAuthor = commitJson.commit?.author?.name || 'Unknown';
  const commitTimestamp = commitJson.commit?.author?.date || new Date().toISOString();

  const treeResp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
      parsed.repo
    )}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    { headers, signal: AbortSignal.timeout(15000) }
  );

  if (!treeResp.ok) {
    throw new Error(`Unable to fetch repository file tree (HTTP ${treeResp.status}).`);
  }

  const treeJson = (await treeResp.json()) as {
    tree?: Array<{ path: string; type: string; size?: number; sha: string }>;
  };

  const blobs = (treeJson.tree ?? []).filter(
    (node) =>
      node.type === 'blob' &&
      !node.path.includes('node_modules/') &&
      !node.path.includes('.git/') &&
      !node.path.includes('dist/') &&
      !node.path.includes('build/') &&
      !node.path.includes('vendor/') &&
      !node.path.endsWith('.lock') &&
      !node.path.endsWith('package-lock.json')
  );

  const readmeFound = blobs.some((b) => /^readme(\.[a-z]+)?$/i.test(b.path.split('/').pop() || ''));
  const testsFound = blobs.some((b) =>
    /(__tests__|\/tests?\/|\.test\.|\.spec\.|test_)/i.test(b.path)
  );
  const lintConfigFound = blobs.some((b) =>
    /(eslint|ruff|flake8| biome\.json|pyproject\.toml|golangci|\.prettierrc)/i.test(b.path)
  );
  const envExampleFound = blobs.some((b) => /\.env\.example|\.env\.sample/i.test(b.path));

  const entrypoints = blobs
    .filter((b) =>
      /^(src\/)?(main|index|app|server|manage)\.(ts|tsx|js|py|go|rs|java)$/i.test(b.path) ||
      /^(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|Dockerfile)$/i.test(
        b.path
      )
    )
    .map((b) => b.path)
    .slice(0, 12);

  // Prioritize manifests, README, entrypoints, core source, and test files (max 16 files, <= 64KB each)
  const prioritizedBlobs = [...blobs]
    .filter((b) => (b.size ?? 0) <= 65536)
    .sort((a, b) => {
      const scorePath = (p: string) => {
        if (/^readme/i.test(p)) return 100;
        if (/^(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml)$/i.test(p))
          return 95;
        if (entrypoints.includes(p)) return 90;
        if (/(\.test\.|\.spec\.|test_)/i.test(p)) return 85;
        if (/\.(ts|tsx|py|go|rs|java|js)$/.test(p)) return 75;
        return 20;
      };
      return scorePath(b.path) - scorePath(a.path);
    })
    .slice(0, 16);

  const inspectedFiles: InspectedRepoFile[] = [];
  const rawContentsForScan: Array<{ path: string; content: string }> = [];
  const languageSet = new Set<string>();
  const frameworkSet = new Set<string>();

  if (repoMeta.language) {
    languageSet.add(repoMeta.language);
  }

  for (const blob of prioritizedBlobs) {
    const lang = inferLanguageFromPath(blob.path);
    if (lang !== 'Other' && lang !== 'Config' && lang !== 'Markdown') {
      languageSet.add(lang);
    }

    const blobResp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
        parsed.repo
      )}/git/blobs/${encodeURIComponent(blob.sha)}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (!blobResp.ok) continue;

    const blobData = (await blobResp.json()) as { content?: string; encoding?: string };
    if (!blobData.content || blobData.encoding !== 'base64') continue;

    const decoded = Buffer.from(blobData.content.replace(/\n/g, ''), 'base64').toString('utf8');
    // Skip binary-like files
    if (decoded.includes('\u0000')) continue;

    rawContentsForScan.push({ path: blob.path, content: decoded });

    if (blob.path.endsWith('package.json')) {
      if (decoded.includes('"next"')) frameworkSet.add('Next.js');
      if (decoded.includes('"react"')) frameworkSet.add('React');
      if (decoded.includes('"express"')) frameworkSet.add('Express');
      if (decoded.includes('"@nestjs/core"')) frameworkSet.add('NestJS');
      if (decoded.includes('"vitest"') || decoded.includes('"jest"'))
        frameworkSet.add('Jest/Vitest');
    }
    if (blob.path.endsWith('requirements.txt') || blob.path.endsWith('pyproject.toml')) {
      if (/fastapi/i.test(decoded)) frameworkSet.add('FastAPI');
      if (/django/i.test(decoded)) frameworkSet.add('Django');
      if (/flask/i.test(decoded)) frameworkSet.add('Flask');
      if (/pytest/i.test(decoded)) frameworkSet.add('Pytest');
    }

    inspectedFiles.push({
      path: blob.path,
      size: blob.size ?? decoded.length,
      sha: blob.sha,
      language: lang,
      snippet: decoded.slice(0, 3200),
    });
  }

  const securityScan = scanArtifactsForSecretsAndInjection(rawContentsForScan);

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    normalizedUrl: parsed.normalizedUrl,
    branch: targetBranch,
    commitSha,
    commitMessage,
    commitAuthor,
    commitTimestamp,
    detectedLanguages: Array.from(languageSet),
    detectedFrameworks: Array.from(frameworkSet),
    entrypoints,
    inspectedFiles,
    readmeFound,
    testsFound,
    lintConfigFound,
    envExampleFound,
    hardcodedSecretsDetected: securityScan.hardcodedSecretsDetected,
    promptInjectionFlags: securityScan.promptInjectionFlags,
    totalTreeFilesCount: blobs.length,
  };
}

export interface VerificationRunSummary {
  executionMode: string;
  status: 'passed' | 'failed' | 'skipped_sandbox_unavailable';
  commandRun: string;
  exitCode: number | null;
  durationMs: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  limitationsNote: string;
}

/**
 * Performs deterministic static structure/manifest/security verification and
 * explicitly documents sandboxed execution availability without ever fabricating test runs.
 */
export function runControlledVerification(
  inspection: RepositoryInspectionResult
): VerificationRunSummary[] {
  const started = Date.now();
  const issues: string[] = [];
  const checksPassed: string[] = [];

  if (inspection.readmeFound) {
    checksPassed.push('README documentation present');
  } else {
    issues.push('Missing README setup/architecture documentation');
  }

  if (inspection.testsFound) {
    checksPassed.push('Test suite files detected in repository tree');
  } else {
    issues.push('No automated test files detected in repository tree');
  }

  if (inspection.hardcodedSecretsDetected.length === 0) {
    checksPassed.push('Zero hardcoded credential signatures detected');
  } else {
    issues.push(
      `Hardcoded credential patterns flagged: ${inspection.hardcodedSecretsDetected.join('; ')}`
    );
  }

  // Validate package.json if inspected
  const pkgJsonFile = inspection.inspectedFiles.find((f) => f.path === 'package.json');
  if (pkgJsonFile) {
    try {
      JSON.parse(pkgJsonFile.snippet);
      checksPassed.push('package.json valid JSON syntax');
    } catch {
      issues.push('package.json failed JSON syntax parse');
    }
  }

  const staticDuration = Math.max(4, Date.now() - started);
  const staticPassed =
    inspection.hardcodedSecretsDetected.length === 0 && inspection.inspectedFiles.length > 0;

  return [
    {
      executionMode: 'static_verification',
      status: staticPassed ? 'passed' : 'failed',
      commandRun: 'static-ast-manifest-and-secret-audit',
      exitCode: staticPassed ? 0 : 1,
      durationMs: staticDuration,
      stdoutExcerpt: checksPassed.join(' | '),
      stderrExcerpt: issues.join(' | '),
      limitationsNote:
        'Deterministic static manifest, test-presence, and secret/injection verification completed on fetched blobs.',
    },
    {
      executionMode: 'isolated_container_sandbox',
      status: 'skipped_sandbox_unavailable',
      commandRun: 'docker run --network=none --cpus=1 --memory=512m <untrusted-repo-tests>',
      exitCode: null,
      durationMs: 0,
      stdoutExcerpt: '',
      stderrExcerpt: '',
      limitationsNote:
        'Untrusted candidate code is never executed directly on the host server. Connect an isolated ephemeral container runner to execute runtime test suites; evaluation relies on static source inspection until sandbox runner is attached.',
    },
  ];
}
