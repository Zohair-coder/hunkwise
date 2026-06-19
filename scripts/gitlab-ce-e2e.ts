import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  assertIngestedReview,
  generateBase64Key,
  generateRuntimeSecret,
  GitLabCeE2eConfigError,
  helpText,
  parseGitLabCeE2eArgs,
  redactGitLabCeE2eText,
  selectPostableFindingIds,
  summarizePostedDiscussions,
  summarizeReviewDetail,
  validateGitLabCeE2eEnvironment,
  type GitLabCeE2eOptions
} from '../apps/api/src/gitlab-ce-e2e-harness.js';

interface RuntimeSecrets {
  appEncryptionKey: string;
  gitlabRootPassword: string;
  gitlabToken: string;
  postgresPassword: string;
  webhookSecret: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch?: string | null;
  web_url: string;
}

interface GitLabMergeRequest {
  iid: number;
  web_url: string;
}

interface HunkwiseInstance {
  id: string;
}

interface ReviewRunReference {
  runId: string;
  status: string;
}

interface AiPostItem {
  findingId: string | null;
  gitlabDiscussionId: string | null;
  skipped: boolean;
  reason?: string;
}

const rootDir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const composeFiles = ['-f', 'docker-compose.yml', '-f', 'docker-compose.gitlab-e2e.yml'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const options = parseGitLabCeE2eArgs(process.argv.slice(2));
  const missing = validateGitLabCeE2eEnvironment(process.env, options);
  if (missing.length > 0) {
    throw new GitLabCeE2eConfigError(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const secrets = createSecrets();
  const secretValues = Object.values(secrets).concat(process.env.OPENAI_API_KEY ?? '');
  const env = composeEnvironment(options, secrets);

  if (options.cleanup) {
    await dockerCompose(options, ['down', '-v', '--remove-orphans'], env, secretValues);
    log('Cleanup complete.');
    return;
  }

  let failed = true;
  try {
    await dockerCompose(options, ['pull', 'gitlab', 'postgres'], env, secretValues);
    await dockerCompose(options, ['up', '-d', ...(options.noBuild ? ['--no-build'] : ['--build'])], env, secretValues);
    await waitForGitLabRails(options, env, secretValues);
    await stopGitLabServicesForSetup(options, env, secretValues);
    await installGitLabToken(options, env, secrets.gitlabToken, secretValues);
    await startGitLabServicesAfterSetup(options, env, secretValues);
    await waitForGitLabApi(options, secrets.gitlabToken);
    await waitForHunkwise(options);

    const gitlabBaseUrl = `http://127.0.0.1:${options.gitlabHttpPort}`;
    const hunkwiseBaseUrl = `http://127.0.0.1:${options.appPort}`;
    const slug = options.projectSlug ?? `hunkwise-e2e-${Date.now().toString(36)}-${generateRuntimeSecret().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}`;
    const setup = await createMergeRequestFixture(gitlabBaseUrl, secrets.gitlabToken, slug, options.timeoutMs);

    const instance = await hunkwiseApi<HunkwiseInstance>(hunkwiseBaseUrl, 'POST', '/api/instances', {
      name: 'GitLab CE E2E',
      baseUrl: 'http://gitlab',
      accessToken: secrets.gitlabToken
    });
    await hunkwiseApi(hunkwiseBaseUrl, 'POST', `/api/instances/${instance.id}/test`);

    const submitted = await hunkwiseApi<ReviewRunReference>(hunkwiseBaseUrl, 'POST', '/api/reviews', {
      instanceId: instance.id,
      mergeRequestUrl: setup.internalMergeRequestUrl
    });
    if (submitted.status !== 'completed') throw new Error(`Expected ingestion to complete, got ${submitted.status}`);

    const ingested = await hunkwiseApi(hunkwiseBaseUrl, 'GET', `/api/reviews/${submitted.runId}`);
    const ingestionSummary = assertIngestedReview(ingested);

    const aiRun = await hunkwiseApi<ReviewRunReference>(hunkwiseBaseUrl, 'POST', `/api/reviews/${submitted.runId}/ai-review`, { force: true });
    if (aiRun.status !== 'completed') {
      const failedDetail = await hunkwiseApi(hunkwiseBaseUrl, 'GET', `/api/reviews/${submitted.runId}`);
      const run = typeof failedDetail === 'object' && failedDetail !== null && 'run' in failedDetail
        ? (failedDetail as { run?: { errorMessage?: string | null } }).run
        : undefined;
      throw new Error(`Expected AI review to complete, got ${aiRun.status}${run?.errorMessage ? `: ${run.errorMessage}` : ''}`);
    }

    const reviewed = await hunkwiseApi(hunkwiseBaseUrl, 'GET', `/api/reviews/${submitted.runId}`);
    const reviewSummary = summarizeReviewDetail(reviewed);
    const selectedFindingIds = selectPostableFindingIds(reviewed, 1);
    const postResult = await hunkwiseApi<{ items: AiPostItem[] }>(hunkwiseBaseUrl, 'POST', `/api/reviews/${submitted.runId}/ai-review/post`, {
      includeOverview: true,
      findingIds: selectedFindingIds
    });
    const postedDiscussionIds = postResult.items
      .filter((item) => !item.skipped && item.gitlabDiscussionId)
      .map((item) => item.gitlabDiscussionId)
      .filter((id): id is string => typeof id === 'string');
    if (postedDiscussionIds.length < 1) throw new Error('Expected at least the AI overview discussion to be posted');

    const gitlabDiscussions = await gitLabApi(gitlabBaseUrl, secrets.gitlabToken, 'GET', `/projects/${setup.project.id}/merge_requests/${setup.mergeRequest.iid}/discussions`);
    const postedEvidence = summarizePostedDiscussions(gitlabDiscussions, postedDiscussionIds);
    if (postedEvidence.missing.length > 0) {
      throw new Error(`GitLab did not return posted discussion id(s): ${postedEvidence.missing.join(', ')}`);
    }

    const summary = {
      composeProject: options.projectName,
      gitlabProject: setup.project.path_with_namespace,
      mergeRequest: setup.hostMergeRequestUrl,
      reviewRunId: submitted.runId,
      ingestion: ingestionSummary,
      aiReview: {
        findings: reviewSummary.findings,
        postableFindings: reviewSummary.postableFindings,
        selectedFindingsPosted: selectedFindingIds.length,
        overviewOnlyBranch: selectedFindingIds.length === 0
      },
      postedDiscussionsVerifiedInGitLab: postedEvidence.found,
      cleanup: options.keep ? 'kept for inspection' : 'will remove containers and volumes after success'
    };
    log(redactGitLabCeE2eText(`GitLab CE E2E summary:\n${JSON.stringify(summary, null, 2)}`, secretValues));
    failed = false;
  } finally {
    if (failed || options.keep) {
      log(`Compose project '${options.projectName}' was left running for inspection.`);
      log(`Cleanup command: npm run e2e:gitlab -- --cleanup --project-name ${options.projectName}`);
    } else {
      await dockerCompose(options, ['down', '-v', '--remove-orphans'], env, secretValues);
      log('Compose project cleaned up after successful E2E.');
    }
  }
}

function createSecrets(): RuntimeSecrets {
  return {
    appEncryptionKey: generateBase64Key(),
    gitlabRootPassword: `${generateRuntimeSecret()}aA1!`,
    gitlabToken: generateRuntimeSecret('glpat-'),
    postgresPassword: generateRuntimeSecret('pg-'),
    webhookSecret: generateRuntimeSecret('webhook-')
  };
}

function composeEnvironment(options: GitLabCeE2eOptions, secrets: RuntimeSecrets): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_ENCRYPTION_KEY: secrets.appEncryptionKey,
    GITLAB_HTTP_PORT: String(options.gitlabHttpPort),
    GITLAB_ROOT_PASSWORD: secrets.gitlabRootPassword,
    GITLAB_SSH_PORT: String(options.gitlabSshPort),
    GITLAB_WEBHOOK_SECRET: secrets.webhookSecret,
    HUNKWISE_APP_PORT: String(options.appPort),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    POSTGRES_PASSWORD: secrets.postgresPassword
  };
}

async function createMergeRequestFixture(baseUrl: string, token: string, slug: string, timeoutMs: number): Promise<{
  project: GitLabProject;
  mergeRequest: GitLabMergeRequest;
  hostMergeRequestUrl: string;
  internalMergeRequestUrl: string;
}> {
  const project = await gitLabApi<GitLabProject>(baseUrl, token, 'POST', '/projects', {
    name: slug,
    path: slug,
    visibility: 'private',
    initialize_with_readme: true,
    default_branch: 'main'
  });
  const defaultBranch = project.default_branch ?? 'main';
  const filePath = encodeURIComponent('src/math.js');
  await gitLabApi(baseUrl, token, 'POST', `/projects/${project.id}/repository/files/${filePath}`, {
    branch: defaultBranch,
    content: initialSource(),
    commit_message: 'Add math helpers'
  });
  await gitLabApi(baseUrl, token, 'POST', `/projects/${project.id}/repository/branches`, {
    branch: 'feature/review-target',
    ref: defaultBranch
  });
  await gitLabApi(baseUrl, token, 'PUT', `/projects/${project.id}/repository/files/${filePath}`, {
    branch: 'feature/review-target',
    content: featureSource(),
    commit_message: 'Change lookup and average helpers'
  });
  const mergeRequest = await gitLabApi<GitLabMergeRequest>(baseUrl, token, 'POST', `/projects/${project.id}/merge_requests`, {
    source_branch: 'feature/review-target',
    target_branch: defaultBranch,
    title: 'Review math helper changes'
  });
  await gitLabApi(baseUrl, token, 'POST', `/projects/${project.id}/merge_requests/${mergeRequest.iid}/discussions`, {
    body: 'Existing reviewer note for Hunkwise ingestion verification.'
  });
  await waitForMergeRequestDiffs(baseUrl, token, project.id, mergeRequest.iid, timeoutMs);
  return {
    project,
    mergeRequest,
    hostMergeRequestUrl: `${baseUrl}/root/${slug}/-/merge_requests/${mergeRequest.iid}`,
    internalMergeRequestUrl: `http://gitlab/root/${slug}/-/merge_requests/${mergeRequest.iid}`
  };
}

async function waitForMergeRequestDiffs(baseUrl: string, token: string, projectId: number, mergeRequestIid: number, timeoutMs: number): Promise<void> {
  await waitUntil('GitLab merge request diffs', Math.min(timeoutMs, 180_000), async () => {
    const diffs = await gitLabApi<unknown[]>(baseUrl, token, 'GET', `/projects/${projectId}/merge_requests/${mergeRequestIid}/diffs`).catch(() => []);
    return diffs.some((diff) => {
      if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return false;
      return typeof (diff as Record<string, unknown>).diff === 'string' && ((diff as Record<string, unknown>).diff as string).trim().length > 0;
    });
  });
}

function initialSource(): string {
  return [
    'export function divide(total, count) {',
    '  if (count === 0) return 0;',
    '  return total / count;',
    '}',
    '',
    'export function lookup(items, id) {',
    '  return items.find((item) => item.id === id) ?? null;',
    '}',
    ''
  ].join('\n');
}

function featureSource(): string {
  return [
    'export function divide(total, count) {',
    '  if (count === 0) return 0;',
    '  return total / count;',
    '}',
    '',
    'export function average(values) {',
    '  return values.reduce((sum, value) => sum + value, 0) / values.length;',
    '}',
    '',
    'export function lookup(items, id) {',
    '  return items.find((item) => item.id = id) ?? null;',
    '}',
    ''
  ].join('\n');
}

async function waitForGitLabRails(options: GitLabCeE2eOptions, env: NodeJS.ProcessEnv, secrets: readonly string[]): Promise<void> {
  await waitUntil('GitLab Rails console', options.timeoutMs, async () => {
    const result = await dockerCompose(options, ['exec', '-T', 'gitlab', 'gitlab-rails', 'runner', 'ApplicationRecord.connection.execute("SELECT 1")'], env, secrets, { quiet: true, allowFailure: true });
    return result.code === 0;
  });
}

async function installGitLabToken(options: GitLabCeE2eOptions, env: NodeJS.ProcessEnv, token: string, secrets: readonly string[]): Promise<void> {
  const script = [
    'password = ENV.fetch("HUNKWISE_E2E_ROOT_PASSWORD")',
    'user = User.find_by_username("root")',
    'unless user',
    '  org = Organizations::Organization.default_organization',
    '  user = User.new(username: "root", name: "Administrator", email: "root@example.com", password: password, password_confirmation: password, admin: true, confirmed_at: Time.current)',
    '  user.build_namespace(name: "Administrator", path: "root", organization: org)',
    '  user.save!',
    'end',
    'user.update!(admin: true) unless user.admin?',
    'user.personal_access_tokens.where(name: "hunkwise-e2e").each(&:revoke!)',
    'token = user.personal_access_tokens.create!(name: "hunkwise-e2e", scopes: [:api], expires_at: 1.day.from_now)',
    'token.set_token(ENV.fetch("HUNKWISE_E2E_GITLAB_TOKEN"))',
    'token.save!'
  ].join('; ');
  const result = await dockerCompose(
    options,
    ['exec', '-T', '-e', 'HUNKWISE_E2E_GITLAB_TOKEN', '-e', 'HUNKWISE_E2E_ROOT_PASSWORD', 'gitlab', 'gitlab-rails', 'runner', script],
    { ...env, HUNKWISE_E2E_GITLAB_TOKEN: token, HUNKWISE_E2E_ROOT_PASSWORD: env.GITLAB_ROOT_PASSWORD },
    secrets
  );
  if (result.code !== 0) throw new Error('Failed to install GitLab runtime token');
}

async function stopGitLabServicesForSetup(options: GitLabCeE2eOptions, env: NodeJS.ProcessEnv, secrets: readonly string[]): Promise<void> {
  await dockerCompose(options, ['exec', '-T', 'gitlab', 'gitlab-ctl', 'stop', 'sidekiq'], env, secrets, { quiet: true, allowFailure: true });
  await dockerCompose(options, ['exec', '-T', 'gitlab', 'gitlab-ctl', 'stop', 'puma'], env, secrets, { quiet: true, allowFailure: true });
}

async function startGitLabServicesAfterSetup(options: GitLabCeE2eOptions, env: NodeJS.ProcessEnv, secrets: readonly string[]): Promise<void> {
  await dockerCompose(options, ['exec', '-T', 'gitlab', 'gitlab-ctl', 'start', 'puma'], env, secrets, { quiet: true, allowFailure: true });
  await dockerCompose(options, ['exec', '-T', 'gitlab', 'gitlab-ctl', 'start', 'sidekiq'], env, secrets, { quiet: true, allowFailure: true });
}

async function waitForGitLabApi(options: GitLabCeE2eOptions, token: string): Promise<void> {
  const baseUrl = `http://127.0.0.1:${options.gitlabHttpPort}`;
  await waitUntil('GitLab API', options.timeoutMs, async () => {
    const response = await fetch(`${baseUrl}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } }).catch(() => null);
    return response?.ok ?? false;
  });
}

async function waitForHunkwise(options: GitLabCeE2eOptions): Promise<void> {
  const baseUrl = `http://127.0.0.1:${options.appPort}`;
  await waitUntil('Hunkwise readiness', options.timeoutMs, async () => {
    const response = await fetch(`${baseUrl}/health/ready`).catch(() => null);
    return response?.ok ?? false;
  });
}

async function waitUntil(name: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  let lastUpdate = 0;
  while (Date.now() - started < timeoutMs) {
    if (await probe()) {
      log(`${name} is ready.`);
      return;
    }
    if (Date.now() - lastUpdate > 30_000) {
      log(`Waiting for ${name}...`);
      lastUpdate = Date.now();
    }
    await sleep(5_000);
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms`);
}

async function hunkwiseApi<T = unknown>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  return jsonRequest<T>(`${baseUrl}${path}`, method, body, {}, { retries: 0 });
}

async function gitLabApi<T = unknown>(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  return jsonRequest<T>(`${baseUrl}/api/v4${path}`, method, body, { 'PRIVATE-TOKEN': token }, { retries: 30 });
}

async function jsonRequest<T>(url: string, method: string, body: unknown, headers: Record<string, string>, options: { retries: number }): Promise<T> {
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    if (isTransientGitLabBootResponse(response.status, text) && attempt < options.retries) {
      await sleep(5_000);
      continue;
    }
    const parsed = parseJsonResponse(text, method, url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${method} ${url}: ${text.slice(0, 500)}`);
    }
    return parsed as T;
  }
  throw new Error(`Request retry budget exhausted for ${method} ${url}`);
}

function parseJsonResponse(text: string, method: string, url: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const prefix = text.replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Expected JSON for ${method} ${url}, received: ${prefix}`);
  }
}

function isTransientGitLabBootResponse(status: number, text: string): boolean {
  return [502, 503, 504].includes(status) || /Waiting for GitLab to boot|GitLab is not responding/i.test(text);
}

async function dockerCompose(
  options: GitLabCeE2eOptions,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
  runOptions: { quiet?: boolean; allowFailure?: boolean } = {}
): Promise<RunResult> {
  const result = await runCommand('docker', ['compose', '-p', options.projectName, ...composeFiles, ...args], env, secrets, runOptions.quiet ?? false);
  if (result.code !== 0 && runOptions.allowFailure !== true) {
    throw new Error(`docker compose ${args.join(' ')} failed with ${result.code}\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function runCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv, secrets: readonly string[], quiet: boolean): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = redactGitLabCeE2eText(chunk.toString('utf8'), secrets);
      stdout += text;
      if (!quiet) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = redactGitLabCeE2eText(chunk.toString('utf8'), secrets);
      stderr += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

void main().catch((error: unknown) => {
  if (error instanceof GitLabCeE2eConfigError && error.message === helpText()) {
    process.stdout.write(`${helpText()}\n`);
    process.exitCode = 0;
    return;
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${redactGitLabCeE2eText(message, [process.env.OPENAI_API_KEY ?? ''])}\n`);
  process.exitCode = 1;
});
