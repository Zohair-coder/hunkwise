import { useEffect, useState, type FormEvent } from 'react';
import type { GitLabInstance, ReviewRun } from '@hunkwise/contracts';
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

const exampleFiles = [
  { name: 'src/auth/session.ts', value: '+38 −12', active: true },
  { name: 'src/api/reviews.ts', value: '+24 −4' },
  { name: 'test/session.test.ts', value: '+61 −0' },
  { name: 'package.json', value: '+2 −2' }
];

function ReviewShell({ review, onBack }: { review?: ReviewRun; onBack: () => void }) {
  const status = review?.status ?? 'running';
  return <main className="shell-page">
    <div className="shell-header">
      <button className="back" onClick={onBack}>← All reviews</button>
      <div><span className="eyebrow">group / project</span><h1>Harden session token validation</h1></div>
      <div className="shell-meta"><StatusPill status={status} /><span>MR !42</span><span>8 files</span></div>
    </div>
    <div className="review-shell">
      <aside className="files-panel">
        <div className="panel-title"><span>Changed files</span><small>8</small></div>
        <div className="file-filter">⌕ <span>Filter files</span></div>
        {exampleFiles.map((file) => <button className={file.active ? 'active' : ''} key={file.name}><span>TS</span><span>{file.name}</span><small>{file.value}</small></button>)}
      </aside>
      <section className="diff-panel">
        <div className="diff-toolbar"><span>src/auth/session.ts</span><div><button>Unified</button><button>⋯</button></div></div>
        <div className="hunk-title">@@ -18,8 +18,12 @@ export function verifySession(token: string)</div>
        <div className="code-line neutral"><b>18</b><b>18</b><code>const payload = decode(token)</code></div>
        <div className="code-line removed"><b>19</b><b></b><code>- if (!payload) return null</code></div>
        <div className="code-line added"><b></b><b>19</b><code>+ if (!payload || payload.expiresAt &lt; Date.now()) &#123;</code></div>
        <div className="code-line added"><b></b><b>20</b><code>+   return null</code></div>
        <div className="code-line added"><b></b><b>21</b><code>+ &#125;</code></div>
        <div className="finding-card">
          <div><span className="finding-severity">High confidence</span><small>Security · line 19</small></div>
          <strong>Validate the token signature before trusting claims</strong>
          <p>The expiration guard is useful, but decoded claims remain attacker-controlled until signature verification succeeds.</p>
          <div><button>Dismiss</button><button>Discuss finding</button></div>
        </div>
        <div className="code-line neutral"><b>20</b><b>23</b><code>return payload</code></div>
      </section>
      <aside className="activity-panel">
        <div className="activity-tabs"><button className="active">Findings <span>3</span></button><button>Chat</button></div>
        <div className="summary-block"><span className="eyebrow">Review summary</span><h3>One issue needs attention</h3><p>Session handling is clearer, but verification order can allow untrusted claims into the request path.</p></div>
        <div className="finding-list">
          <button className="selected"><i className="critical" /><span><strong>Unverified token claims</strong><small>session.ts · L19</small></span><em>→</em></button>
          <button><i /><span><strong>Missing negative test</strong><small>session.test.ts · L44</small></span><em>→</em></button>
          <button><i className="info" /><span><strong>Error context is dropped</strong><small>reviews.ts · L78</small></span><em>→</em></button>
        </div>
        <div className="chat-box"><textarea aria-label="Ask about this review" placeholder="Ask about the diff…" /><button aria-label="Send message">↑</button><small>Grounded in this merge request</small></div>
      </aside>
    </div>
  </main>;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selected, setSelected] = useState<ReviewRun | 'preview' | null>(null);
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
    {selected ? <ReviewShell {...(selected === 'preview' ? {} : { review: selected })} onBack={() => setSelected(null)} /> :
      <Landing state={state} onSelect={setSelected} onPreview={() => setSelected('preview')} />}
  </div>;
}
