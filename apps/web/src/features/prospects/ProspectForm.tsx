import { useEffect, useState, type FormEvent } from 'react';
import { categories, safeHttpUrl, type Category, type Prospect, type ProspectFields, type Source } from './api';

type Draft = Omit<ProspectFields, 'category'> & { category: Category | '' };
const blank: Draft = { name: '', category: '', website: '', contactName: '', email: '', phone: '', location: '', relevance: '', notes: '', sources: [] };

export function ProspectForm({ prospect, initialFields, submitLabel, busy, error, conflict, onSave, onCancel, onReload, onDirty }: {
  prospect?: Prospect; busy: boolean; error: string; conflict: boolean;
  initialFields?: ProspectFields; submitLabel?: string;
  onSave: (fields: ProspectFields, version?: number) => Promise<void>;
  onCancel: () => void; onReload: () => void; onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    const initial = prospect || initialFields;
    return initial ? { ...initial, sources: initial.sources.map(source => ({ ...source })) } : blank;
  });
  const [validation, setValidation] = useState('');
  const [changed, setChanged] = useState(false);
  useEffect(() => { onDirty(changed); return () => onDirty(false); }, [changed, onDirty]);

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value })); setChanged(true); setValidation('');
  }
  function updateSource(index: number, field: keyof Source, value: string) {
    update('sources', draft.sources.map((source, current) => current === index ? { ...source, [field]: value } : source));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!draft.name.trim() || !draft.category) { setValidation('Enter a name and choose a category.'); return; }
    if (draft.website.trim() && !safeHttpUrl(draft.website.trim())) {
      setValidation('Enter a website URL starting with https:// or http://.'); return;
    }
    if (draft.sources.some((source) => !safeHttpUrl(source.url.trim()))) {
      setValidation('Each source needs a URL starting with https:// or http://. Remove unused sources.'); return;
    }
    const fields: ProspectFields = {
      name: draft.name.trim(), category: draft.category, website: draft.website.trim(),
      contactName: draft.contactName.trim(), email: draft.email.trim(), phone: draft.phone.trim(),
      location: draft.location.trim(), relevance: draft.relevance.trim(), notes: draft.notes.trim(),
      sources: draft.sources.map(({ title, url, note }) => ({ title: title.trim(), url: url.trim(), note: note.trim() })),
    };
    setValidation(''); await onSave(fields, prospect?.version);
  }

  return <form className="prospect-form" onSubmit={(event) => void submit(event)}>
    <p className="form-introduction">{prospect ? 'Update the details and evidence your team has collected.' : 'Save a person or organization your team wants to get to know.'} Name and category are required.</p>
    <fieldset disabled={busy} className="form-section">
      <legend>Prospect details</legend>
      <div className="form-grid">
        <div className="form-field"><label htmlFor="prospect-name">Name <span className="required-label">(required)</span></label><input id="prospect-name" value={draft.name} onChange={(event) => update('name', event.target.value)} required maxLength={200} autoFocus /></div>
        <div className="form-field"><label htmlFor="prospect-category">Category <span className="required-label">(required)</span></label><select id="prospect-category" value={draft.category} onChange={(event) => update('category', event.target.value as Category)} required><option value="">Choose a category</option>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="prospect-website">Website</label><input id="prospect-website" type="url" placeholder="https://" value={draft.website} onChange={(event) => update('website', event.target.value)} maxLength={2000} /></div>
        <div className="form-field"><label htmlFor="prospect-location">Location</label><input id="prospect-location" value={draft.location} onChange={(event) => update('location', event.target.value)} maxLength={200} /></div>
      </div>
    </fieldset>
    <fieldset disabled={busy} className="form-section">
      <legend>Contact details</legend><p className="section-help">Use details shared publicly or directly with your team.</p>
      <div className="form-grid">
        <div className="form-field"><label htmlFor="contact-name">Contact name</label><input id="contact-name" value={draft.contactName} onChange={(event) => update('contactName', event.target.value)} maxLength={200} /></div>
        <div className="form-field"><label htmlFor="contact-email">Email</label><input id="contact-email" type="email" value={draft.email} onChange={(event) => update('email', event.target.value)} maxLength={254} autoCapitalize="none" /></div>
        <div className="form-field"><label htmlFor="contact-phone">Phone</label><input id="contact-phone" type="tel" value={draft.phone} onChange={(event) => update('phone', event.target.value)} maxLength={100} /></div>
      </div>
    </fieldset>
    <fieldset disabled={busy} className="form-section">
      <legend>Why this prospect matters</legend>
      <div className="form-field"><label htmlFor="prospect-relevance">Relevance to Ehud</label><textarea id="prospect-relevance" rows={3} value={draft.relevance} onChange={(event) => update('relevance', event.target.value)} maxLength={2000} aria-describedby="relevance-help" /><p id="relevance-help" className="field-help">What makes them a potential customer or partner?</p></div>
      <div className="form-field"><label htmlFor="prospect-notes">Team notes</label><textarea id="prospect-notes" rows={4} value={draft.notes} onChange={(event) => update('notes', event.target.value)} maxLength={5000} /></div>
    </fieldset>
    <fieldset disabled={busy} className="form-section">
      <legend>Sources</legend><p className="section-help">Link to the work, services, or information that supports this prospect.</p>
      {draft.sources.map((source, index) => <div className="source-form" key={index}>
        <div className="source-form-heading"><h3>Source {index + 1}</h3><button type="button" className="link-button" onClick={() => update('sources', draft.sources.filter((_, current) => current !== index))}>Remove source {index + 1}</button></div>
        <div className="form-grid"><div className="form-field"><label htmlFor={`source-title-${index}`}>Title</label><input id={`source-title-${index}`} value={source.title} onChange={(event) => updateSource(index, 'title', event.target.value)} maxLength={200} /></div><div className="form-field"><label htmlFor={`source-url-${index}`}>Source URL <span className="required-label">(required)</span></label><input id={`source-url-${index}`} type="url" value={source.url} onChange={(event) => updateSource(index, 'url', event.target.value)} required placeholder="https://" maxLength={2000} /></div></div>
        <div className="form-field"><label htmlFor={`source-note-${index}`}>Evidence or context</label><textarea id={`source-note-${index}`} rows={2} value={source.note} onChange={(event) => updateSource(index, 'note', event.target.value)} maxLength={1000} /></div>
      </div>)}
      <button type="button" className="text-button" onClick={() => update('sources', [...draft.sources, { title: '', url: '', note: '' }])} disabled={draft.sources.length >= 20}>Add source</button>{draft.sources.length >= 20 && <p className="field-help">You can save up to 20 sources per prospect.</p>}
    </fieldset>
    {(validation || error) && <div className="error-message" role="alert">{validation || error}{conflict && <><p>Your edits are still in this form. Reloading the saved record will replace them.</p><button className="text-button" type="button" onClick={onReload} disabled={busy}>Reload saved record</button></>}</div>}
    <div className="form-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel || (prospect ? 'Save changes' : 'Save prospect')}</button><button className="text-button" type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
  </form>;
}
