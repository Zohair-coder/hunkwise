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
  baseUrl: instanceBaseUrl.transform((url) => url.replace(/\/$/, '')),
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

export const findingSchema = z.object({
  id,
  reviewRunId: id,
  diffHunkId: id.nullable(),
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  category: nonEmpty,
  title: nonEmpty,
  body: nonEmpty,
  filePath: nonEmpty,
  line: z.number().int().positive().nullable(),
  confidence: z.number().min(0).max(1),
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
  mergeRequestUrl: httpUrl
});
export type SubmitReview = z.infer<typeof submitReviewSchema>;

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
