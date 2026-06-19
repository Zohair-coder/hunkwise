import { randomBytes } from 'node:crypto';

export interface GitLabCeE2eOptions {
  projectName: string;
  gitlabHttpPort: number;
  gitlabSshPort: number;
  appPort: number;
  timeoutMs: number;
  keep: boolean;
  cleanup: boolean;
  noBuild: boolean;
  projectSlug: string | null;
}

export interface ReviewDetailSummary {
  runId: string;
  status: string;
  mergeRequestTitle: string;
  files: number;
  hunks: number;
  discussions: number;
  comments: number;
  findings: number;
  postableFindings: number;
}

export class GitLabCeE2eConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLabCeE2eConfigError';
  }
}

const defaults = {
  projectName: 'hunkwise-gitlab-e2e',
  gitlabHttpPort: 8088,
  gitlabSshPort: 2224,
  appPort: 3000,
  timeoutMs: 20 * 60 * 1000
};

const secretPatterns = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /glpat-[A-Za-z0-9_-]{4,}/g,
  /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s@]+@/gi,
  /([?&#](?:access_token|private_token|token|api_key|key|secret|password)=)[^&#\s]+/gi,
  /(["']?[A-Za-z0-9_]*(?:secret|token|key|password|database_url)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi
];

export function parseGitLabCeE2eArgs(argv: readonly string[]): GitLabCeE2eOptions {
  const options: GitLabCeE2eOptions = {
    ...defaults,
    keep: false,
    cleanup: false,
    noBuild: false,
    projectSlug: null
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new GitLabCeE2eConfigError(`${name} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (name) {
      case '--project-name':
        options.projectName = readNonEmpty(name, readValue());
        break;
      case '--gitlab-http-port':
        options.gitlabHttpPort = readPort(name, readValue());
        break;
      case '--gitlab-ssh-port':
        options.gitlabSshPort = readPort(name, readValue());
        break;
      case '--app-port':
        options.appPort = readPort(name, readValue());
        break;
      case '--timeout-ms':
        options.timeoutMs = readPositiveInteger(name, readValue());
        break;
      case '--project-slug':
        options.projectSlug = readProjectSlug(name, readValue());
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--cleanup':
        options.cleanup = true;
        break;
      case '--no-build':
        options.noBuild = true;
        break;
      case '--help':
        throw new GitLabCeE2eConfigError(helpText());
      default:
        throw new GitLabCeE2eConfigError(`Unknown argument: ${arg}`);
    }
  }
  if (options.cleanup && options.keep) {
    throw new GitLabCeE2eConfigError('--cleanup and --keep cannot be combined');
  }
  return options;
}

export function validateGitLabCeE2eEnvironment(environment: NodeJS.ProcessEnv, options: Pick<GitLabCeE2eOptions, 'cleanup'>): string[] {
  const missing: string[] = [];
  if (!options.cleanup && !environment.OPENAI_API_KEY?.trim()) missing.push('OPENAI_API_KEY');
  return missing;
}

export function redactGitLabCeE2eText(input: string, secrets: readonly string[] = []): string {
  let redacted = input;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.split(secret).join('[redacted]');
  }
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (...parts: unknown[]) => {
      const prefix = typeof parts[1] === 'string' ? parts[1] : null;
      return prefix && /[=:]|\?|&|#/.test(prefix) ? `${prefix}[redacted]` : '[redacted]';
    });
  }
  return redacted;
}

export function generateRuntimeSecret(prefix = ''): string {
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

export function generateBase64Key(): string {
  return randomBytes(32).toString('base64');
}

export function summarizeReviewDetail(detail: unknown): ReviewDetailSummary {
  const root = asRecord(detail, 'review detail');
  const run = asRecord(root.run, 'review run');
  const mergeRequest = asRecord(run.mergeRequest, 'merge request');
  const files = asArray(root.files, 'files');
  const hunks = asArray(root.hunks, 'hunks');
  const discussions = asArray(root.discussions, 'discussions');
  const comments = asArray(root.comments, 'comments');
  const findings = asArray(root.findings, 'findings');
  const postableFindings = findings.filter(isPostableFinding).length;

  return {
    runId: readStringField(run, 'id'),
    status: readStringField(run, 'status'),
    mergeRequestTitle: readStringField(mergeRequest, 'title'),
    files: files.length,
    hunks: hunks.length,
    discussions: discussions.length,
    comments: comments.length,
    findings: findings.length,
    postableFindings
  };
}

export function assertIngestedReview(detail: unknown): ReviewDetailSummary {
  const summary = summarizeReviewDetail(detail);
  const failures: string[] = [];
  if (summary.status !== 'completed') failures.push(`expected completed run, got ${summary.status}`);
  if (summary.files < 1) failures.push('expected at least one diff file');
  if (summary.hunks < 1) failures.push('expected at least one diff hunk');
  if (summary.discussions < 1) failures.push('expected at least one imported GitLab discussion');
  if (summary.comments < 1) failures.push('expected at least one imported GitLab comment');
  if (failures.length > 0) throw new Error(`Ingested review verification failed: ${failures.join('; ')}`);
  return summary;
}

export function selectPostableFindingIds(detail: unknown, limit = 1): string[] {
  const findings = asArray(asRecord(detail, 'review detail').findings, 'findings');
  return findings
    .filter(isPostableFinding)
    .map((finding) => readStringField(asRecord(finding, 'finding'), 'id'))
    .slice(0, limit);
}

export function summarizePostedDiscussions(discussions: unknown, expectedDiscussionIds: readonly string[]): { found: number; missing: string[] } {
  const discussionList = asArray(discussions, 'GitLab discussions').map((discussion) => asRecord(discussion, 'GitLab discussion'));
  const foundIds = new Set(discussionList.map((discussion) => readStringField(discussion, 'id')));
  return {
    found: expectedDiscussionIds.filter((id) => foundIds.has(id)).length,
    missing: expectedDiscussionIds.filter((id) => !foundIds.has(id))
  };
}

export function helpText(): string {
  return [
    'Usage: npm run e2e:gitlab -- [options]',
    '',
    'Options:',
    '  --project-name <name>       Docker Compose project name',
    '  --gitlab-http-port <port>   Host port for GitLab HTTP',
    '  --gitlab-ssh-port <port>    Host port for GitLab SSH',
    '  --app-port <port>           Host port for Hunkwise',
    '  --timeout-ms <ms>           Startup/API wait budget',
    '  --project-slug <slug>       GitLab project path suffix',
    '  --no-build                  Reuse the existing Hunkwise image',
    '  --keep                      Keep containers and volumes after success',
    '  --cleanup                   Remove containers and volumes for the project'
  ].join('\n');
}

const readPort = (name: string, value: string): number => {
  const port = readPositiveInteger(name, value);
  if (port > 65535) throw new GitLabCeE2eConfigError(`${name} must be <= 65535`);
  return port;
};

const readPositiveInteger = (name: string, value: string): number => {
  if (!/^\d+$/.test(value)) throw new GitLabCeE2eConfigError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new GitLabCeE2eConfigError(`${name} must be a positive integer`);
  return parsed;
};

const readNonEmpty = (name: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new GitLabCeE2eConfigError(`${name} cannot be empty`);
  return trimmed;
};

const readProjectSlug = (name: string, value: string): string => {
  const slug = readNonEmpty(name, value);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new GitLabCeE2eConfigError(`${name} must contain only lowercase letters, numbers, and hyphens`);
  }
  return slug;
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected ${label} object`);
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} array`);
  return value;
};

const readStringField = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected ${field} string`);
  return value;
};

const isPostableFinding = (value: unknown): boolean => {
  const finding = asRecord(value, 'finding');
  return finding.shouldPost === true && finding.gitlabPosition !== null && finding.gitlabPosition !== undefined;
};
