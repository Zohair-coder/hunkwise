import { describe, expect, it } from 'vitest';
import { diffFileStatus, parseUnifiedDiff } from '../src/diff.js';

describe('unified diff parsing', () => {
  it('extracts hunks, additions, deletions, and line ranges', () => {
    const parsed = parseUnifiedDiff([
      '@@ -1,2 +1,3 @@',
      ' unchanged',
      '-old',
      '+new',
      '+extra',
      '@@ -10 +11 @@',
      '-gone',
      '+back'
    ].join('\n'));
    expect(parsed.additions).toBe(3);
    expect(parsed.deletions).toBe(2);
    expect(parsed.hunks).toMatchObject([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, position: 0 },
      { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, position: 1 }
    ]);
  });

  it('maps GitLab file flags to persisted statuses', () => {
    expect(diffFileStatus({ new_file: true })).toBe('added');
    expect(diffFileStatus({ renamed_file: true })).toBe('renamed');
    expect(diffFileStatus({ deleted_file: true })).toBe('deleted');
    expect(diffFileStatus({})).toBe('modified');
  });
});
