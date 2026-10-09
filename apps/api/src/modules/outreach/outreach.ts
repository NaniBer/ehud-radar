import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { protectWrite, requireAccount, type AuthOptions } from '../auth/auth.js';
import { DiscoveryError } from '../discovery/providers.js';
import { FreeAiError } from '../ai/openrouter.js';
import { validateDraft, type Drafter, type DraftContext } from './provider.js';

export type OutreachOptions = AuthOptions & { drafter?: Drafter };
const DAILY_LIMIT = 10;
const version = z.number().int().min(0).max(2147483646);
const text = (max:number) => z.string().trim().max(max);
const channel = z.enum(['email','linkedin']);
const stateInput = z.object({ version, researchSummary:text(2000), contactRole:text(200), contactSourceUrl:text(2000).refine(value=>{
  if(!value)return true;try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}), status:z.enum(['new','contacted','replied','follow_up','closed']), followUpDate:z.union([z.literal(''),z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
  const date=new Date(`${value}T00:00:00Z`);return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value;
})]), notes:text(5000) }).strict();
const contentInput = z.object({channel,subject:text(200),body:text(4000).min(1)}).strict();
const generateInput = z.object({requestId:z.uuid(),channel,purpose:text(600).min(1),prospectVersion:version.min(1)}).strict();
const defaultState={version:0,researchSummary:'',contactRole:'',contactSourceUrl:'',status:'new',followUpDate:'',notes:''};
const iso=(value:Date|string|null)=>value?new Date(value).toISOString():null;
function state(row:any){return row?{version:row.version,researchSummary:row.research_summary,contactRole:row.contact_role,
  contactSourceUrl:row.contact_source_url,status:row.status,followUpDate:row.follow_up_date||'',notes:row.notes}:defaultState;}
function draft(row:any){return {id:row.id,prospectId:row.prospect_id,channel:row.channel,purpose:row.purpose,origin:row.origin,status:row.status,
  subject:row.subject,body:row.body,evidence:row.evidence,caveats:row.caveats,sources:row.source_snapshot,
  model:row.model,error:row.error_message,version:row.version,prospectVersion:row.prospect_version,
  createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
async function transaction<T>(pool:Pool,operation:(client:PoolClient)=>Promise<T>){const client=await pool.connect();
  try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
async function expire(database:Pool|PoolClient){await database.query("UPDATE outreach_drafts SET status='failed',error_message='This generation was interrupted. Try again.',updated_at=NOW() WHERE status='running' AND created_at<NOW()-INTERVAL '2 minutes'");}
async function loadProspect(database:Pool|PoolClient,id:string){const result=await database.query('SELECT * FROM prospects WHERE id=$1',[id]);
  if(!result.rowCount)throw new DiscoveryError('This prospect could not be found.',404);return result.rows[0];}
async function allowance(database:Pool){const result=await database.query("SELECT COUNT(*) FROM outreach_drafts WHERE origin='ai' AND created_at>NOW()-INTERVAL '24 hours'");return Math.max(0,DAILY_LIMIT-Number(result.rows[0].count));}
async function loadDraft(pool:Pool,prospectId:string,id:string){const result=await pool.query('SELECT * FROM outreach_drafts WHERE prospect_id=$1 AND id=$2',[prospectId,id]);
  if(!result.rowCount)throw new DiscoveryError('This draft could not be found.',404);return draft(result.rows[0]);}

export function createOutreach({pool,origin,drafter}:OutreachOptions){
  const router=Router();router.use(requireAccount);
  for(const param of ['id','draftId'])router.param(param,(_request,response,next,value)=>{if(!z.uuid().safeParse(value).success){response.status(400).json({error:'Use a valid prospect or draft ID.'});return;}next();});
  router.get('/:id',async(request,response)=>{
    const parsed=z.object({page:z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().max(100000)).default(1)}).strict().safeParse(request.query);
    if(!parsed.success)throw new DiscoveryError('Use a valid draft history page.',400);
    const id=String(request.params.id);await loadProspect(pool,id);await expire(pool);
    const research=await pool.query('SELECT *,to_char(follow_up_date,\'YYYY-MM-DD\') AS follow_up_date FROM outreach_state WHERE prospect_id=$1',[id]);
    const rows=await pool.query('SELECT * FROM outreach_drafts WHERE prospect_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $2',[id,(parsed.data.page-1)*20]);
    const total=await pool.query('SELECT COUNT(*) FROM outreach_drafts WHERE prospect_id=$1',[id]);
    response.json({research:state(research.rows[0]),drafts:rows.rows.map(draft),total:Number(total.rows[0].count),page:parsed.data.page,pageSize:20,aiReady:!!drafter,generationsRemaining:await allowance(pool),dailyLimit:DAILY_LIMIT});
  });
  router.put('/:id',protectWrite(origin),async(request,response)=>{
    const parsed=stateInput.safeParse(request.body);if(!parsed.success)throw new DiscoveryError('Check the research details and follow-up date.',400);
    const id=String(request.params.id),data=parsed.data;
    const saved=await transaction(pool,async client=>{
      await loadProspect(client,id);
      await client.query('INSERT INTO outreach_state(prospect_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
      const result=await client.query(`UPDATE outreach_state SET research_summary=$2,contact_role=$3,contact_source_url=$4,status=$5,follow_up_date=$6,notes=$7,version=version+1,updated_at=NOW()
        WHERE prospect_id=$1 AND version=$8 RETURNING *,to_char(follow_up_date,'YYYY-MM-DD') AS follow_up_date`,[id,data.researchSummary,data.contactRole,data.contactSourceUrl,data.status,data.followUpDate||null,data.notes,data.version]);
      if(!result.rowCount)throw new DiscoveryError('Research was updated in another tab. Your edits are still here; reload the saved research before editing again.',409);
      return state(result.rows[0]);
    });response.json({research:saved});
  });
  router.post('/:id/drafts',protectWrite(origin),async(request,response)=>{
    const parsed=contentInput.extend({requestId:z.uuid()}).safeParse(request.body);if(!parsed.success)throw new DiscoveryError('Choose a channel and write a message before saving.',400);
    const id=String(request.params.id),data=parsed.data;const prospect=await loadProspect(pool,id);
    await pool.query(`INSERT INTO outreach_drafts(id,prospect_id,channel,origin,status,subject,body,source_snapshot,prospect_version)
      VALUES($1,$2,$3,'manual','completed',$4,$5,$6::jsonb,$7) ON CONFLICT(id) DO NOTHING`,[data.requestId,id,data.channel,data.channel==='email'?data.subject:'',data.body,JSON.stringify(prospect.sources),prospect.version]);
    const saved=await loadDraft(pool,id,data.requestId);
    if(saved.origin!=='manual'||saved.channel!==data.channel||saved.subject!==(data.channel==='email'?data.subject:'')||saved.body!==data.body)throw new DiscoveryError('This request ID belongs to a different draft.',409);
    response.status(201).json({draft:saved});
  });
  router.put('/:id/drafts/:draftId',protectWrite(origin),async(request,response)=>{
    const parsed=contentInput.extend({version:version.min(1)}).safeParse(request.body);if(!parsed.success)throw new DiscoveryError('Check the draft before saving.',400);
    const id=String(request.params.id),draftId=String(request.params.draftId),data=parsed.data;
    const current=await loadDraft(pool,id,draftId);if(current.status!=='completed')throw new DiscoveryError('Only completed drafts can be edited.',409);
    const result=await pool.query(`UPDATE outreach_drafts SET input_key=CASE WHEN origin='ai' AND channel<>$3 THEN 'edited-channel:'||id::text ELSE input_key END,channel=$3,subject=$4,body=$5,version=version+1,updated_at=NOW()
      WHERE prospect_id=$1 AND id=$2 AND version=$6 RETURNING *`,[id,draftId,data.channel,data.channel==='email'?data.subject:'',data.body,data.version]);
    if(!result.rowCount)throw new DiscoveryError('This draft was updated in another tab. Your edits are still here; reopen the saved draft before editing again.',409);
    response.json({draft:draft(result.rows[0])});
  });
  router.post('/:id/generate',protectWrite(origin),async(request,response)=>{
    const parsed=generateInput.safeParse(request.body);if(!parsed.success)throw new DiscoveryError('Choose a channel and enter a message goal.',400);
    if(!drafter)throw new DiscoveryError('Add an active OPENROUTER_API_KEY to generate drafts. You can write one manually.',503);
    const id=String(request.params.id),data=parsed.data;
    const reservation=await transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('outreach'))");await expire(client);
      const prospect=await loadProspect(client,id);
      if(prospect.version!==data.prospectVersion)throw new DiscoveryError('The prospect changed. Reopen its profile before generating from the current sources.',409);
      const context:DraftContext={name:prospect.name,category:prospect.category,channel:data.channel,purpose:data.purpose,sources:prospect.sources};
      if(!context.sources.some(source=>source.note.trim()))throw new DiscoveryError('Add at least one source excerpt before generating a draft. Links alone do not provide evidence.',400);
      const key=createHash('sha256').update(JSON.stringify(context)).digest('hex');
      const repeat=await client.query('SELECT * FROM outreach_drafts WHERE id=$1',[data.requestId]);
      if(repeat.rowCount){const item=repeat.rows[0];if(item.prospect_id!==id||item.input_key!==key)throw new DiscoveryError('This request ID belongs to a different generation.',409);return {existing:item.id};}
      const cached=await client.query("SELECT * FROM outreach_drafts WHERE prospect_id=$1 AND input_key=$2 AND status IN ('running','completed') ORDER BY created_at DESC LIMIT 1",[id,key]);
      if(cached.rowCount)return {existing:cached.rows[0].id};
      const used=await client.query("SELECT COUNT(*) FROM outreach_drafts WHERE origin='ai' AND created_at>NOW()-INTERVAL '24 hours'");
      if(Number(used.rows[0].count)>=DAILY_LIMIT)throw new DiscoveryError('The 10-generation daily limit is reached. Write a draft manually or try later.',429);
      if((await client.query("SELECT id FROM outreach_drafts WHERE status='running'")).rowCount)throw new DiscoveryError('A draft is already generating. Open its saved history to follow it.',409);
      await client.query(`INSERT INTO outreach_drafts(id,prospect_id,channel,purpose,origin,status,input_key,source_snapshot,prospect_version)
        VALUES($1,$2,$3,$4,'ai','running',$5,$6::jsonb,$7)`,[data.requestId,id,data.channel,data.purpose,key,JSON.stringify(context.sources),prospect.version]);
      return {context};
    });
    if('existing' in reservation){response.json({draft:await loadDraft(pool,id,reservation.existing),cached:true});return;}
    try{
      const output=await drafter.generate(reservation.context);const valid=validateDraft({subject:output.subject,body:output.body,evidence:output.evidence,caveats:output.caveats},reservation.context.sources);
      await pool.query(`UPDATE outreach_drafts SET status='completed',subject=$2,body=$3,evidence=$4::jsonb,caveats=$5::jsonb,model=$6,updated_at=NOW()
        WHERE id=$1 AND status='running'`,[data.requestId,data.channel==='email'?valid.subject:'',valid.body,JSON.stringify(valid.evidence),JSON.stringify(valid.caveats),output.model.slice(0,200)]);
    }catch(error){const message=error instanceof FreeAiError?error.message:'AI could not finish. Your other drafts are unchanged; you can write one manually.';
      await pool.query("UPDATE outreach_drafts SET status='failed',error_message=$2,updated_at=NOW() WHERE id=$1 AND status='running'",[data.requestId,message]);}
    response.status(201).json({draft:await loadDraft(pool,id,data.requestId),cached:false});
  });
  return router;
}
