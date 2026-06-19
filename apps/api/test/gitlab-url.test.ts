import { describe, expect, it } from 'vitest';
import { MergeRequestUrlError, parseGitLabMergeRequestUrl } from '../src/gitlab-url.js';

describe('GitLab merge request URL parser', () => {
  it('parses nested self-hosted project paths and instance path prefixes', () => {
    expect(parseGitLabMergeRequestUrl(
      'https://gitlab.example.com/gitlab',
      'https://gitlab.example.com/gitlab/group/subgroup/project/-/merge_requests/42'
    )).toEqual({ projectPath: 'group/subgroup/project', mergeRequestIid: 42 });
  });

  it('rejects mismatched, unsafe, and ambiguous URLs', () => {
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com', 'https://other.example.com/group/project/-/merge_requests/1'))
      .toThrow(new MergeRequestUrlError('instance_mismatch', 'Merge request URL does not belong to the selected GitLab instance'));
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com', 'https://user:pass@gitlab.example.com/group/project/-/merge_requests/1'))
      .toThrow(MergeRequestUrlError);
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com/gitlab', 'https://gitlab.example.com/group/project/-/merge_requests/1'))
      .toThrow(MergeRequestUrlError);
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com', 'https://gitlab.example.com/project/-/merge_requests/1'))
      .toThrow(MergeRequestUrlError);
  });

  it('rejects malformed percent encodings and encoded path separators as unsafe URLs', () => {
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com', 'https://gitlab.example.com/group/project%ZZ/-/merge_requests/1'))
      .toThrow(new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL contains invalid percent encoding'));
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com', 'https://gitlab.example.com/group/proj%2Fsub/-/merge_requests/1'))
      .toThrow(new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL contains an encoded path separator'));
    expect(() => parseGitLabMergeRequestUrl('https://gitlab.example.com', 'https://gitlab.example.com/group/proj%5Csub/-/merge_requests/1'))
      .toThrow(new MergeRequestUrlError('unsafe_url', 'GitLab merge request URL contains an encoded path separator'));
  });
});
