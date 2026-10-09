import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { WorkspaceNavigation } from '../WorkspaceNavigation';
import { categories, categoryLabel, ProspectError, safeHttpUrl, type Category, type Prospect, type ProspectFields } from '../prospects/api';
import { ProspectForm } from '../prospects/ProspectForm';
import { discoveryRequest, type Candidate, type DiscoveryState, type History, type RunDetail } from './api';

const readRun = () => new URLSearchParams(window.location.search).get('run');
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

export function DiscoveryWorkspace({ csrfToken, username, onSessionExpired, onLogout, logoutBusy, logoutError }: {
  csrfToken: string; username: string; onSessionExpired: () => void; onLogout: () => void; logoutBusy: boolean; logoutError: string;
}) {
  const [connection, setConnection] = useState<DiscoveryState|null>(null);
  const [history, setHistory] = useState<History|null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(true);
  const [runId, setRunId] = useState(readRun);
  const [detail, setDetail] = useState<RunDetail|null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [category, setCategory] = useState<Category>('production_company');
  const [location, setLocation] = useState('Ethiopia');
  const [keywords, setKeywords] = useState('');
  const [limit, setLimit] = useState(5);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [review, setReview] = useState<Candidate|null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [candidateBusy, setCandidateBusy] = useState<{id:string;action:'assess'|'dismiss'}|null>(null);
  const [candidateError, setCandidateError] = useState<{id:string;message:string}|null>(null);
  const [notice, setNotice] = useState<{message:string;prospectId:string}|null>(null);
  const [pendingLeave, setPendingLeave] = useState<{action:()=>void}|null>(null);
  const dirty = useRef(false);
  const mounted = useRef(true);
  const activeUrl = useRef(window.location.href);
  const keepButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement|null>(null);
  const onDirty = useCallback((value:boolean) => { dirty.current=value; },[]);
  const handleError = useCallback((error:unknown) => {
    if (error instanceof ProspectError && error.status===401) onSessionExpired();
    return error instanceof Error ? error.message : 'Discovery is unavailable. Try again.';
  },[onSessionExpired]);
  const requestLeave = useCallback((action:()=>void) => {
    if (dirty.current) {
      previousFocus.current=document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingLeave({action});
    } else { setPendingLeave(null); action(); }
  },[]);
  useEffect(() => { mounted.current=true; return () => {mounted.current=false;}; },[]);
  useEffect(() => { if(pendingLeave) keepButton.current?.focus(); },[pendingLeave]);
  useEffect(() => {
    const unload=(event:BeforeUnloadEvent) => {if(dirty.current) event.preventDefault();};
    const pop=()=>{
      const nextUrl=window.location.href; const nextRun=readRun();
      if(dirty.current) window.history.pushState(null,'',activeUrl.current);
      requestLeave(()=>{dirty.current=false;window.history.replaceState(null,'',nextUrl);activeUrl.current=nextUrl;setRunId(nextRun);setReview(null);setNotice(null);});
    };
    window.addEventListener('popstate',pop);window.addEventListener('beforeunload',unload);
    return ()=>{window.removeEventListener('popstate',pop);window.removeEventListener('beforeunload',unload);};
  },[requestLeave]);
  useEffect(()=>{
    const controller=new AbortController();setHistoryBusy(true);setHistoryError('');
    void Promise.all([
      discoveryRequest<DiscoveryState>('/state',{signal:controller.signal}),
      discoveryRequest<History>(`/runs?page=${page}`,{signal:controller.signal}),
    ]).then(([state,list])=>{if(!controller.signal.aborted){setConnection(state);setHistory(list);}})
      .catch(error=>{if(!controller.signal.aborted)setHistoryError(handleError(error));})
      .finally(()=>{if(!controller.signal.aborted)setHistoryBusy(false);});
    return ()=>controller.abort();
  },[page,refresh,handleError]);
  useEffect(()=>{
    if(!runId){setDetail(null);setDetailError('');return;}
    const controller=new AbortController();let timer:number|undefined;
    setDetailBusy(true);setDetailError('');setDetail(null);
    const load=async()=>{
      try{
        const result=await discoveryRequest<RunDetail>(`/runs/${encodeURIComponent(runId)}`,{signal:controller.signal});
        if(controller.signal.aborted)return;
        setDetail(result);setDetailBusy(false);
        if(result.run.status==='running'||result.candidates.some(item=>item.assessmentStatus==='running'))timer=window.setTimeout(()=>void load(),2500);
      }catch(error){if(!controller.signal.aborted){setDetailError(handleError(error));setDetailBusy(false);}}
    };
    void load();return ()=>{controller.abort();window.clearTimeout(timer);};
  },[runId,handleError]);

  function openRun(id:string){requestLeave(()=>{
    dirty.current=false;setReview(null);setNotice(null);setCandidateError(null);
    const url=new URL(window.location.href);url.searchParams.set('view','discovery');url.searchParams.set('run',id);
    window.history.pushState(null,'',url);activeUrl.current=url.href;setRunId(id);
  });}
  async function search(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(searchBusy||saveBusy||!connection?.searchReady)return;
    setSearchBusy(true);setSearchError('');setNotice(null);
    const requestId=crypto.randomUUID();
    try{
      const result=await discoveryRequest<RunDetail>('/runs',{body:{requestId,category,location,keywords,limit},csrfToken});
      if(!mounted.current)return;
      openRun(result.run.id);setDetail(result);setPage(1);setRefresh(value=>value+1);
    }catch(error){if(mounted.current){setSearchError(handleError(error));setRefresh(value=>value+1);}}
    finally{if(mounted.current)setSearchBusy(false);}
  }
  function updateCandidate(item:Candidate){setDetail(current=>current?{...current,candidates:current.candidates.map(candidate=>candidate.id===item.id?item:candidate)}:null);}
  async function candidateAction(item:Candidate,action:'assess'|'dismiss'){
    if(candidateBusy)return;setCandidateBusy({id:item.id,action});setCandidateError(null);
    try{
      const result=await discoveryRequest<{candidate:Candidate}>(`/candidates/${item.id}/${action}`,{
        body:action==='dismiss'?{dismissed:!item.dismissed}:{},csrfToken});
      if(mounted.current){updateCandidate(result.candidate);setRefresh(value=>value+1);}
    }catch(error){if(mounted.current)setCandidateError({id:item.id,message:handleError(error)});}
    finally{if(mounted.current)setCandidateBusy(null);}
  }
  async function save(fields:ProspectFields){
    if(!review||saveBusy)return;setSaveBusy(true);setSaveError('');
    try{
      const result=await discoveryRequest<{prospect:Prospect;existing:boolean}>(`/candidates/${review.id}/save`,{body:{fields},csrfToken});
      if(!mounted.current)return;
      dirty.current=false;updateCandidate({...review,savedProspectId:result.prospect.id,dismissed:false});setReview(null);
      setNotice({message:result.existing?'Already in prospects. The existing record was kept.':'Saved to prospects with the original source evidence.',prospectId:result.prospect.id});
      setRefresh(value=>value+1);
    }catch(error){if(mounted.current)setSaveError(handleError(error));}
    finally{if(mounted.current)setSaveBusy(false);}
  }
  const initialFields:ProspectFields|undefined=review?{
    name:review.assessment?.name||review.title,category:detail?.run.category||'other',website:review.url,
    contactName:'',email:'',phone:'',location:'',notes:'',relevance:review.assessment?.relevance||'',
    sources:[{title:review.title,url:review.url,note:review.snippet.slice(0,1000)}],
  }:undefined;
  const visibleCandidates=detail?.candidates.filter(item=>showDismissed||!item.dismissed)||[];

  return <main className="workspace-main discovery-workspace">
    <div className="workspace-account"><span>Shared workspace · {username}</span><button className="link-button" disabled={logoutBusy||saveBusy} onClick={()=>requestLeave(onLogout)}>{logoutBusy?'Signing out…':'Sign out'}</button></div>
    {logoutError&&<p className="error-message" role="alert">{logoutError}</p>}
    <WorkspaceNavigation active="discovery" onNavigate={()=>requestLeave(()=>{dirty.current=false;window.location.assign('/');})}/>
    {pendingLeave&&<section className="discard-confirmation" aria-labelledby="discovery-discard-heading"><h2 id="discovery-discard-heading">Keep your changes?</h2><p>You have unsaved changes. Continuing will discard them.</p><div><button className="text-button" ref={keepButton} onClick={()=>{setPendingLeave(null);previousFocus.current?.focus();}}>Keep editing</button><button className="text-button" onClick={()=>{const action=pendingLeave.action;dirty.current=false;setPendingLeave(null);action();}}>Discard changes</button></div></section>}
    {review?<>
      <button className="back-button" disabled={saveBusy} onClick={()=>requestLeave(()=>{dirty.current=false;setReview(null);})}>Back to candidates</button>
      <h1>Review candidate</h1><p className="intro">Verify the name, category, and contact details before saving. Search location is a target, not a verified address.</p>
      <p className="review-source-note">The original search link and excerpt will stay attached as evidence.</p>
      <ProspectForm key={review.id} initialFields={initialFields} submitLabel="Save to prospects" busy={saveBusy} error={saveError} conflict={false} onSave={save} onCancel={()=>requestLeave(()=>{dirty.current=false;setReview(null);})} onReload={()=>{}} onDirty={onDirty}/>
    </>:<>
      <div className="prospects-heading"><div><h1>Discovery</h1><p className="intro">Find a promising lead. Check the source. Start a conversation.</p></div></div>
      {historyError&&<div className="error-message" role="alert"><p>{historyError}</p><button className="text-button" onClick={()=>setRefresh(value=>value+1)}>Try again</button></div>}
      {connection&&!connection.searchReady&&<section className="discovery-setup" aria-labelledby="search-setup-heading"><h2 id="search-setup-heading">Connect search to get started</h2><p>Add your {connection.searchProvider} key as <code>{connection.searchProvider==='Tavily'?'TAVILY_API_KEY':'SERPER_API_KEY'}</code> in the backend .env and restart the API. Your OpenRouter key powers optional fit assessments.</p><a href={connection.searchProvider==='Tavily'?'https://app.tavily.com':'https://serper.dev'} target="_blank" rel="noopener noreferrer">Get a {connection.searchProvider} key</a><button className="link-button" onClick={()=>setRefresh(value=>value+1)}>Check connection</button></section>}
      <form className="discovery-search-form" onSubmit={event=>void search(event)}>
        <fieldset disabled={searchBusy||historyBusy}><legend>Find candidates</legend><div className="discovery-search-fields">
          <div className="form-field"><label htmlFor="discovery-category">Category</label><select id="discovery-category" value={category} onChange={event=>setCategory(event.target.value as Category)}>{categories.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
          <div className="form-field"><label htmlFor="discovery-location">Target location</label><input id="discovery-location" required maxLength={200} value={location} onChange={event=>setLocation(event.target.value)}/></div>
          <div className="form-field"><label htmlFor="discovery-keywords">Keywords (optional)</label><input id="discovery-keywords" maxLength={200} placeholder="e.g. music videos, advertising" value={keywords} onChange={event=>setKeywords(event.target.value)}/></div>
          <div className="form-field"><label htmlFor="discovery-limit">Results</label><select id="discovery-limit" value={limit} onChange={event=>setLimit(Number(event.target.value))}><option value={5}>Up to 5</option><option value={10}>Up to 10</option></select></div>
        </div></fieldset>
        <div className="discovery-search-actions"><button type="submit" className="primary-button compact-button" disabled={searchBusy||historyBusy||!connection?.searchReady||!connection.searchesRemaining}>{searchBusy?'Searching the web…':'Find candidates'}</button><p className="field-help">{connection?.searchReady?`${connection.searchesRemaining} searches available. AI runs only when you ask.`:`Search needs a connected ${connection?.searchProvider||'provider'} key. You can review previous results below.`}</p></div>
      </form>
      {searchError&&<p role="alert" className="error-message">{searchError}</p>}
      {notice&&<p className="save-notice" role="status">{notice.message} <a href={`/?prospect=${notice.prospectId}`}>View prospect</a></p>}
      <div className="discovery-body"><section className="discovery-results" aria-label="Search results">
        {searchBusy?<div className="directory-state" role="status"><h2>Finding candidates…</h2><p>Your search will be saved in history. Refreshing this page won’t remove it.</p></div>:detailError?<div className="directory-state"><h2>Could not open this search</h2><p role="alert" className="error-message">{detailError}</p><button className="text-button" onClick={()=>{const id=runId;setRunId(null);window.setTimeout(()=>setRunId(id),0);}}>Try again</button></div>:detailBusy?<div className="directory-state" role="status"><p>Opening search results…</p></div>:detail?<>
          <div className="search-results-heading"><div><h2>{categoryLabel(detail.run.category)} · {detail.run.location}</h2><p>{detail.run.query}</p><p className="field-help">{date(detail.run.createdAt)} · {detail.run.provider} · {detail.candidates.length} {detail.candidates.length===1?'candidate':'candidates'}</p></div></div>
          {detail.run.status==='failed'?<p className="error-message" role="alert">{detail.run.error} Your search settings are saved; run a new search when ready.</p>:detail.run.status==='running'?<div className="directory-state" role="status"><p>This search is running. Results will appear here.</p></div>:<>
            {!!detail.candidates.some(item=>item.dismissed)&&<label className="dismissed-toggle"><input type="checkbox" checked={showDismissed} onChange={event=>setShowDismissed(event.target.checked)}/>Show dismissed candidates</label>}
            {visibleCandidates.length?visibleCandidates.map(item=><CandidateRow key={item.id} item={item} aiReady={!!connection?.aiReady} aiRemaining={connection?.assessmentsRemaining||0} busy={candidateBusy?.id===item.id} assessing={candidateBusy?.id===item.id&&candidateBusy.action==='assess'} actionsDisabled={!!candidateBusy} error={candidateError?.id===item.id?candidateError.message:''} onAssess={()=>void candidateAction(item,'assess')} onDismiss={()=>void candidateAction(item,'dismiss')} onReview={()=>{setSaveError('');setNotice(null);setReview(item);}}/>):<div className="directory-state"><h2>{detail.candidates.length?'All candidates are dismissed':'No candidates found'}</h2><p>{detail.candidates.length?'Show dismissed candidates to reconsider a source.':'Try broader keywords or a different location. This search is still saved in history.'}</p></div>}
          </>}
        </>:<div className="directory-state"><h2>Start with a focused search.</h2><p>Choose who you want to reach and where. Results stay here for review until you choose to save them as prospects.</p></div>}
      </section><aside className="discovery-history"><h2>Search history</h2>{historyBusy?<p role="status">Loading history…</p>:history?.runs.length?<>
        <ol>{history.runs.map(item=><li key={item.id}><button className="history-run-button" aria-current={item.id===runId?'true':undefined} disabled={searchBusy} onClick={()=>openRun(item.id)}><strong>{categoryLabel(item.category)} · {item.location}</strong>{item.keywords&&<span>{item.keywords}</span>}<span>{date(item.createdAt)}</span><span>{item.status==='completed'?`${item.candidateCount} found · ${item.savedCount} saved`:item.status==='failed'?'Search failed':'Searching…'}</span></button></li>)}</ol>
        {history.total>history.pageSize&&<nav className="pagination" aria-label="Search history pages"><button className="text-button" disabled={page<=1||searchBusy} onClick={()=>setPage(value=>value-1)}>Previous</button><span>Page {page}</span><button className="text-button" disabled={page*history.pageSize>=history.total||searchBusy} onClick={()=>setPage(value=>value+1)}>Next</button></nav>}
      </>:<p>No searches yet. Each search will appear here with its results and saved prospects.</p>}</aside></div>
    </>}
  </main>;
}

function CandidateRow({item,aiReady,aiRemaining,busy,assessing,actionsDisabled,error,onAssess,onDismiss,onReview}: {
  item:Candidate;aiReady:boolean;aiRemaining:number;busy:boolean;assessing:boolean;actionsDisabled:boolean;error:string;onAssess:()=>void;onDismiss:()=>void;onReview:()=>void;
}) {
  const savedId=item.savedProspectId||item.existingProspectId;
  const safeUrl=safeHttpUrl(item.url);
  return <article className={`discovery-candidate${item.dismissed?' candidate-dismissed':''}`}>
    <div className="candidate-title"><h3>{safeUrl?<a href={safeUrl} target="_blank" rel="noopener noreferrer">{item.title}</a>:item.title}</h3>{savedId&&<span className="candidate-saved">Already in prospects</span>}{item.dismissed&&<span>Dismissed</span>}</div>
    <p className="source-host">{host(item.url)}</p>
    {item.snippet?<><p className="candidate-excerpt">{item.snippet.slice(0,450)}{item.snippet.length>450?'…':''}</p>{item.snippet.length>450&&<details><summary>Read full excerpt</summary><p className="preserve-lines">{item.snippet}</p></details>}</>:<p className="missing-text">No excerpt was returned. Open the source before deciding.</p>}
    {item.assessment&&<section className="candidate-assessment" aria-label="AI fit assessment"><h4>AI fit assessment <span>{item.assessment.confidence} confidence</span></h4><p>{item.assessment.relevance}</p><details><summary>Evidence and what to verify</summary><ul>{item.assessment.evidenceQuotes.map((quote,index)=><li key={index}><q>{quote}</q></li>)}</ul>{item.assessment.caveats.length>0&&<><p>Needs verification:</p><ul>{item.assessment.caveats.map((caveat,index)=><li key={index}>{caveat}</li>)}</ul></>}</details></section>}
    {(error||item.assessmentError)&&<p className="error-message" role="alert">{error||item.assessmentError}</p>}
    <div className="candidate-actions">{savedId?<a className="text-button" href={`/?prospect=${savedId}`}>Open prospect</a>:<button className="text-button" onClick={onReview} disabled={busy}>Review & save</button>}
      {!item.assessment&&aiReady&&<button className="link-button" disabled={actionsDisabled||!aiRemaining||item.assessmentStatus==='running'} onClick={onAssess}>{assessing||item.assessmentStatus==='running'?'Assessing fit…':'Assess fit with AI'}</button>}
      {!savedId&&<button className="link-button" disabled={actionsDisabled} onClick={onDismiss}>{item.dismissed?'Restore candidate':'Dismiss'}</button>}
    </div>
  </article>;
}
