import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nonEmpty = z.string().trim().min(1);
const usesHttp = (value: string): boolean => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
  } catch { return false; }
};
const httpUrl = z.string().url().refine(usesHttp, 'Must use HTTP(S)');
const isCleanInstanceBaseUrl = (value: string): boolean =>
  usesHttp(value) && !value.includes('?') && !value.includes('#') && !/\s/.test(value);
const canonicalizeInstanceBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return `${parsed.origin}${pathname}`;
};
const instanceBaseUrl = z.string().url().refine(
  isCleanInstanceBaseUrl,
  'Must be an HTTP(S) base URL without credentials, query, or fragment'
);

export const gitLabInstanceSchema = z.object({
  id,
  name: nonEmpty.max(120),
  baseUrl: instanceBaseUrl,
  hasAccessToken: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp
});
export type GitLabInstance = z.infer<typeof gitLabInstanceSchema>;

export const createGitLabInstanceSchema = z.object({
  name: nonEmpty.max(120),
  baseUrl: instanceBaseUrl.transform(canonicalizeInstanceBaseUrl),
  accessToken: nonEmpty.max(2048)
});
export type CreateGitLabInstance = z.infer<typeof createGitLabInstanceSchema>;

export const updateGitLabInstanceSchema = createGitLabInstanceSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one field is required'
);
export type UpdateGitLabInstance = z.infer<typeof updateGitLabInstanceSchema>;

export const projectSchema = z.object({
  id,
  instanceId: id,
  gitlabId: z.number().int().positive(),
  pathWithNamespace: nonEmpty,
  defaultBranch: z.string().nullable(),
  webUrl: z.string().url(),
  createdAt: timestamp,
  updatedAt: timestamp
});
export type Project = z.infer<typeof projectSchema>;

export const mergeRequestStateSchema = z.enum(['open', 'merged', 'closed']);
export const mergeRequestSchema = z.object({
  id,
  projectId: id,
  gitlabIid: z.number().int().positive(),
  title: nonEmpty,
  authorUsername: nonEmpty,
  sourceBranch: nonEmpty,
  targetBranch: nonEmpty,
  sourceSha: nonEmpty,
  targetSha: nonEmpty,
  state: mergeRequestStateSchema,
  webUrl: z.string().url(),
  createdAt: timestamp,
  updatedAt: timestamp
});
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

export const reviewRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const reviewRunSchema = z.object({
  id,
  mergeRequestId: id,
  status: reviewRunStatusSchema,
  sourceSha: nonEmpty,
  summary: z.string().nullable(),
  errorMessage: z.string().nullable(),
  aiModel: z.string().nullable(),
  overviewCommentBody: z.string().nullable(),
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  mergeRequest: mergeRequestSchema.optional()
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

export const diffFileSchema = z.object({
  id,
  reviewRunId: id,
  oldPath: z.string().nullable(),
  newPath: nonEmpty,
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative()
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffHunkSchema = z.object({
  id,
  diffFileId: id,
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  header: z.string(),
  patch: z.string(),
  position: z.number().int().nonnegative()
});
export type DiffHunk = z.infer<typeof diffHunkSchema>;

export const findingCategorySchema = z.enum(['bug', 'security', 'maintainability', 'test', 'docs', 'performance', 'other']);
export type FindingCategory = z.infer<typeof findingCategorySchema>;

export const findingSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const gitLabPositionSchema = z.object({
  baseSha: nonEmpty,
  startSha: nonEmpty,
  headSha: nonEmpty,
  oldPath: nonEmpty,
  newPath: nonEmpty,
  positionType: z.literal('text').default('text'),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional()
}).refine((value) => value.oldLine !== undefined || value.newLine !== undefined, 'A diff position requires oldLine or newLine');
export type GitLabPosition = z.infer<typeof gitLabPositionSchema>;

export const findingSchema = z.object({
  id,
  reviewRunId: id,
  diffHunkId: id.nullable(),
  severity: findingSeveritySchema,
  category: findingCategorySchema,
  title: nonEmpty,
  body: nonEmpty,
  rationale: nonEmpty,
  filePath: nonEmpty,
  line: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  confidence: z.number().min(0).max(1),
  suggestedFix: z.string().nullable(),
  shouldPost: z.boolean(),
  gitlabPosition: gitLabPositionSchema.nullable(),
  gitlabDiscussionId: z.string().nullable(),
  gitlabNoteId: z.string().nullable(),
  postedAt: timestamp.nullable(),
  status: z.enum(['open', 'dismissed', 'fixed']),
  createdAt: timestamp
});
export type Finding = z.infer<typeof findingSchema>;

export const discussionSchema = z.object({
  id,
  reviewRunId: id,
  findingId: id.nullable(),
  gitlabDiscussionId: z.string().nullable(),
  resolved: z.boolean(),
  createdAt: timestamp
});
export type Discussion = z.infer<typeof discussionSchema>;

export const commentSchema = z.object({
  id,
  discussionId: id,
  authorType: z.enum(['user', 'hunkwise', 'gitlab']),
  authorName: nonEmpty,
  body: nonEmpty,
  gitlabNoteId: z.string().nullable(),
  createdAt: timestamp
});
export type Comment = z.infer<typeof commentSchema>;

export const chatMessageSchema = z.object({
  id,
  reviewRunId: id,
  role: z.enum(['user', 'assistant', 'system']),
  content: nonEmpty,
  createdAt: timestamp
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const submitReviewSchema = z.object({
  instanceId: id,
  mergeRequestUrl: httpUrl,
  runAi: z.boolean().default(false),
  autoPost: z.boolean().default(false)
});
export type SubmitReview = z.infer<typeof submitReviewSchema>;
export type SubmitReviewInput = z.input<typeof submitReviewSchema>;

export const reviewRunReferenceSchema = z.object({
  runId: id,
  status: reviewRunStatusSchema,
  summary: z.string().nullable()
});
export type ReviewRunReference = z.infer<typeof reviewRunReferenceSchema>;

export const testGitLabInstanceResponseSchema = z.object({
  ok: z.boolean(),
  username: z.string().nullable(),
  version: z.string().nullable()
});
export type TestGitLabInstanceResponse = z.infer<typeof testGitLabInstanceResponseSchema>;

export const createOverviewDiscussionSchema = z.object({ body: nonEmpty.max(65_536) });
export type CreateOverviewDiscussion = z.infer<typeof createOverviewDiscussionSchema>;

export const createDiffDiscussionSchema = z.object({
  body: nonEmpty.max(65_536),
  position: gitLabPositionSchema
});
export type CreateDiffDiscussion = z.infer<typeof createDiffDiscussionSchema>;

export const replyDiscussionSchema = z.object({ body: nonEmpty.max(65_536) });
export type ReplyDiscussion = z.infer<typeof replyDiscussionSchema>;

export const updateDiscussionResolutionSchema = z.object({ resolved: z.boolean() });
export type UpdateDiscussionResolution = z.infer<typeof updateDiscussionResolutionSchema>;

export const gitLabDiscussionActionResponseSchema = z.object({
  gitlabDiscussionId: nonEmpty,
  gitlabNoteId: z.string().nullable().optional(),
  resolved: z.boolean().optional()
});
export type GitLabDiscussionActionResponse = z.infer<typeof gitLabDiscussionActionResponseSchema>;

export const triggerAiReviewSchema = z.object({
  autoPost: z.boolean().default(false),
  force: z.boolean().default(false)
});
export type TriggerAiReview = z.infer<typeof triggerAiReviewSchema>;

export const postAiReviewSchema = z.object({
  includeOverview: z.boolean().default(false),
  findingIds: z.array(id).default([])
}).refine((value) => value.includeOverview || value.findingIds.length > 0, 'Select an overview or at least one finding to post');
export type PostAiReview = z.infer<typeof postAiReviewSchema>;

export const aiReviewPostItemSchema = z.object({
  findingId: id.nullable(),
  gitlabDiscussionId: z.string().nullable(),
  gitlabNoteId: z.string().nullable().optional(),
  skipped: z.boolean(),
  reason: z.string().optional()
});
export const aiReviewPostResponseSchema = z.object({
  items: z.array(aiReviewPostItemSchema)
});
export type AiReviewPostResponse = z.infer<typeof aiReviewPostResponseSchema>;

export const gitLabWebhookResponseSchema = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean(),
  runId: id.nullable()
});
export type GitLabWebhookResponse = z.infer<typeof gitLabWebhookResponseSchema>;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});
export type Pagination = z.infer<typeof paginationSchema>;

export const reviewListSchema = z.object({
  items: z.array(reviewRunSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative()
});
export type ReviewList = z.infer<typeof reviewListSchema>;

export const reviewDetailSchema = z.object({
  run: reviewRunSchema,
  files: z.array(diffFileSchema),
  hunks: z.array(diffHunkSchema),
  findings: z.array(findingSchema),
  discussions: z.array(discussionSchema),
  comments: z.array(commentSchema),
  chatMessages: z.array(chatMessageSchema)
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: nonEmpty,
    message: nonEmpty,
    details: z.unknown().optional(),
    requestId: nonEmpty
  })
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
