export class MergeRequestUrlError extends Error {
  constructor(readonly code: 'unsafe_url' | 'instance_mismatch' | 'not_merge_request_url' | 'ambiguous_project_path', message: string) {
    super(message);
    this.name = 'MergeRequestUrlError';
  }
}

export interface ParsedMergeRequestUrl {
  projectPath: string;
  mergeRequestIid: number;
}

const canonicalPath = (pathname: string): string => {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed;
};

const decodeSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL contains invalid percent encoding');
  }
  if (decoded.includes('/') || decoded.includes('\\')) {
    throw new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL contains an encoded path separator');
  }
  return decoded;
};

export function parseGitLabMergeRequestUrl(instanceBaseUrl: string, candidate: string): ParsedMergeRequestUrl {
  let instance: URL;
  let url: URL;
  try {
    instance = new URL(instanceBaseUrl);
    url = new URL(candidate);
  } catch {
    throw new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL is invalid');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL must be HTTP(S) without credentials, query, or fragment');
  }
  if (url.origin !== instance.origin) {
    throw new MergeRequestUrlError('instance_mismatch', 'Merge request URL does not belong to the selected GitLab instance');
  }

  const basePath = canonicalPath(instance.pathname);
  const requestPath = canonicalPath(url.pathname);
  if (basePath && requestPath !== basePath && !requestPath.startsWith(`${basePath}/`)) {
    throw new MergeRequestUrlError('instance_mismatch', 'Merge request URL does not match the GitLab instance path prefix');
  }

  const relativePath = (basePath ? requestPath.slice(basePath.length) : requestPath).replace(/^\/+/, '');
  const parts = relativePath.split('/').filter(Boolean).map(decodeSegment);
  const marker = parts.lastIndexOf('-');
  if (marker < 1 || parts[marker + 1] !== 'merge_requests' || parts.length !== marker + 3) {
    throw new MergeRequestUrlError('not_merge_request_url', 'URL must point to /namespace/project/-/merge_requests/:iid');
  }

  const iid = Number(parts[marker + 2]);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new MergeRequestUrlError('not_merge_request_url', 'Merge request IID must be a positive integer');
  }

  const projectParts = parts.slice(0, marker);
  if (projectParts.length < 2 || projectParts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new MergeRequestUrlError('ambiguous_project_path', 'Merge request URL must include a namespace and project path');
  }

  return { projectPath: projectParts.join('/'), mergeRequestIid: iid };
}
