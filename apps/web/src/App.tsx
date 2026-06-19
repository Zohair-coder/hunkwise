import { useEffect, useState, type FormEvent } from 'react';
import type { DiffFile, GitLabInstance, ReviewDetail, ReviewRun } from '@hunkwise/contracts';
import { api, ApiError } from './api.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; reviews: ReviewRun[]; instances: GitLabInstance[] }
  | { kind: 'error'; message: string };

const Icon = ({ children }: { children: React.ReactNode }) => <span className="icon" aria-hidden="true">{children}</span>;

function Header({ onHome }: { onHome: () => void }) {
  return <header className="topbar">
    <button className="brand" onClick={onHome} aria-label="Hunkwise home">
      <span className="brand-mark"><i /><i /><i /></span>
      <span>Hunkwise</span>
    </button>
    <nav aria-label="Main navigation">
      <button onClick={onHome}>Reviews</button>
      <a href="https://docs.gitlab.com/ee/user/project/merge_requests/" target="_blank" rel="noreferrer">GitLab docs ↗</a>
    </nav>
    <div className="self-hosted"><span /> Self-hosted</div>
  </header>;
}

function StatusPill({ status }: { status: ReviewRun['status'] }) {
  return <span className={`status status-${status}`}><i />{status}</span>;
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
    {state.kind === 'error' && <div className="state-card error-state">
      <Icon>!</Icon><div><strong>Reviews could not be loaded</strong><p>{state.message}</p></div>
    </div>}
    {state.kind === 'ready' && state.reviews.length === 0 && <div className="state-card empty-state">
      <Icon>⌁</Icon><div><strong>No reviews yet</strong><p>Submit an open GitLab merge request to create the first review.</p></div>
    </div>}
    {state.kind === 'ready' && state.reviews.length > 0 && <div className="review-list">
      {state.reviews.map((review) => <button key={review.id} className="review-row" onClick={() => onSelect(review)}>
        <span className="review-avatar">MR</span>
        <span><strong>Review {review.id.slice(0, 8)}</strong><small>{review.sourceSha.slice(0, 9)} · {new Date(review.createdAt).toLocaleDateString()}</small></span>
        <StatusPill status={review.status} />
        <span className="row-arrow">→</span>
      </button>)}
    </div>}
  </section>;
}

function Landing({ state, onSelect, onPreview }: { state: LoadState; onSelect: (review: ReviewRun) => void; onPreview: () => void }) {
  const [url, setUrl] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [submission, setSubmission] = useState<{ kind: 'idle' | 'loading' | 'error'; message?: string }>({ kind: 'idle' });
  const instances = state.kind === 'ready' ? state.instances : [];
  useEffect(() => {
    if (!instanceId && instances[0]) setInstanceId(instances[0].id);
  }, [instanceId, instances]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!instanceId) {
      setSubmission({ kind: 'error', message: 'Add a GitLab instance through the API before submitting a review.' });
      return;
    }
    setSubmission({ kind: 'loading' });
    try {
      await api.submit({ instanceId, mergeRequestUrl: url });
      setSubmission({ kind: 'idle' });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'The review could not be submitted.';
      setSubmission({ kind: 'error', message });
    }
  };

  return <main>
    <section className="hero">
      <div className="announcement"><span>01</span> Foundation ready <i /> GitLab execution arrives in Slice 2</div>
      <div className="hero-grid">
        <div>
          <p className="eyebrow">Structured code intelligence</p>
          <h1>Understand the change.<br /><em>Review the intent.</em></h1>
          <p className="hero-copy">A focused, self-hosted review workspace that turns GitLab diffs into clear decisions, grounded findings, and useful conversations.</p>
        </div>
        <div className="metrics" aria-label="Product qualities">
          <div><strong>01</strong><span>Your infrastructure</span></div>
          <div><strong>02</strong><span>Traceable findings</span></div>
          <div><strong>03</strong><span>Review context</span></div>
        </div>
      </div>
      <form className="submit-card" onSubmit={(event) => void submit(event)}>
        <div className="submit-label"><span>Start a review</span><small>Paste an open merge request URL</small></div>
        <div className="submit-controls">
          {instances.length > 1 && <select aria-label="GitLab instance" value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>
            {instances.map((instance) => <option value={instance.id} key={instance.id}>{instance.name}</option>)}
          </select>}
          <label className="url-field">
            <Icon>↗</Icon>
            <input aria-label="Merge request URL" required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://gitlab.example.com/group/project/-/merge_requests/42" />
          </label>
          <button className="primary" disabled={submission.kind === 'loading'}>{submission.kind === 'loading' ? 'Checking…' : 'Review MR'} <span>→</span></button>
        </div>
        {submission.kind === 'error' && <p className="form-error" role="alert">{submission.message}</p>}
        <div className="form-meta"><span><i /> Tokens encrypted at rest</span><button type="button" onClick={onPreview}>Explore the review shell →</button></div>
      </form>
    </section>
    <RecentReviews state={state} onSelect={onSelect} />
  </main>;
}

type DetailState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; detail: ReviewDetail } | { kind: 'preview' };
type MobilePane = 'files' | 'diff' | 'activity';

const PanelState = ({ title, body, error = false }: { title: string; body: string; error?: boolean }) =>
  <div className={`panel-state${error ? ' panel-error' : ''}`}><Icon>{error ? '!' : '⌁'}</Icon><strong>{title}</strong><p>{body}</p></div>;

function ReviewShell({ reviewId, onBack }: { reviewId?: string; onBack: () => void }) {
  const [state, setState] = useState<DetailState>(reviewId ? { kind: 'loading' } : { kind: 'preview' });
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [activityTab, setActivityTab] = useState<'findings' | 'chat'>('findings');
  const [mobilePane, setMobilePane] = useState<MobilePane>('diff');
  useEffect(() => {
    if (!reviewId) return;
    let active = true;
    setState({ kind: 'loading' });
    void api.review(reviewId).then((detail) => {
      if (!active) return;
      setState({ kind: 'ready', detail });
      setSelectedFileId(detail.files[0]?.id ?? null);
    }).catch((error: unknown) => {
      if (active) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
    });
    return () => { active = false; };
  }, [reviewId]);

  const detail = state.kind === 'ready' ? state.detail : null;
  const selectedFile: DiffFile | undefined = detail?.files.find((file) => file.id === selectedFileId);
  const selectedHunks = selectedFile ? detail?.hunks.filter((hunk) => hunk.diffFileId === selectedFile.id) ?? [] : [];
  const title = detail ? `Review ${detail.run.id.slice(0, 8)}` : reviewId ? 'Loading review…' : 'Review workspace';
  return <main className="shell-page">
    <div className="shell-header">
      <button className="back" onClick={onBack}>← All reviews</button>
      <div><span className="eyebrow">Persisted review data</span><h1>{title}</h1></div>
      <div className="shell-meta">{detail && <><StatusPill status={detail.run.status} /><span>{detail.files.length} files</span><span>{detail.findings.length} findings</span></>}</div>
    </div>
    <nav className="mobile-tabs" aria-label="Review workspace panels">
      {(['files', 'diff', 'activity'] as const).map((pane) => <button key={pane} className={mobilePane === pane ? 'active' : ''} onClick={() => setMobilePane(pane)}>{pane === 'activity' ? 'Findings & chat' : pane}</button>)}
    </nav>
    <div className="review-shell">
      <aside className={`files-panel${mobilePane === 'files' ? ' mobile-active' : ''}`}>
        <div className="panel-title"><span>Changed files</span><small>{detail?.files.length ?? 0}</small></div>
        <div className="file-filter">⌕ <span>Filter files</span></div>
        {state.kind === 'loading' && <PanelState title="Loading files" body="Fetching persisted review detail…" />}
        {state.kind === 'error' && <PanelState error title="Files unavailable" body={state.message} />}
        {(state.kind === 'preview' || (detail && detail.files.length === 0)) && <PanelState title="No changed files" body={state.kind === 'preview' ? 'Select a persisted review to inspect its files.' : 'No diff files have been stored for this run yet.'} />}
        {detail?.files.map((file) => <button className={file.id === selectedFileId ? 'active' : ''} onClick={() => { setSelectedFileId(file.id); setMobilePane('diff'); }} key={file.id}><span>{file.status.slice(0, 1).toUpperCase()}</span><span>{file.newPath}</span><small>+{file.additions} −{file.deletions}</small></button>)}
      </aside>
      <section className={`diff-panel${mobilePane === 'diff' ? ' mobile-active' : ''}`}>
        <div className="diff-toolbar"><span>{selectedFile?.newPath ?? 'Diff'}</span><div><span className="quiet">Persisted patch</span></div></div>
        {state.kind === 'loading' && <PanelState title="Loading review" body="Fetching run, diffs, findings, and messages…" />}
        {state.kind === 'error' && <PanelState error title="Review unavailable" body={state.message} />}
        {state.kind === 'preview' && <PanelState title="No review selected" body="This shell displays only data returned by the review detail API." />}
        {detail && !selectedFile && <PanelState title="No diff available" body="This review run does not have any persisted diff files yet." />}
        {selectedFile && selectedHunks.length === 0 && <PanelState title="No hunks available" body="The file exists, but no persisted hunks are available." />}
        {selectedHunks.map((hunk) => <div className="persisted-hunk" key={hunk.id}><div className="hunk-title">{hunk.header}</div><pre>{hunk.patch}</pre></div>)}
      </section>
      <aside className={`activity-panel${mobilePane === 'activity' ? ' mobile-active' : ''}`}>
        <div className="activity-tabs"><button className={activityTab === 'findings' ? 'active' : ''} onClick={() => setActivityTab('findings')}>Findings <span>{detail?.findings.length ?? 0}</span></button><button className={activityTab === 'chat' ? 'active' : ''} onClick={() => setActivityTab('chat')}>Chat <span>{detail?.chatMessages.length ?? 0}</span></button></div>
        <div className="summary-block"><span className="eyebrow">Review summary</span><h3>{detail ? `${detail.run.status[0]?.toUpperCase()}${detail.run.status.slice(1)} run` : 'No review loaded'}</h3><p>{detail?.run.summary ?? 'A summary has not been generated for this review run.'}</p></div>
        {activityTab === 'findings' && <div className="finding-list">
          {state.kind === 'loading' && <PanelState title="Loading findings" body="Fetching persisted findings…" />}
          {state.kind === 'error' && <PanelState error title="Findings unavailable" body={state.message} />}
          {(state.kind === 'preview' || (detail && detail.findings.length === 0)) && <PanelState title="No findings" body={state.kind === 'preview' ? 'Select a review to inspect findings.' : 'No findings have been persisted for this run.'} />}
          {detail?.findings.map((finding) => <div className="finding-row" key={finding.id}><i className={finding.severity} /><span><strong>{finding.title}</strong><small>{finding.filePath}{finding.line ? ` · L${finding.line}` : ''}</small><p>{finding.body}</p></span></div>)}
        </div>}
        {activityTab === 'chat' && <div className="chat-history">
          {detail?.chatMessages.map((message) => <div className={`chat-message ${message.role}`} key={message.id}><strong>{message.role}</strong><p>{message.content}</p></div>)}
          {(state.kind !== 'ready' || (detail?.chatMessages.length ?? 0) === 0) && <PanelState title="No chat messages" body="No chat messages have been persisted for this run." />}
        </div>}
        <div className="chat-box"><textarea aria-label="Ask about this review" disabled placeholder="Chat arrives in a later slice" /><button aria-label="Send message" disabled>↑</button><small>Read-only in Slice 1</small></div>
      </aside>
    </div>
  </main>;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selected, setSelected] = useState<{ kind: 'review'; id: string } | { kind: 'preview' } | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([api.reviews(), api.instances()]).then(([reviews, instances]) => {
      if (active) setState({ kind: 'ready', reviews: reviews.items, instances });
    }).catch((error: unknown) => {
      if (active) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
    });
    return () => { active = false; };
  }, []);
  return <div className="app">
    <Header onHome={() => setSelected(null)} />
    {selected ? <ReviewShell {...(selected.kind === 'review' ? { reviewId: selected.id } : {})} onBack={() => setSelected(null)} /> :
      <Landing state={state} onSelect={(review) => setSelected({ kind: 'review', id: review.id })} onPreview={() => setSelected({ kind: 'preview' })} />}
  </div>;
}
