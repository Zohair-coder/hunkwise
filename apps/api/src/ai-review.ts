import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import { sanitizeSecrets, type FindingCategory, type FindingSeverity, type GitLabPosition, type ReviewDetail } from '@hunkwise/contracts';
import type { AiReviewFindingRecord, GitLabReviewContext } from '@hunkwise/db';

const findingCategorySchema = z.enum(['bug', 'security', 'maintainability', 'test', 'docs', 'performance', 'other']);
const findingSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);

export const aiReviewModelOutputSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  overviewCommentBody: z.string().trim().min(1).max(65_536),
  findings: z.array(z.object({
    category: findingCategorySchema,
    severity: findingSeveritySchema,
    confidence: z.number().min(0).max(1),
    title: z.string().trim().min(1).max(300),
    rationale: z.string().trim().min(1).max(4000),
    filePath: z.string().trim().min(1).max(2048),
    line: z.number().int().positive().nullable().default(null),
    lineEnd: z.number().int().positive().nullable().default(null),
    suggestedFix: z.string().trim().max(4000).nullable().default(null),
    shouldPost: z.boolean().default(false)
  }).refine((value) => value.lineEnd === null || value.line === null || value.lineEnd >= value.line, 'lineEnd must be greater than or equal to line')).max(100)
});

export type AiReviewModelOutput = z.infer<typeof aiReviewModelOutputSchema>;

export interface AiPromptOptions {
  maxPatchCharacters?: number;
  maxHunksPerFile?: number;
}

export interface AiReviewPrompt {
  system: string;
  user: string;
  metadata: {
    includedFiles: number;
    includedHunks: number;
    truncatedHunks: number;
    maxPatchCharacters: number;
  };
}

export interface AiReviewClient {
  review(input: { model: string; system: string; user: string }): Promise<string>;
}

export class OpenAiReviewClient implements AiReviewClient {
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey });
  }

  async review(input: { model: string; system: string; user: string }): Promise<string> {
    const completion = await this.#client.chat.completions.create({
      model: input.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user }
      ]
    });
    return completion.choices[0]?.message?.content ?? '';
  }
}

export class AiReviewError extends Error {
  constructor(readonly code: 'model_output_invalid' | 'model_request_failed', message: string) {
    super(message);
    this.name = 'AiReviewError';
  }
}

export function parseModelOutput(raw: string): AiReviewModelOutput {
  try {
    return aiReviewModelOutputSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new AiReviewError('model_output_invalid', error instanceof Error ? sanitizeForPrompt(error.message) : 'Model output was invalid');
  }
}

export function buildReviewPrompt(detail: ReviewDetail, context: GitLabReviewContext, options: AiPromptOptions = {}): AiReviewPrompt {
  const maxPatchCharacters = options.maxPatchCharacters ?? 24_000;
  const maxHunksPerFile = options.maxHunksPerFile ?? 12;
  let remainingPatchCharacters = maxPatchCharacters;
  let includedHunks = 0;
  let truncatedHunks = 0;

  const hunkByFile = new Map(detail.files.map((file) => [
    file.id,
    detail.hunks.filter((hunk) => hunk.diffFileId === file.id).sort((a, b) => a.position - b.position)
  ]));

  const files = detail.files.map((file) => {
    const hunks = (hunkByFile.get(file.id) ?? []).slice(0, maxHunksPerFile).map((hunk) => {
      const sanitizedPatch = sanitizeForPrompt(hunk.patch);
      const patch = sanitizedPatch.length > remainingPatchCharacters
        ? `${sanitizedPatch.slice(0, Math.max(0, remainingPatchCharacters))}\n[truncated: patch character budget exhausted]`
        : sanitizedPatch;
      if (patch.length < sanitizedPatch.length) truncatedHunks += 1;
      remainingPatchCharacters = Math.max(0, remainingPatchCharacters - patch.length);
      includedHunks += 1;
      return {
        hunkId: hunk.id,
        position: hunk.position,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lineMap: mapDiffHunkLines(hunk).map((line) => ({ ...line, content: sanitizeForPrompt(line.content) })),
        patch
      };
    });
    const totalHunks = hunkByFile.get(file.id)?.length ?? 0;
    truncatedHunks += Math.max(0, totalHunks - hunks.length);
    return {
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      hunks
    };
  });

  const commentsByDiscussion = detail.discussions.map((discussion) => ({
    gitlabDiscussionId: discussion.gitlabDiscussionId,
    resolved: discussion.resolved,
    comments: detail.comments
      .filter((comment) => comment.discussionId === discussion.id)
      .map((comment) => ({
        authorType: comment.authorType,
        authorName: sanitizeForPrompt(comment.authorName),
        body: sanitizeForPrompt(comment.body)
      }))
  }));

  const payload = {
    mergeRequest: {
      title: sanitizeForPrompt(context.mergeRequestTitle),
      url: context.mergeRequestUrl,
      projectPath: context.projectPathWithNamespace,
      iid: context.mergeRequestIid,
      sourceBranch: sanitizeForPrompt(context.sourceBranch),
      targetBranch: sanitizeForPrompt(context.targetBranch),
      sourceSha: context.sourceSha,
      targetSha: context.targetSha
    },
    diffRefs: {
      baseSha: context.targetSha,
      startSha: context.startSha,
      headSha: context.sourceSha
    },
    files,
    existingDiscussions: commentsByDiscussion,
    truncation: {
      maxPatchCharacters,
      maxHunksPerFile,
      includedHunks,
      truncatedHunks
    }
  };

  return {
    system: [
      'You are Hunkwise, a senior code review agent for GitLab merge requests.',
      'Return only valid JSON. Do not wrap it in markdown.',
      'Focus on actionable defects. Avoid duplicate comments already covered by existingDiscussions.',
      'Set shouldPost true only for findings worth posting to GitLab.',
      'Use file paths and line numbers from the supplied hunks when possible.'
    ].join(' '),
    user: JSON.stringify(payload, null, 2),
    metadata: { includedFiles: files.length, includedHunks, truncatedHunks, maxPatchCharacters }
  };
}

export function toFindingRecords(output: AiReviewModelOutput, detail: ReviewDetail, context: GitLabReviewContext): AiReviewFindingRecord[] {
  return output.findings.map((finding) => {
    const diffHunkId = hunkIdForFinding(detail, finding.filePath, finding.line);
    return {
      aiFindingKey: findingKey(finding),
      diffHunkId,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      rationale: finding.rationale,
      filePath: finding.filePath,
      line: finding.line,
      lineEnd: finding.lineEnd,
      confidence: finding.confidence,
      suggestedFix: finding.suggestedFix,
      shouldPost: finding.shouldPost,
      gitlabPosition: gitLabPositionForFinding(detail, context, finding.filePath, finding.line)
    };
  });
}

export function gitLabPositionForFinding(detail: ReviewDetail, context: GitLabReviewContext, filePath: string, line: number | null): GitLabPosition | null {
  if (line === null) return null;
  const file = detail.files.find((candidate) => candidate.newPath === filePath || candidate.oldPath === filePath);
  if (!file) return null;
  const hunks = detail.hunks.filter((hunk) => hunk.diffFileId === file.id);
  for (const hunk of hunks) {
    const mapped = mapDiffHunkLines(hunk).find((entry) => entry.newLine === line || entry.oldLine === line);
    if (!mapped) continue;
    return {
      baseSha: context.targetSha,
      startSha: context.startSha,
      headSha: context.sourceSha,
      oldPath: file.oldPath ?? file.newPath,
      newPath: file.newPath,
      positionType: 'text',
      ...(mapped.oldLine === null ? {} : { oldLine: mapped.oldLine }),
      ...(mapped.newLine === null ? {} : { newLine: mapped.newLine })
    };
  }
  return null;
}

export function mapDiffHunkLines(hunk: { patch: string; oldStart: number; newStart: number }): Array<{ oldLine: number | null; newLine: number | null; content: string }> {
  const lines = hunk.patch.split('\n').slice(1);
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const mapped: Array<{ oldLine: number | null; newLine: number | null; content: string }> = [];
  for (const line of lines) {
    if (line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      mapped.push({ oldLine: null, newLine, content: line });
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      mapped.push({ oldLine, newLine: null, content: line });
      oldLine += 1;
    } else {
      mapped.push({ oldLine, newLine, content: line });
      oldLine += 1;
      newLine += 1;
    }
  }
  return mapped;
}

export function sanitizeForPrompt(value: string): string {
  return sanitizeSecrets(value);
}

const hunkIdForFinding = (detail: ReviewDetail, filePath: string, line: number | null): string | null => {
  if (line === null) return null;
  const file = detail.files.find((candidate) => candidate.newPath === filePath || candidate.oldPath === filePath);
  if (!file) return null;
  return detail.hunks.find((hunk) =>
    hunk.diffFileId === file.id &&
    line >= hunk.newStart &&
    line < hunk.newStart + Math.max(hunk.newLines, 1)
  )?.id ?? null;
};

const findingKey = (finding: { category: FindingCategory; severity: FindingSeverity; title: string; filePath: string; line: number | null }): string =>
  createHash('sha256')
    .update([finding.category, finding.severity, finding.filePath, finding.line ?? '', finding.title].join('\0'))
    .digest('hex');
