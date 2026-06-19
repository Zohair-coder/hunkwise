import type { GitLabInstance, SubmitReview } from '@hunkwise/contracts';

export interface ResolvedMergeRequest {
  projectId: number;
  mergeRequestIid: number;
  sourceSha: string;
}

export interface GitLabGateway {
  resolveMergeRequest(instance: GitLabInstance, url: string): Promise<ResolvedMergeRequest>;
}

export interface ReviewEngine {
  start(input: ResolvedMergeRequest): Promise<{ runId: string }>;
}

export class DownstreamUnavailableError extends Error {
  constructor(readonly service: 'gitlab' | 'review-engine') {
    super(`${service} integration is not implemented in Slice 1`);
    this.name = 'DownstreamUnavailableError';
  }
}

export class UnavailableGitLabGateway implements GitLabGateway {
  resolveMergeRequest(): Promise<ResolvedMergeRequest> {
    return Promise.reject(new DownstreamUnavailableError('gitlab'));
  }
}

export class UnavailableReviewEngine implements ReviewEngine {
  start(): Promise<{ runId: string }> {
    return Promise.reject(new DownstreamUnavailableError('review-engine'));
  }
}

export interface ReviewSubmissionService {
  submit(input: SubmitReview): Promise<{ runId: string }>;
}
