import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ProspectError, safeHttpUrl, type Prospect } from '../prospects/api';
import { outreachRequest, type Channel, type Draft, type OutreachData, type Research } from './api';

const defaultPurpose="Explore whether Ehud AI's storyboarding tool could support a project.";
const statusLabels={new:'Not contacted',contacted:'Contacted',replied:'Replied',follow_up:'Follow-up needed',closed:'Closed'};
const today=()=>{const value=new Date();return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;};
const date=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));

export function OutreachPanel({prospect,csrfToken,onSessionExpired,onDirty,onEditProspect,onReviewEvidence}:{prospect:Prospect;csrfToken:string;onSessionExpired:()=>void;onDirty:(dirty:boolean)=>void;onEditProspect:()=>void;onReviewEvidence:()=>void}){
  const [data,setData]=useState<OutreachData|null>(null);
  const [research,setResearch]=useState<Research|null>(null);
  const [researchDirty,setResearchDirty]=useState(false);
  const [researchBusy,setResearchBusy]=useState(false);
  const [researchError,setResearchError]=useState('');
  const [researchConflict,setResearchConflict]=useState(false);
  const [editingResearch,setEditingResearch]=useState(false);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [refresh,setRefresh]=useState(0);
  const [page,setPage]=useState(1);
  const [selected,setSelected]=useState<Draft|null>(null);
  const [channel,setChannel]=useState<Channel>('email');
  const [subject,setSubject]=useState('');
  const [body,setBody]=useState('');
  const [purpose,setPurpose]=useState(defaultPurpose);
  const [draftDirty,setDraftDirty]=useState(false);
  const [busy,setBusy]=useState<'save'|'generate'|null>(null);
  const [draftError,setDraftError]=useState('');
  const [notice,setNotice]=useState('');
  const [pendingDraft,setPendingDraft]=useState<{action:()=>void}|null>(null);
  const [copied,setCopied]=useState(false);
  const mounted=useRef(true);
  const researchChanged=useRef(false);
  const initialDraft=useRef(false);
  const manualRequest=useRef(crypto.randomUUID());
  const generateRequest=useRef<{key:string;id:string}|null>(null);
  const keepEditing=useRef<HTMLButtonElement>(null);
  const selectedId=useRef<string|null>(null);
  const selectedVersion=useRef(0);
  const previousDraftFocus=useRef<HTMLElement|null>(null);
  const draftChanged=useRef(false);
  const handleError=useCallback((cause:unknown)=>{if(cause instanceof ProspectError&&cause.status===401)onSessionExpired();return cause instanceof Error?cause.message:'Could not complete the request.';},[onSessionExpired]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{onDirty(researchDirty||draftDirty);return()=>onDirty(false);},[researchDirty,draftDirty,onDirty]);
  useEffect(()=>{if(pendingDraft)keepEditing.current?.focus();},[pendingDraft]);
  function choose(item:Draft|null){selectedId.current=item?.id||null;selectedVersion.current=item?.version||0;setSelected(item);setChannel(item?.channel||'email');setSubject(item?.subject||'');setBody(item?.body||'');setPurpose(item?.purpose||defaultPurpose);setDraftDirty(false);draftChanged.current=false;setDraftError('');setNotice('');setCopied(false);manualRequest.current=crypto.randomUUID();}
  useEffect(()=>{
    const controller=new AbortController();let timer:number|undefined;setLoading(true);setError('');
    const load=async()=>{try{
      const result=await outreachRequest<OutreachData>(`/${prospect.id}?page=${page}`,{signal:controller.signal});if(controller.signal.aborted)return;
      setData(result);if(!researchChanged.current)setResearch(result.research);
      if(!initialDraft.current){initialDraft.current=true;choose(result.drafts.find(item=>item.status==='completed')||null);}
      else if(selectedId.current&&!draftChanged.current){const current=result.drafts.find(item=>item.id===selectedId.current);if(current){setSelected(current);if(current.version!==selectedVersion.current){selectedVersion.current=current.version;setChannel(current.channel);setSubject(current.subject);setBody(current.body);}}}
      setLoading(false);if(result.drafts.some(item=>item.status==='running'))timer=window.setTimeout(()=>void load(),2500);
    }catch(cause){if(!controller.signal.aborted){setError(handleError(cause));setLoading(false);}}};
    void load();return()=>{controller.abort();window.clearTimeout(timer);};
  },[prospect.id,page,refresh,handleError]);
  function updateResearch<K extends keyof Research>(key:K,value:Research[K]){setResearch(current=>current?{...current,[key]:value}:current);researchChanged.current=true;setResearchDirty(true);setResearchError('');setNotice('');}
  async function saveResearch(event:FormEvent){event.preventDefault();if(!research||researchBusy)return;setResearchBusy(true);setResearchError('');setResearchConflict(false);try{
    const result=await outreachRequest<{research:Research}>(`/${prospect.id}`,{method:'PUT',body:research,csrfToken});if(!mounted.current)return;
    setResearch(result.research);setData(current=>current?{...current,research:result.research}:current);researchChanged.current=false;setResearchDirty(false);setEditingResearch(false);setNotice('Research and follow-up saved.');
  }catch(cause){if(mounted.current){setResearchError(handleError(cause));setResearchConflict(cause instanceof ProspectError&&cause.status===409);}}finally{if(mounted.current)setResearchBusy(false);}}
  function requestDraftChange(action:()=>void){if(draftDirty){previousDraftFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setPendingDraft({action});}else action();}
  function changeContent(update:()=>void){update();setDraftDirty(true);draftChanged.current=true;setNotice('');setCopied(false);}
  async function saveDraft(event:FormEvent){event.preventDefault();if(busy||!body.trim())return;setBusy('save');setDraftError('');setNotice('');try{
    const result=await outreachRequest<{draft:Draft}>(`/${prospect.id}/drafts${selected?`/${selected.id}`:''}`,{method:selected?'PUT':'POST',body:selected?{channel,subject,body,version:selected.version}:{requestId:manualRequest.current,channel,subject,body},csrfToken});
    if(!mounted.current)return;choose(result.draft);setNotice('Draft saved. Your team can review and send it manually.');setPage(1);setRefresh(value=>value+1);
  }catch(cause){if(mounted.current)setDraftError(handleError(cause));}finally{if(mounted.current)setBusy(null);}}
  async function generate(){if(busy||draftDirty)return;setBusy('generate');setDraftError('');setNotice('');
    const key=JSON.stringify({channel,purpose,version:prospect.version});if(generateRequest.current?.key!==key)generateRequest.current={key,id:crypto.randomUUID()};
    try{const result=await outreachRequest<{draft:Draft;cached:boolean}>(`/${prospect.id}/generate`,{method:'POST',body:{requestId:generateRequest.current!.id,channel,purpose,prospectVersion:prospect.version},csrfToken});if(!mounted.current)return;
      if(result.draft.status==='completed'){choose(result.draft);setNotice(result.cached?'Opened the saved draft for this goal and evidence.':'Draft generated and saved. Check the wording and evidence before sending.');}
      else{setDraftError(result.draft.error||'This draft is still generating. Follow it in saved draft history.');generateRequest.current=null;}
      setPage(1);setRefresh(value=>value+1);
    }catch(cause){if(mounted.current)setDraftError(handleError(cause));}finally{if(mounted.current)setBusy(null);}}
  async function copy(){try{await navigator.clipboard.writeText(channel==='email'&&subject?`${subject}\n\n${body}`:body);setCopied(true);}catch{setDraftError('Copy is unavailable. Select the message text and copy it manually.');}}
  const sourcesReady=prospect.sources.some(source=>source.note.trim());
  const savedResearch=data?.research;
  const followUpDue=savedResearch?.followUpDate&&savedResearch.followUpDate<=today()&&savedResearch.status!=='closed';
  const selectedSourceChanged=selected&&JSON.stringify(selected.sources)!==JSON.stringify(prospect.sources);
  return <section className="outreach-panel" aria-label="Research and outreach">
    {loading&&!data?<p role="status">Opening research and drafts…</p>:error?<div className="error-message" role="alert"><p>{error}</p><button className="text-button" onClick={()=>setRefresh(value=>value+1)}>Try again</button></div>:data&&research?<>
      {notice&&<p className="save-notice" role="status">{notice}</p>}
      <section className="outreach-brief" aria-labelledby="research-brief-heading"><div className="outreach-section-heading"><h2 id="research-brief-heading">Research brief</h2><button className="link-button" disabled={researchBusy} onClick={()=>setEditingResearch(value=>!value)}>{editingResearch?'Hide research form':'Edit research & follow-up'}</button></div>
        <p className="preserve-lines">{savedResearch?.researchSummary||prospect.relevance||'Capture what makes this prospect relevant, using the sources your team has saved.'}</p>
        <div className="outreach-research-facts"><p><strong>{prospect.sources.length} {prospect.sources.length===1?'source':'sources'} saved</strong> · <button className="link-button" onClick={onReviewEvidence}>Review evidence</button></p><p><strong>Contact:</strong> {prospect.contactName||'Not added'}{savedResearch?.contactRole?` · ${savedResearch.contactRole}`:''} <button className="link-button" onClick={onEditProspect}>Edit contact details</button></p>{savedResearch?.contactSourceUrl&&safeHttpUrl(savedResearch.contactSourceUrl)&&<a href={safeHttpUrl(savedResearch.contactSourceUrl)!} target="_blank" rel="noopener noreferrer">Contact source</a>}<p><strong>{statusLabels[savedResearch?.status||'new']}</strong>{savedResearch?.followUpDate&&` · Follow up ${savedResearch.followUpDate}`}{followUpDue&&<span className="follow-up-due">Due for follow-up</span>}</p></div>
        {editingResearch&&<form className="outreach-research-form" onSubmit={event=>void saveResearch(event)}><fieldset disabled={researchBusy}><legend>Research & follow-up</legend>
          <div className="form-field"><label htmlFor="research-summary">Research summary</label><textarea id="research-summary" rows={3} maxLength={2000} value={research.researchSummary} onChange={event=>updateResearch('researchSummary',event.target.value)}/></div>
          <div className="form-grid"><div className="form-field"><label htmlFor="contact-role">Contact role</label><input id="contact-role" maxLength={200} value={research.contactRole} onChange={event=>updateResearch('contactRole',event.target.value)}/></div><div className="form-field"><label htmlFor="contact-source">Contact source URL</label><input id="contact-source" type="url" placeholder="https://" maxLength={2000} value={research.contactSourceUrl} onChange={event=>updateResearch('contactSourceUrl',event.target.value)}/></div><div className="form-field"><label htmlFor="outreach-status">Outreach status</label><select id="outreach-status" value={research.status} onChange={event=>updateResearch('status',event.target.value as Research['status'])}>{Object.entries(statusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div><div className="form-field"><label htmlFor="follow-up-date">Follow-up date</label><input id="follow-up-date" type="date" min="0001-01-01" max="9999-12-31" value={research.followUpDate} onInput={event=>updateResearch('followUpDate',event.currentTarget.value)}/></div></div>
          <div className="form-field"><label htmlFor="outreach-notes">Outreach notes</label><textarea id="outreach-notes" rows={3} maxLength={5000} value={research.notes} onChange={event=>updateResearch('notes',event.target.value)}/><p className="field-help">Record who you contacted and what happened. These notes stay in Radar.</p></div>
        </fieldset>{researchError&&<p className="error-message" role="alert">{researchError}</p>}<div className="form-actions"><button className="primary-button compact-button" type="submit" disabled={researchBusy||!researchDirty}>{researchBusy?'Saving…':'Save research & follow-up'}</button>{researchConflict&&<button className="text-button" type="button" onClick={()=>{if(window.confirm('Discard your research edits and reload the saved research?')){researchChanged.current=false;setResearchDirty(false);setResearchConflict(false);setResearchError('');setRefresh(value=>value+1);}}}>Reload saved research</button>}</div></form>}
      </section>
      <div className="outreach-draft-layout"><section aria-labelledby="outreach-draft-heading"><div className="outreach-section-heading"><h2 id="outreach-draft-heading">{selected?'Review draft':'Write a draft'}</h2><button className="link-button" disabled={!!busy} onClick={()=>requestDraftChange(()=>choose(null))}>New manual draft</button></div>
        <p className="outreach-help">Prepare an email or LinkedIn message. Your team reviews and sends it manually.</p>
        {pendingDraft&&<section className="discard-confirmation"><h3>Keep your draft edits?</h3><p>Opening another draft will discard unsaved message edits.</p><div><button ref={keepEditing} className="text-button" onClick={()=>{setPendingDraft(null);previousDraftFocus.current?.focus();}}>Keep editing draft</button><button className="text-button" onClick={()=>{const action=pendingDraft.action;setPendingDraft(null);action();}}>Discard draft edits</button></div></section>}
        <form onSubmit={event=>void saveDraft(event)}><fieldset className="outreach-editor-fields" disabled={!!busy}><legend className="visually-hidden">Outreach message</legend><div className="form-field"><label htmlFor="draft-channel">Channel</label><select id="draft-channel" value={channel} onChange={event=>{const value=event.target.value as Channel;if(!selected&&!body.trim())setChannel(value);else changeContent(()=>setChannel(value));}}><option value="email">Email</option><option value="linkedin">LinkedIn</option></select></div>
          {channel==='email'&&<div className="form-field"><label htmlFor="draft-subject">Subject</label><input id="draft-subject" maxLength={200} value={subject} onChange={event=>changeContent(()=>setSubject(event.target.value))}/></div>}
          <div className="form-field"><label htmlFor="draft-message">Message</label><textarea id="draft-message" rows={9} required maxLength={4000} placeholder="Write a personal introduction and a clear next step." value={body} onChange={event=>changeContent(()=>setBody(event.target.value))}/></div></fieldset>
          <div className="outreach-draft-actions"><button className="text-button" type="submit" disabled={!!busy||!body.trim()||(!!selected&&!draftDirty)}>{busy==='save'?'Saving…':'Save draft'}</button><button className="link-button" type="button" disabled={!body.trim()||!!busy} onClick={()=>void copy()}>{copied?'Copied':'Copy message'}</button>{draftDirty&&<span className="field-help">Unsaved edits</span>}</div>
        </form>
        {selected&&<><p className="outreach-draft-meta">{selected.origin==='ai'?'AI-assisted':'Written manually'}{selected.version>1?' · Edited':''} · Saved {date(selected.updatedAt)}</p>{selectedSourceChanged&&<p className="outreach-help">Sources have changed since this draft was saved. Review the current evidence before sending.</p>}{selected.evidence.length>0&&<details className="outreach-evidence"><summary>Draft evidence and what to verify</summary><ul>{selected.evidence.map((item,index)=>{const source=selected.sources[item.sourceIndex-1];const url=source&&safeHttpUrl(source.url);return <li key={index}><q>{item.quote}</q>{url&&<> · <a href={url} target="_blank" rel="noopener noreferrer">{source.title||'Source'}</a></>}</li>;})}</ul>{selected.caveats.length>0&&<><h3>Verify before sending</h3><ul>{selected.caveats.map((item,index)=><li key={index}>{item}</li>)}</ul></>}<p className="field-help">Evidence belongs to the original AI draft. Check any wording you edit.</p></details>}</>}
        <section className="outreach-generate" aria-labelledby="ai-draft-heading"><h3 id="ai-draft-heading">Draft with AI</h3><div className="form-field"><label htmlFor="draft-purpose">Message goal</label><textarea id="draft-purpose" rows={2} maxLength={600} value={purpose} disabled={!!busy} onChange={event=>setPurpose(event.target.value)}/></div>
          <p className="field-help">Uses the prospect name, category, saved source excerpts, channel, and this goal. Contact details and internal research notes stay in Radar.</p>
          {!data.aiReady&&<p className="outreach-help">AI needs an active OpenRouter key. You can write and save a draft above.</p>}{!sourcesReady&&<p className="outreach-help">Add a source excerpt through Edit prospect to give AI evidence to work from.</p>}{draftDirty&&<p className="outreach-help">Save your message edits before generating another draft.</p>}
          <div className="outreach-generate-actions"><button className="primary-button compact-button" type="button" disabled={!!busy||draftDirty||!data.aiReady||!sourcesReady||!purpose.trim()||!data.generationsRemaining} onClick={()=>void generate()}>{busy==='generate'?'Generating draft…':'Generate draft'}</button><span className="field-help">{data.generationsRemaining} of {data.dailyLimit} generations available in 24 hours.</span></div>
        </section>{draftError&&<p className="error-message" role="alert">{draftError}</p>}
      </section><aside className="outreach-history"><h2>Saved drafts</h2>{data.drafts.length?<><ol>{data.drafts.map(item=><li key={item.id}><button className="history-run-button" aria-current={selected?.id===item.id?'true':undefined} disabled={!!busy||loading} onClick={()=>requestDraftChange(()=>{if(item.status==='completed')choose(item);else setDraftError(item.error||'This draft is still generating.');})}><strong>{item.subject||(item.channel==='email'?'Email draft':'LinkedIn message')}</strong><span>{date(item.createdAt)}</span><span>{item.status==='failed'?'Generation failed':item.status==='running'?'Generating…':item.origin==='ai'?'AI-assisted':'Written manually'}</span></button></li>)}</ol>{data.total>data.pageSize&&<nav className="pagination" aria-label="Draft history pages"><button className="text-button" disabled={page<=1||!!busy} onClick={()=>setPage(value=>value-1)}>Previous</button><span>Page {page}</span><button className="text-button" disabled={page*data.pageSize>=data.total||!!busy} onClick={()=>setPage(value=>value+1)}>Next</button></nav>}</>:<p className="outreach-help">No drafts yet. Save a message or generate one from the prospect’s sources.</p>}</aside></div>
    </>:null}
  </section>;
}
