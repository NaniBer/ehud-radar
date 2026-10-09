import { useCallback, useEffect, useRef, useState } from 'react';
import { categories, categoryLabel, ProspectError, prospectRequest, safeHttpUrl, type Prospect, type ProspectFields, type ProspectList } from './api';
import { ProspectForm } from './ProspectForm';
import { WorkspaceNavigation } from '../WorkspaceNavigation';
import { OutreachPanel } from '../outreach/OutreachPanel';

type Route = { id: string | null; mode: 'directory' | 'view' | 'outreach' | 'edit' | 'new' };
function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('prospect');
  return params.get('new') === 'prospect' ? { id: null, mode: 'new' } : { id, mode: id ? params.get('panel')==='outreach'?'outreach':'view' : 'directory' };
}
function formattedDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)); }
function displayHost(value: string) { try { return new URL(value).hostname; } catch { return value; } }

export function ProspectsWorkspace({ csrfToken, username, onSessionExpired, onLogout, logoutBusy, logoutError }: {
  csrfToken: string; username: string; onSessionExpired: () => void; onLogout: () => void; logoutBusy: boolean; logoutError: string;
}) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ProspectList | null>(null);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState('');
  const [prospect, setProspect] = useState<Prospect | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [pendingLeave, setPendingLeave] = useState<{ action: () => void } | null>(null);
  const dirty = useRef(false);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const activeUrl = useRef(window.location.href);
  const mounted = useRef(true);
  const onDirty = useCallback((value: boolean) => { dirty.current = value; }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof ProspectError && cause.status === 401) onSessionExpired();
    return cause instanceof Error ? cause.message : 'Could not complete the request. Try again.';
  }, [onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController();
    setListBusy(true); setListError('');
    const params = new URLSearchParams({ q: debouncedQuery, category, page: String(page), pageSize: '25' });
    void prospectRequest<ProspectList>(`?${params}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (page > lastPage) { setPage(lastPage); return; }
      setList(result);
    }).catch((cause) => { if (!controller.signal.aborted) setListError(handleError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setListBusy(false); });
    return () => controller.abort();
  }, [debouncedQuery, category, page, refresh, handleError]);

  useEffect(() => {
    if (!route.id) { setProspect(null); setProfileError(''); setProfileBusy(false); return; }
    const controller = new AbortController();
    setProfileBusy(true); setProfileError(''); setProspect(null);
    void prospectRequest<{ prospect: Prospect }>(`/${encodeURIComponent(route.id)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setProspect(result.prospect); })
      .catch((cause) => { if (!controller.signal.aborted) setProfileError(handleError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setProfileBusy(false); });
    return () => controller.abort();
  }, [route.id, profileRefresh, handleError]);

  const requestLeave = useCallback((action: () => void) => {
    if (dirty.current) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingLeave({ action });
    } else { setPendingLeave(null); action(); }
  }, []);
  useEffect(() => { if (pendingLeave) keepEditingButton.current?.focus(); }, [pendingLeave]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); } };
    const popState = () => {
      const nextUrl = window.location.href;
      const nextRoute = readRoute();
      if (dirty.current) window.history.pushState(null, '', activeUrl.current);
      requestLeave(() => {
        dirty.current = false; window.history.replaceState(null, '', nextUrl);
        activeUrl.current = nextUrl; setRoute(nextRoute); setSaveError(''); setConflict(false); setNotice('');
      });
    };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('popstate', popState);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('popstate', popState); };
  }, [requestLeave]);

  function navigate(next: Route, replace = false) {
    requestLeave(() => {
      dirty.current = false;
      const url = new URL(window.location.href); url.searchParams.delete('prospect'); url.searchParams.delete('new'); url.searchParams.delete('panel');
      if (next.id) url.searchParams.set('prospect', next.id);
      if (next.mode === 'outreach') url.searchParams.set('panel','outreach');
      if (next.mode === 'new') url.searchParams.set('new', 'prospect');
      window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
      activeUrl.current = url.href; setRoute(next); setSaveError(''); setConflict(false); setNotice('');
    });
  }

  async function save(fields: ProspectFields, version?: number) {
    if (saveBusy) return;
    setSaveBusy(true); setSaveError(''); setConflict(false);
    try {
      const editing = route.mode === 'edit' && route.id;
      const result = await prospectRequest<{ prospect: Prospect }>(editing ? `/${encodeURIComponent(route.id!)}` : '', {
        method: editing ? 'PUT' : 'POST', body: editing ? { ...fields, version } : fields, csrfToken,
      });
      if (!mounted.current) return;
      dirty.current = false; navigate({ id: result.prospect.id, mode: 'view' }, true);
      setProspect(result.prospect); setRefresh((value) => value + 1);
      setNotice(editing ? 'Changes saved.' : 'Prospect saved.');
    } catch (cause) {
      if (!mounted.current) return;
      setSaveError(handleError(cause));
      setConflict(!!route.id && cause instanceof ProspectError && cause.status === 409 && /version|changed|stale|updated|conflict|out.of.date/i.test(cause.message));
    } finally { if (mounted.current) setSaveBusy(false); }
  }

  function reloadSaved() {
    requestLeave(() => {
      dirty.current = false; setSaveError(''); setConflict(false); setProfileRefresh((value) => value + 1);
    });
  }
  const isForm = route.mode === 'new' || route.mode === 'edit';
  const hasFilters = !!query.trim() || !!category;
  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return <main className="workspace-main prospects-workspace">
    <div className="workspace-account"><span>Shared workspace · {username}</span><button className="link-button" disabled={logoutBusy || saveBusy} onClick={() => requestLeave(onLogout)}>{logoutBusy ? 'Signing out…' : 'Sign out'}</button></div>
    {logoutError && <p className="error-message" role="alert">{logoutError}</p>}
    <WorkspaceNavigation active="prospects" onNavigate={() => requestLeave(() => { dirty.current = false; window.location.assign('/?view=discovery'); })} />
    {pendingLeave && <section className="discard-confirmation" aria-labelledby="discard-heading">
      <h2 id="discard-heading">Keep your changes?</h2><p id="discard-description">You have unsaved changes. Continuing will discard them.</p>
      <div><button className="text-button" ref={keepEditingButton} aria-describedby="discard-description" onClick={() => { setPendingLeave(null); previousFocus.current?.focus(); }}>Keep editing</button><button className="text-button" onClick={() => { const action = pendingLeave.action; dirty.current = false; setPendingLeave(null); action(); }}>Discard changes</button></div>
    </section>}
    {route.mode !== 'directory' && <button className="back-button" disabled={saveBusy} onClick={() => navigate({ id: null, mode: 'directory' })}>Back to prospects</button>}
    <div className="prospects-heading"><div><h1>{route.mode === 'directory' ? 'Prospects' : route.mode === 'new' ? 'Add a prospect' : route.mode === 'edit' ? 'Edit prospect' : prospect?.name || 'Prospect'}</h1>{route.mode === 'directory' && <p className="intro">The people and organizations worth a conversation.</p>}{(route.mode === 'view'||route.mode==='outreach') && prospect && <p className="profile-subtitle">{categoryLabel(prospect.category)}{prospect.location ? ` · ${prospect.location}` : ''}</p>}</div>
      {route.mode === 'directory' && <button className="primary-button compact-button" onClick={() => navigate({ id: null, mode: 'new' })}>Add prospect</button>}
      {(route.mode === 'view'||route.mode==='outreach') && prospect && <button className="text-button" onClick={() => requestLeave(() => { dirty.current=false; setRoute((current) => ({ ...current, mode: 'edit' })); setNotice(''); })}>Edit prospect</button>}
    </div>
    {notice && <p className="save-notice" role="status">{notice}</p>}
    {prospect&&!profileBusy&&(route.mode==='view'||route.mode==='outreach')&&<nav className="prospect-panel-navigation" aria-label="Prospect sections"><button aria-current={route.mode==='view'?'page':undefined} onClick={()=>navigate({id:prospect.id,mode:'view'})}>Overview & sources</button><button aria-current={route.mode==='outreach'?'page':undefined} onClick={()=>navigate({id:prospect.id,mode:'outreach'})}>Research & outreach</button></nav>}
    {route.mode === 'directory' ? <>
      <div className="directory-toolbar"><div className="directory-search"><label htmlFor="prospect-search">Search prospects</label><input id="prospect-search" type="search" placeholder="Search names, contacts, or locations" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} maxLength={200} /></div><div className="directory-filter"><label htmlFor="category-filter">Category</label><select id="category-filter" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">All categories</option>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <div className="directory-caption" role="status">{listBusy ? 'Loading prospects…' : listError ? 'Directory unavailable' : `${list?.total || 0} ${list?.total === 1 ? 'prospect' : 'prospects'}${hasFilters ? ' matching your filters' : ' saved'}`}</div>
      {listError ? <div className="directory-state"><h2>Could not load prospects</h2><p className="error-message" role="alert">{listError}</p><button className="text-button" onClick={() => setRefresh((value) => value + 1)}>Try again</button></div> : listBusy ? <div className="directory-state loading-state"><p>Opening your directory…</p></div> : list?.prospects.length ? <>
        <p className="table-scroll-help">Scroll the directory to see contact details.</p>
        <div className="prospect-table-container" tabIndex={0} role="region" aria-label="Saved prospects"><table className="prospect-table"><thead><tr><th scope="col">Prospect</th><th scope="col">Category</th><th scope="col">Contact</th><th scope="col">Updated</th></tr></thead><tbody>{list.prospects.map((item) => <tr key={item.id}><td><button className="prospect-name-button" onClick={() => navigate({ id: item.id, mode: 'view' })}>{item.name}</button><span className="table-secondary">{item.location || (item.website ? displayHost(item.website) : 'Location not added')}</span></td><td>{categoryLabel(item.category)}</td><td><span className="contact-value">{item.contactName || item.email || item.phone || 'No contact added'}</span>{item.contactName && (item.email || item.phone) && <span className="table-secondary">{item.email || item.phone}</span>}</td><td className="table-date">{formattedDate(item.updatedAt)}</td></tr>)}</tbody></table></div>
        {totalPages > 1 && <nav className="pagination" aria-label="Prospect pages"><span>Page {page} of {totalPages}</span><div><button className="text-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="text-button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</button></div></nav>}
      </> : <section className="directory-state"><h2>{hasFilters ? 'No matching prospects' : 'Start with someone worth knowing.'}</h2><p>{hasFilters ? 'Try a different name or category to find a saved prospect.' : 'Add your first prospect with their contact details and the sources that make them relevant to Ehud.'}</p>{hasFilters ? <button className="text-button" onClick={() => { setQuery(''); setCategory(''); setPage(1); }}>Clear filters</button> : <button className="text-button" onClick={() => navigate({ id: null, mode: 'new' })}>Add your first prospect</button>}</section>}
    </> : profileBusy ? <div className="directory-state" role="status"><p>Loading this prospect…</p></div> : profileError ? <div className="directory-state"><h2>Could not open this prospect</h2><p className="error-message" role="alert">{profileError}</p><button className="text-button" onClick={() => setProfileRefresh((value) => value + 1)}>Try again</button></div> : isForm ? <ProspectForm key={prospect ? `${prospect.id}-${prospect.version}-${profileRefresh}` : 'new'} prospect={route.mode === 'edit' ? prospect || undefined : undefined} busy={saveBusy} error={saveError} conflict={conflict} onSave={save} onCancel={() => navigate({ id: route.id, mode: route.id ? 'view' : 'directory' })} onReload={reloadSaved} onDirty={onDirty} /> : prospect ? route.mode==='outreach'?<OutreachPanel key={prospect.id} prospect={prospect} csrfToken={csrfToken} onSessionExpired={onSessionExpired} onDirty={onDirty} onEditProspect={()=>requestLeave(()=>{dirty.current=false;setRoute(current=>({...current,mode:'edit'}));})} onReviewEvidence={()=>navigate({id:prospect.id,mode:'view'})}/>:<ProspectProfile prospect={prospect} /> : null}
  </main>;
}

function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  const safe = safeHttpUrl(url);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}
function ProspectProfile({ prospect }: { prospect: Prospect }) {
  return <div className="prospect-profile">
    <aside className="profile-contact"><h2>Contact & details</h2><dl>
      <div><dt>Website</dt><dd>{prospect.website ? <ExternalLink url={prospect.website}>{displayHost(prospect.website)}</ExternalLink> : 'Not added'}</dd></div>
      <div><dt>Contact name</dt><dd>{prospect.contactName || 'Not added'}</dd></div><div><dt>Email</dt><dd>{prospect.email || 'Not added'}</dd></div><div><dt>Phone</dt><dd>{prospect.phone || 'Not added'}</dd></div><div><dt>Location</dt><dd>{prospect.location || 'Not added'}</dd></div>
    </dl><p className="record-dates">Added {formattedDate(prospect.createdAt)}<br />Updated {formattedDate(prospect.updatedAt)}</p></aside>
    <div className="profile-evidence"><section><h2>Relevance to Ehud</h2><p className={prospect.relevance ? 'preserve-lines' : 'missing-text'}>{prospect.relevance || 'No relevance added yet. Edit this prospect to explain why they could be a customer or partner.'}</p></section>
      <section><h2>Sources <span className="source-count">{prospect.sources.length}</span></h2>{prospect.sources.length ? <ul className="source-list">{prospect.sources.map((source, index) => <li key={`${source.url}-${index}`}><ExternalLink url={source.url}>{source.title || displayHost(source.url)}</ExternalLink>{source.title && <span className="source-host">{displayHost(source.url)}</span>}{source.note && <p className="preserve-lines">{source.note}</p>}</li>)}</ul> : <p className="missing-text">No sources added yet. Save links to their work or services so your team can review the evidence.</p>}</section>
      <section><h2>Team notes</h2><p className={prospect.notes ? 'preserve-lines' : 'missing-text'}>{prospect.notes || 'No notes added yet.'}</p></section>
    </div>
  </div>;
}
