import type { GitLabDiffFileSnapshot, GitLabDiffHunkSnapshot } from '@hunkwise/db';

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedDiff {
  additions: number;
  deletions: number;
  hunks: GitLabDiffHunkSnapshot[];
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const hunks: GitLabDiffHunkSnapshot[] = [];
  let additions = 0;
  let deletions = 0;
  let current: GitLabDiffHunkSnapshot | null = null;
  const lines = diff.split('\n');

  const finish = (): void => {
    if (current) hunks.push(current);
    current = null;
  };

  for (const line of lines) {
    const match = hunkHeader.exec(line);
    if (match) {
      finish();
      current = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        header: line,
        patch: line,
        position: hunks.length
      };
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    if (current) current.patch += `\n${line}`;
  }
  finish();
  return { additions, deletions, hunks };
}

export function diffFileStatus(input: { new_file?: boolean; renamed_file?: boolean; deleted_file?: boolean }): GitLabDiffFileSnapshot['status'] {
  if (input.deleted_file) return 'deleted';
  if (input.renamed_file) return 'renamed';
  if (input.new_file) return 'added';
  return 'modified';
}
