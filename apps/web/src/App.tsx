import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { sanitizeSecrets, type Comment, type DiffFile, type DiffHunk, type Discussion, type Finding, type GitLabInstance, type ReviewDetail, type ReviewRun } from '@hunkwise/contracts';
import { api, ApiError } from './api.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; reviews: ReviewRun[]; instances: GitLabInstance[] }
  | { kind: 'error'; message: string; code?: string };

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: ReviewDetail }
  | { kind: 'error'; message: string; code?: string };

type ActionState = { kind: 'idle' | 'loading' | 'success' | 'error'; message?: string; code?: string | undefined };
type MobilePane = 'files' | 'diff' | 'findings';
type FindingFilter = 'all' | 'postable' | 'posted' | 'blocked';

const safeMessage = (message: string): string => sanitizeSecrets(message);

const errorState = (error: unknown, fallback: string): { message: string; code?: string } => {
  if (error instanceof ApiError) return { message: safeMessage(error.message), code: error.code };
  if (error instanceof Error) return { message: safeMessage(error.message) };
  return { message: fallback };
};

const displayDate = (value: string | null): string => value ? new Date(value).toLocaleString() : 'Not recorded';
const shortSha = (value: string | null | undefined): string => value ? value.slice(0, 10) : 'unknown';

function validateMergeRequestUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a valid HTTP(S) GitLab merge request URL.';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return 'Use an HTTP(S) MR URL without credentials, query strings, or fragments.';
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.lastIndexOf('-');
  const iid = Number(parts[marker + 2]);
  if (marker < 1 || parts[marker + 1] !== 'merge_requests' || !Number.isInteger(iid) || iid <= 0) {
    return 'URL must point to /namespace/project/-/merge_requests/:iid.';
  }
  return null;
}

function StatusPill({ status }: { status: ReviewRun['status'] }) {
  return <span className={`status status-${status}`}><i />{status}</span>;
}

function Header({ onHome }: { onHome: () => void }) {
  return <header className="topbar">
    <button className="brand" onClick={onHome} aria-label="Hunkwise home">
      <span className="brand-mark"><i /><i /><i /></span>
      <span>Hunkwise</span>
    </button>
    <nav aria-label="Main navigation">
      <button onClick={onHome}>Reviews</button>
      <a href="https://docs.gitlab.com/ee/user/project/merge_requests/" target="_blank" rel="noreferrer">GitLab MR docs</a>
    </nav>
    <div className="self-hosted"><span /> Self-hosted GitLab</div>
  </header>;
}

function Notice({ title, message, code }: { title: string; message: string; code?: string | undefined }) {
  const help = code === 'ai_not_configured'
    ? 'Set OPENAI_API_KEY on the API process, then re-run the review.'
    : code === 'instance_mismatch' || code === 'not_merge_request_url' || code === 'unsafe_url'
      ? 'Check the selected instance and paste the canonical GitLab MR URL.'
      : code?.includes('auth') || code === 'gitlab_unauthorized'
        ? 'Verify the GitLab token has api scope and access to the project.'
        : undefined;
  return <div className="notice" role="alert">
    <strong>{title}</strong>
    <p>{message}</p>
    {help && <small>{help}</small>}
  </div>;
}

function InstanceManager({ instances, onChanged }: { instances: GitLabInstance[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [formState, setFormState] = useState<ActionState>({ kind: 'idle' });
  const [testState, setTestState] = useState<Record<string, ActionState>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormState({ kind: 'loading' });
    try {
      await api.createInstance({ name, baseUrl, accessToken });
      setAccessToken('');
      setName('');
      setBaseUrl('');
      setFormState({ kind: 'success', message: 'Instance saved. Token was submitted and cleared locally.' });
      await onChanged();
    } catch (error) {
      setAccessToken('');
      const state = errorState(error, 'GitLab instance could not be saved.');
      setFormState({ kind: 'error', message: state.message });
    }
  };

  const test = async (instance: GitLabInstance) => {
    setTestState((current) => ({ ...current, [instance.id]: { kind: 'loading' } }));
    try {
      const result = await api.testInstance(instance.id);
      setTestState((current) => ({
        ...current,
        [instance.id]: {
          kind: result.ok ? 'success' : 'error',
          message: result.ok ? `Connected${result.username ? ` as ${result.username}` : ''}${result.version ? `, GitLab ${result.version}` : ''}.` : 'GitLab rejected the stored credentials.'
        }
      }));
    } catch (error) {
      const state = errorState(error, 'GitLab connection test failed.');
      setTestState((current) => ({ ...current, [instance.id]: { kind: 'error', message: state.message } }));
    }
  };

  return <section className="setup-panel" aria-labelledby="instances-title">
    <div className="section-heading compact">
      <div><span className="eyebrow">Connections</span><h2 id="instances-title">GitLab instances</h2></div>
      <span className="quiet">{instances.length} configured</span>
    </div>
    <form className="instance-form" onSubmit={(event) => void submit(event)}>
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Internal GitLab" /></label>
      <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required type="url" placeholder="https://gitlab.example.com" /></label>
      <label>Access token<input value={accessToken} onChange={(event) => setAccessToken(event.target.value)} required type="password" autoComplete="off" placeholder="glpat-..." /></label>
      <button className="primary" disabled={formState.kind === 'loading'}>{formState.kind === 'loading' ? 'Saving...' : 'Save instance'}</button>
    </form>
    {formState.kind === 'error' && <Notice title="Instance could not be saved" message={formState.message ?? 'Unknown error'} />}
    {formState.kind === 'success' && <p className="success-note">{formState.message}</p>}
    {instances.length === 0 && <div className="empty-box">Add a self-hosted GitLab instance before submitting merge requests.</div>}
    <div className="instance-list">
      {instances.map((instance) => {
        const state = testState[instance.id] ?? { kind: 'idle' };
        return <div className="instance-row" key={instance.id}>
          <div>
            <strong>{instance.name}</strong>
            <small>{instance.baseUrl}</small>
            <span>{instance.hasAccessToken ? 'Token stored' : 'Token missing'}</span>
          </div>
          <button type="button" onClick={() => void test(instance)} disabled={state.kind === 'loading'}>
            {state.kind === 'loading' ? 'Testing...' : 'Test'}
          </button>
          {state.kind !== 'idle' && state.message && <p className={state.kind === 'success' ? 'success-note' : 'inline-error'}>{state.message}</p>}
        </div>;
      })}
    </div>
  </section>;
}

function ReviewSubmitter({ instances, onSubmitted }: { instances: GitLabInstance[]; onSubmitted: (runId: string) => void }) {
  const [url, setUrl] = useState('');
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? '');
  const [runAi, setRunAi] = useState(true);
  const [autoPost, setAutoPost] = useState(false);
  const [submission, setSubmission] = useState<ActionState>({ kind: 'idle' });

  useEffect(() => {
    if (!instanceId && instances[0]) setInstanceId(instances[0].id);
  }, [instanceId, instances]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!instanceId) {
      setSubmission({ kind: 'error', message: 'Configure a GitLab instance before submitting a merge request.' });
      return;
    }
    const validation = validateMergeRequestUrl(url);
    if (validation) {
      setSubmission({ kind: 'error', message: validation });
      return;
    }
    setSubmission({ kind: 'loading' });
    try {
      const result = await api.submit({ instanceId, mergeRequestUrl: url, runAi, autoPost });
      setSubmission({ kind: 'success', message: `Review ${result.status}.` });
      onSubmitted(result.runId);
    } catch (error) {
      const state = errorState(error, 'The review could not be submitted.');
      setSubmission({ kind: 'error', message: state.message });
    }
  };

  return <form className="submit-card" onSubmit={(event) => void submit(event)}>
    <div className="submit-label"><span>Start a review</span><small>Paste a self-hosted GitLab MR URL</small></div>
    <div className="submit-controls">
      <select aria-label="GitLab instance" value={instanceId} onChange={(event) => setInstanceId(event.target.value)} disabled={instances.length === 0}>
        {instances.length === 0 ? <option value="">No instances</option> : instances.map((instance) => <option value={instance.id} key={instance.id}>{instance.name}</option>)}
      </select>
      <label className="url-field">
        <span aria-hidden="true">MR</span>
        <input aria-label="Merge request URL" required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://gitlab.example.com/group/project/-/merge_requests/42" />
      </label>
      <button className="primary" disabled={submission.kind === 'loading' || instances.length === 0}>{submission.kind === 'loading' ? 'Submitting...' : 'Review MR'}</button>
    </div>
    <div className="option-row">
      <label><input type="checkbox" checked={runAi} onChange={(event) => setRunAi(event.target.checked)} /> Run AI review</label>
      <label><input type="checkbox" checked={autoPost} onChange={(event) => setAutoPost(event.target.checked)} disabled={!runAi} /> Auto-post postable findings</label>
    </div>
    {submission.kind === 'error' && <Notice title="Review submission failed" message={submission.message ?? 'Unknown error'} />}
  </form>;
}

function RecentReviews({ state, onSelect }: { state: LoadState; onSelect: (review: ReviewRun) => void }) {
  return <section className="recent" aria-labelledby="recent-title">
    <div className="section-heading">
      <div><span className="eyebrow">Workspace</span><h2 id="recent-title">Recent reviews</h2></div>
      <span className="quiet">Latest 20</span>
    </div>
    {state.kind === 'loading' && <div className="review-list" aria-label="Loading reviews">
      {[0, 1, 2].map((item) => <div className="skeleton-row" key={item}><span /><span /><span /></div>)}
    </div>}
    {state.kind === 'error' && <Notice title="Reviews could not be loaded" message={state.message} code={state.code} />}
    {state.kind === 'ready' && state.reviews.length === 0 && <div className="empty-box">No reviews yet. Submit an open GitLab merge request to create the first review.</div>}
    {state.kind === 'ready' && state.reviews.length > 0 && <div className="review-list">
      {state.reviews.map((review) => <button key={review.id} className="review-row" onClick={() => onSelect(review)}>
        <span className="review-avatar">MR</span>
        <span>
          <strong>{review.mergeRequest?.title ?? `Review ${review.id.slice(0, 8)}`}</strong>
          <small>{review.mergeRequest ? `!${review.mergeRequest.gitlabIid} by ${review.mergeRequest.authorUsername}` : review.sourceSha.slice(0, 9)} - {new Date(review.createdAt).toLocaleDateString()}</small>
        </span>
        <StatusPill status={review.status} />
        <span className="row-arrow">Open</span>
      </button>)}
    </div>}
  </section>;
}

function Landing({ state, onReload, onSelect }: { state: LoadState; onReload: () => Promise<void>; onSelect: (id: string) => void }) {
  const instances = state.kind === 'ready' ? state.instances : [];
  return <main>
    <section className="hero">
      <div>
        <p className="eyebrow">Review workspace</p>
        <h1>Inspect GitLab merge requests with grounded AI findings.</h1>
        <p className="hero-copy">Connect a self-hosted GitLab instance, ingest a merge request, inspect organized hunks, and post only the review output you approve.</p>
      </div>
      <ReviewSubmitter instances={instances} onSubmitted={(runId) => { void onReload(); onSelect(runId); }} />
    </section>
    {state.kind === 'ready' && <InstanceManager instances={state.instances} onChanged={onReload} />}
    <RecentReviews state={state} onSelect={(review) => onSelect(review.id)} />
  </main>;
}

interface RenderedLine {
  key: string;
  kind: 'context' | 'added' | 'removed' | 'meta';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  sign: string;
}

function renderHunkLines(hunk: DiffHunk): RenderedLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.patch.split('\n').filter((line, index) => !(index === 0 && line.startsWith('@@'))).map((line, index) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { key: `${hunk.id}-${index}`, kind: 'added', oldLine: null, newLine: newLine++, text: line.slice(1), sign: '+' };
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { key: `${hunk.id}-${index}`, kind: 'removed', oldLine: oldLine++, newLine: null, text: line.slice(1), sign: '-' };
    }
    if (line.startsWith('\\')) {
      return { key: `${hunk.id}-${index}`, kind: 'meta', oldLine: null, newLine: null, text: line, sign: '' };
    }
    const text = line.startsWith(' ') ? line.slice(1) : line;
    return { key: `${hunk.id}-${index}`, kind: 'context', oldLine: oldLine++, newLine: newLine++, text, sign: ' ' };
  });
}

function groupedComments(discussions: Discussion[], comments: Comment[]): Map<string, Comment[]> {
  const result = new Map<string, Comment[]>();
  for (const discussion of discussions) result.set(discussion.id, []);
  for (const comment of comments) result.set(comment.discussionId, [...(result.get(comment.discussionId) ?? []), comment]);
  return result;
}

function FindingBadge({ finding }: { finding: Finding }) {
  return <span className={`finding-badge severity-${finding.severity}`}>{finding.severity} / {finding.category} / {Math.round(finding.confidence * 100)}%</span>;
}

function DiffBrowser({
  detail,
  selectedFileId,
  selectedFindingId,
  onSelectFile,
  onSelectFinding
}: {
  detail: ReviewDetail;
  selectedFileId: string | null;
  selectedFindingId: string | null;
  onSelectFile: (id: string) => void;
  onSelectFinding: (finding: Finding) => void;
}) {
  const [filter, setFilter] = useState('');
  const normalized = filter.trim().toLowerCase();
  const files = detail.files.filter((file) => file.newPath.toLowerCase().includes(normalized) || file.oldPath?.toLowerCase().includes(normalized));
  const selectedFile = detail.files.find((file) => file.id === selectedFileId) ?? files[0] ?? null;
  const hunks = selectedFile ? detail.hunks.filter((hunk) => hunk.diffFileId === selectedFile.id) : [];
  const commentsByDiscussion = groupedComments(detail.discussions, detail.comments);
  const findingDiscussionById = new Map(detail.discussions.filter((discussion) => discussion.findingId).map((discussion) => [discussion.findingId, discussion]));
  const unanchoredDiscussions = detail.discussions.filter((discussion) => !discussion.findingId);

  const fileFindings = (file: DiffFile) => detail.findings.filter((finding) => finding.filePath === file.newPath || finding.filePath === file.oldPath);
  const lineFindings = (file: DiffFile, line: RenderedLine) => detail.findings.filter((finding) => {
    if (finding.filePath !== file.newPath && finding.filePath !== file.oldPath) return false;
    if (finding.line === null) return false;
    if (finding.gitlabPosition?.newLine !== undefined) return line.newLine === finding.gitlabPosition.newLine;
    if (finding.gitlabPosition?.oldLine !== undefined) return line.oldLine === finding.gitlabPosition.oldLine;
    return line.newLine !== null ? finding.line === line.newLine : finding.line === line.oldLine;
  });

  return <>
    <aside className="files-panel">
      <div className="panel-title"><span>Changed files</span><small>{files.length}</small></div>
      <label className="file-filter">
        <span aria-hidden="true">Search</span>
        <input aria-label="Filter files by path" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" />
      </label>
      {detail.files.length === 0 && <div className="panel-state">No diff files have been stored for this run.</div>}
      {detail.files.length > 0 && files.length === 0 && <div className="panel-state">No changed file path matches "{filter}".</div>}
      {files.map((file) => {
        const count = fileFindings(file).length;
        return <button className={file.id === selectedFile?.id ? 'active' : ''} onClick={() => onSelectFile(file.id)} key={file.id}>
          <span>{file.status.slice(0, 1).toUpperCase()}</span>
          <span>{file.newPath}</span>
          <small>+{file.additions} -{file.deletions}{count ? ` / ${count}` : ''}</small>
        </button>;
      })}
    </aside>
    <section className="diff-panel" aria-label="Diff browser">
      <div className="diff-toolbar">
        <span>{selectedFile?.newPath ?? 'Diff'}</span>
        {selectedFile && <small>{selectedFile.status} / +{selectedFile.additions} -{selectedFile.deletions}</small>}
      </div>
      {!selectedFile && <div className="panel-state">No diff available for this review.</div>}
      {selectedFile && hunks.length === 0 && <div className="panel-state">This file has no persisted hunks.</div>}
      {selectedFile && hunks.map((hunk) => <div className="hunk" key={hunk.id} id={`hunk-${hunk.id}`}>
        <div className="hunk-title">{hunk.header}</div>
        {renderHunkLines(hunk).map((line) => {
          const matches = lineFindings(selectedFile, line);
          const lineId = `line-${selectedFile.id}-${line.kind}-${line.newLine ?? line.oldLine ?? line.key}`;
          return <div key={line.key} id={lineId} className={`line-wrap${matches.some((finding) => finding.id === selectedFindingId) ? ' selected-line' : ''}`}>
            <div className={`code-line ${line.kind}`}>
              <b>{line.oldLine ?? ''}</b>
              <b>{line.newLine ?? ''}</b>
              <span>{line.sign}</span>
              <code>{line.text || ' '}</code>
            </div>
            {matches.map((finding) => {
              const discussion = findingDiscussionById.get(finding.id);
              return <div className="inline-finding" key={finding.id}>
                <button onClick={() => onSelectFinding(finding)}><FindingBadge finding={finding} /> {finding.title}</button>
                {discussion && commentsByDiscussion.get(discussion.id)?.map((comment) => <blockquote key={comment.id}><strong>{comment.authorName}</strong>{comment.body}</blockquote>)}
              </div>;
            })}
          </div>;
        })}
      </div>)}
      {selectedFile && unanchoredDiscussions.length > 0 && <div className="discussion-block">
        <strong>Existing GitLab discussions</strong>
        {unanchoredDiscussions.map((discussion) => <div className="discussion" key={discussion.id}>
          <small>{discussion.resolved ? 'Resolved' : 'Open'} {discussion.gitlabDiscussionId ?? ''}</small>
          {commentsByDiscussion.get(discussion.id)?.map((comment) => <p key={comment.id}><b>{comment.authorName}</b>: {comment.body}</p>)}
        </div>)}
      </div>}
    </section>
  </>;
}

function FindingsPanel({
  detail,
  selectedFindingId,
  onSelectFinding,
  onPostOverview,
  onPostFinding,
  postState
}: {
  detail: ReviewDetail;
  selectedFindingId: string | null;
  onSelectFinding: (finding: Finding) => void;
  onPostOverview: () => void;
  onPostFinding: (finding: Finding) => void;
  postState: ActionState;
}) {
  const [severity, setSeverity] = useState('all');
  const [category, setCategory] = useState('all');
  const [posting, setPosting] = useState<FindingFilter>('all');
  const commentsByDiscussion = groupedComments(detail.discussions, detail.comments);
  const discussionByFinding = new Map(detail.discussions.filter((discussion) => discussion.findingId).map((discussion) => [discussion.findingId, discussion]));
  const filtered = detail.findings.filter((finding) =>
    (severity === 'all' || finding.severity === severity) &&
    (category === 'all' || finding.category === category) &&
    (posting === 'all' ||
      (posting === 'postable' && finding.shouldPost && !finding.postedAt && Boolean(finding.gitlabPosition)) ||
      (posting === 'posted' && Boolean(finding.postedAt || finding.gitlabDiscussionId)) ||
      (posting === 'blocked' && (!finding.shouldPost || !finding.gitlabPosition)))
  );
  const selected = filtered.find((finding) => finding.id === selectedFindingId) ?? filtered[0] ?? null;

  return <aside className="findings-panel">
    <div className="activity-tabs">
      <button className="active">Findings <span>{filtered.length}</span></button>
    </div>
    <div className="summary-block">
      <span className="eyebrow">AI summary</span>
      <h3>{detail.run.aiModel ? `Model ${detail.run.aiModel}` : 'Model not run'}</h3>
      <p>{detail.run.summary ?? detail.run.errorMessage ?? 'No AI summary has been generated for this run.'}</p>
      {detail.run.errorMessage && <Notice title="AI review failed" message={detail.run.errorMessage} />}
    </div>
    <div className="overview-card">
      <strong>Overview comment preview</strong>
      <p>{detail.run.overviewCommentBody ?? 'No overview comment is available yet.'}</p>
      <button onClick={onPostOverview} disabled={!detail.run.overviewCommentBody || postState.kind === 'loading'}>Post overview</button>
    </div>
    <div className="filters">
      <select aria-label="Filter findings by severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
        {['all', 'critical', 'error', 'warning', 'info'].map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="Filter findings by category" value={category} onChange={(event) => setCategory(event.target.value)}>
        {['all', 'bug', 'security', 'maintainability', 'test', 'docs', 'performance', 'other'].map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="Filter findings by post state" value={posting} onChange={(event) => setPosting(event.target.value as FindingFilter)}>
        <option value="all">all</option>
        <option value="postable">postable</option>
        <option value="posted">posted</option>
        <option value="blocked">blocked</option>
      </select>
    </div>
    {postState.kind === 'error' && <Notice title="Post action failed" message={postState.message ?? 'Unknown error'} code={postState.code} />}
    {postState.kind === 'success' && <p className="success-note">{postState.message}</p>}
    {detail.findings.length === 0 && <div className="panel-state">No AI findings have been persisted for this run.</div>}
    {detail.findings.length > 0 && filtered.length === 0 && <div className="panel-state">No findings match the current filters.</div>}
    <div className="finding-list">
      {filtered.map((finding) => <button className={finding.id === selectedFindingId ? 'selected' : ''} onClick={() => onSelectFinding(finding)} key={finding.id}>
        <i className={finding.severity} />
        <span><strong>{finding.title}</strong><small>{finding.filePath}{finding.line ? `:L${finding.line}` : ''}</small></span>
        <em>{finding.postedAt || finding.gitlabDiscussionId ? 'posted' : finding.shouldPost && finding.gitlabPosition ? 'postable' : 'blocked'}</em>
      </button>)}
    </div>
    {selected && <div className="finding-detail">
      <FindingBadge finding={selected} />
      <h3>{selected.title}</h3>
      <small>{selected.filePath}{selected.line ? `:${selected.line}` : ''}</small>
      <p>{selected.body}</p>
      <p><strong>Rationale:</strong> {selected.rationale}</p>
      {selected.suggestedFix && <pre>{selected.suggestedFix}</pre>}
      <div className="post-state">
        {selected.postedAt || selected.gitlabDiscussionId ? 'Posted to GitLab' : selected.shouldPost && selected.gitlabPosition ? 'Ready to post' : 'Not postable from stored metadata'}
      </div>
      <button onClick={() => onPostFinding(selected)} disabled={postState.kind === 'loading' || Boolean(selected.postedAt || selected.gitlabDiscussionId)}>Post selected finding</button>
      {discussionByFinding.get(selected.id) && <div className="discussion">
        <strong>Discussion</strong>
        {commentsByDiscussion.get(discussionByFinding.get(selected.id)!.id)?.map((comment) => <p key={comment.id}><b>{comment.authorName}</b>: {comment.body}</p>)}
      </div>}
    </div>}
  </aside>;
}

function ReviewWorkspace({ reviewId, onBack }: { reviewId: string; onBack: () => void }) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('diff');
  const [postState, setPostState] = useState<ActionState>({ kind: 'idle' });
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' });

  const loadDetail = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const detail = await api.review(reviewId);
      setState({ kind: 'ready', detail });
      setSelectedFileId((current) => current ?? detail.files[0]?.id ?? null);
      setSelectedFindingId((current) => current ?? detail.findings[0]?.id ?? null);
    } catch (error) {
      setState({ kind: 'error', ...errorState(error, 'Review detail could not be loaded.') });
    }
  }, [reviewId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const detail = state.kind === 'ready' ? state.detail : null;
  const selectedFinding = detail?.findings.find((finding) => finding.id === selectedFindingId) ?? null;

  const selectFinding = (finding: Finding) => {
    setSelectedFindingId(finding.id);
    const file = detail?.files.find((candidate) => candidate.newPath === finding.filePath || candidate.oldPath === finding.filePath);
    if (file) {
      setSelectedFileId(file.id);
      setMobilePane('diff');
    }
  };

  const refresh = async () => {
    setActionState({ kind: 'loading' });
    try {
      const result = await api.refreshReview(reviewId);
      setActionState({ kind: 'success', message: `Refresh accepted: ${result.status}.` });
      await loadDetail();
    } catch (error) {
      const failed = errorState(error, 'Refresh failed.');
      setActionState({ kind: 'error', message: failed.message, code: failed.code });
    }
  };

  const rerun = async () => {
    setActionState({ kind: 'loading' });
    try {
      const result = await api.runAiReview(reviewId, { force: true, autoPost: false });
      setActionState({ kind: 'success', message: `AI review ${result.status}.` });
      await loadDetail();
    } catch (error) {
      const failed = errorState(error, 'AI review could not be started.');
      setActionState({ kind: 'error', message: failed.message, code: failed.code });
    }
  };

  const post = async (input: { includeOverview: boolean; findingIds: string[] }) => {
    setPostState({ kind: 'loading' });
    try {
      const response = await api.postAiReview(reviewId, input);
      const posted = response.items.filter((item) => !item.skipped).length;
      const skipped = response.items.filter((item) => item.skipped).length;
      setPostState({ kind: 'success', message: `${posted} posted, ${skipped} skipped.` });
      await loadDetail();
    } catch (error) {
      const failed = errorState(error, 'Post action failed.');
      setPostState({ kind: 'error', message: failed.message, code: failed.code });
    }
  };

  return <main className="shell-page">
    <div className="shell-header">
      <button className="back" onClick={onBack}>All reviews</button>
      <div>
        <span className="eyebrow">Review status</span>
        <h1>{detail?.run.mergeRequest?.title ?? `Review ${reviewId.slice(0, 8)}`}</h1>
      </div>
      {detail && <div className="shell-meta"><StatusPill status={detail.run.status} /><span>{detail.files.length} files</span><span>{detail.findings.length} findings</span></div>}
    </div>
    <nav className="mobile-tabs" aria-label="Review workspace panels">
      {(['files', 'diff', 'findings'] as const).map((pane) => <button key={pane} className={mobilePane === pane ? 'active' : ''} onClick={() => setMobilePane(pane)}>{pane}</button>)}
    </nav>
    {state.kind === 'loading' && <div className="loading-page">Loading review data...</div>}
    {state.kind === 'error' && <Notice title="Review unavailable" message={state.message} code={state.code} />}
    {detail && <div className="review-status">
      <div><span>MR</span><strong>{detail.run.mergeRequest ? `!${detail.run.mergeRequest.gitlabIid} ${detail.run.mergeRequest.state}` : detail.run.mergeRequestId.slice(0, 8)}</strong></div>
      <div><span>Author</span><strong>{detail.run.mergeRequest?.authorUsername ?? 'Unknown'}</strong></div>
      <div><span>Branches</span><strong>{detail.run.mergeRequest ? `${detail.run.mergeRequest.sourceBranch} -> ${detail.run.mergeRequest.targetBranch}` : 'Unknown'}</strong></div>
      <div><span>Head</span><strong>{shortSha(detail.run.sourceSha)}</strong></div>
      <div><span>Started</span><strong>{displayDate(detail.run.startedAt)}</strong></div>
      <div><span>Completed</span><strong>{displayDate(detail.run.completedAt)}</strong></div>
      {detail.run.mergeRequest?.webUrl && <a href={detail.run.mergeRequest.webUrl} target="_blank" rel="noreferrer">Open in GitLab</a>}
      <button onClick={() => void refresh()} disabled={actionState.kind === 'loading'}>Refresh MR</button>
      <button onClick={() => void rerun()} disabled={actionState.kind === 'loading'}>Re-run AI</button>
    </div>}
    {actionState.kind === 'error' && <Notice title="Action failed" message={actionState.message ?? 'Unknown error'} code={actionState.code} />}
    {actionState.kind === 'success' && <p className="success-note shell-note">{actionState.message}</p>}
    {detail && <div className="review-shell">
      <div className={mobilePane === 'files' || mobilePane === 'diff' ? `mobile-active show-${mobilePane}` : ''}>
        <DiffBrowser detail={detail} selectedFileId={selectedFileId} selectedFindingId={selectedFindingId} onSelectFile={(id) => { setSelectedFileId(id); setMobilePane('diff'); }} onSelectFinding={selectFinding} />
      </div>
      <div className={mobilePane === 'findings' ? 'mobile-active' : ''}>
        <FindingsPanel
          detail={detail}
          selectedFindingId={selectedFindingId}
          onSelectFinding={selectFinding}
          onPostOverview={() => void post({ includeOverview: true, findingIds: [] })}
          onPostFinding={(finding) => void post({ includeOverview: false, findingIds: [finding.id] })}
          postState={postState}
        />
      </div>
    </div>}
    {selectedFinding && <a className="sr-only" href={`#finding-${selectedFinding.id}`}>Selected finding anchor</a>}
  </main>;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [reviews, instances] = await Promise.all([api.reviews(), api.instances()]);
      setState({ kind: 'ready', reviews: reviews.items, instances });
    } catch (error) {
      setState({ kind: 'error', ...errorState(error, 'Hunkwise could not load workspace data.') });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <div className="app">
    <Header onHome={() => setSelectedReviewId(null)} />
    {selectedReviewId
      ? <ReviewWorkspace reviewId={selectedReviewId} onBack={() => setSelectedReviewId(null)} />
      : <Landing state={state} onReload={load} onSelect={setSelectedReviewId} />}
  </div>;
}
