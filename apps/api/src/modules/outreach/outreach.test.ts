import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import { createApp } from '../../app.js';
import { migrateDatabase } from '../../db/database.js';
import { createOpenRouterDrafter, type Drafter } from './provider.js';
import { FreeAiError } from '../ai/openrouter.js';
const env=dotenv.parse(readFileSync(new URL('../../../../../.env',import.meta.url)));
const connectionString=process.env.TEST_DATABASE_URL||env.DATABASE_URL;
const origin='http://127.0.0.1:5174';
const source={title:'Synthetic Studio',url:'https://studio.example/work',note:'Synthetic Studio produces music videos.'};
const result={subject:'Explore storyboarding for your workflow',body:'Hello, would you be open to discussing storyboarding for music videos?',evidence:[{sourceIndex:1,quote:'produces music videos'}],caveats:['Verify recipient and fit before sending.'],model:'test/free'};
const research={version:0,researchSummary:'Evidence-based production fit',contactRole:'Producer',contactSourceUrl:source.url,status:'follow_up',followUpDate:'2026-10-12',notes:'Called once'};
async function fixture(options:{drafter?:Drafter}={}){
  const schema=`outreach_test_${randomBytes(8).toString('hex')}`;
  const admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});await migrateDatabase(pool);await migrateDatabase(pool);
  const setupToken=randomBytes(32).toString('hex');
  const application=createApp({pool,schemaName:schema,origin,secret:randomBytes(32).toString('hex'),setupToken,
    drafter:options.drafter});
  const server=application.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No test address');
  let cookie='';let csrf='';
  async function call(path:string,method='GET',body?:unknown,override:{cookie?:string;csrf?:string;origin?:string}={}){
    const headers:Record<string,string>={origin:override.origin??origin,cookie:override.cookie??cookie};
    if(body!==undefined){headers['content-type']='application/json';headers['x-csrf-token']=override.csrf??csrf;}
    const response=await fetch(`http://127.0.0.1:${address.port}/api${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];
    const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;return {status:response.status,data};
  }
  return {pool,call,async signIn(){await call('/auth/state');assert.equal((await call('/auth/setup','POST',{setupToken,password:'test-only-password-42'})).status,201);},
    async add(extra:object={}){return (await call('/prospects','POST',{name:'Synthetic Studio',category:'production_company',website:'https://studio.example',sources:[source],notes:'Internal note must not be sent',contactName:'Private contact',email:'private@example.com',...extra})).data.prospect;},
    async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));application.store.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}};
}


test('outreach requires authentication, CSRF and Origin; IDs and fields are validated',async()=>{
 const app=await fixture();try{const id=randomUUID();assert.equal((await app.call(`/outreach/${id}`)).status,401);assert.equal((await app.call(`/outreach/${id}/generate`,'POST',{})).status,401);await app.signIn();const prospect=await app.add();
 for(const [path,method] of [[`/outreach/${prospect.id}`,'PUT'],[`/outreach/${prospect.id}/drafts`,'POST'],[`/outreach/${prospect.id}/generate`,'POST'],[`/outreach/${prospect.id}/drafts/${id}`,'PUT']]){
 assert.equal((await app.call(path,method,{}, {origin:'https://attacker.example'})).status,403);assert.equal((await app.call(path,method,{}, {csrf:''})).status,403);}
 assert.equal((await app.call('/outreach/not-a-uuid')).status,400);assert.equal((await app.call(`/outreach/${id}`)).status,404);
 for(const invalid of [{followUpDate:'2026-02-30'},{contactSourceUrl:'javascript:alert(1)'},{status:'sent-automatically'},{version:-1}])assert.equal((await app.call(`/outreach/${prospect.id}`,'PUT',{...research,...invalid})).status,400);
 assert.equal((await app.call(`/outreach/${prospect.id}/drafts`,'POST',{requestId:id,channel:'email',subject:'Hi',body:''})).status,400);
 }finally{await app.close();}
});
test('research persists, dates remain calendar dates, and stale edits cannot overwrite another tab',async()=>{
 const app=await fixture();try{await app.signIn();const prospect=await app.add();assert.equal((await app.call(`/outreach/${prospect.id}`)).data.research.version,0);
 const saved=await app.call(`/outreach/${prospect.id}`,'PUT',research);assert.equal(saved.status,200);assert.deepEqual(saved.data.research,{...research,version:1});
 assert.deepEqual((await app.call(`/outreach/${prospect.id}`)).data.research,saved.data.research);
 assert.equal((await app.call(`/outreach/${prospect.id}`,'PUT',{...research,notes:'Must not overwrite'})).status,409);
 assert.equal((await app.call(`/outreach/${prospect.id}`)).data.research.notes,'Called once');
 }finally{await app.close();}
});
test('manual drafts work without AI, save idempotently, retain snapshots, and use optimistic edit versions',async()=>{
 const app=await fixture();try{await app.signIn();const prospect=await app.add();const id=randomUUID(),fields={requestId:id,channel:'email',subject:'Hello',body:'A manually written message'};
 const saved=await app.call(`/outreach/${prospect.id}/drafts`,'POST',fields);assert.equal(saved.status,201);assert.deepEqual(saved.data.draft.sources,[source]);assert.equal(saved.data.draft.origin,'manual');
 assert.equal((await app.call(`/outreach/${prospect.id}/drafts`,'POST',fields)).data.draft.id,id);
 assert.equal((await app.call(`/outreach/${prospect.id}/drafts`,'POST',{...fields,body:'Changed retry'})).status,409);
 const edited=await app.call(`/outreach/${prospect.id}/drafts/${id}`,'PUT',{channel:'linkedin',subject:'Must be blank',body:'Edited message',version:1});assert.equal(edited.data.draft.subject,'');assert.equal(edited.data.draft.version,2);
 assert.equal((await app.call(`/outreach/${prospect.id}/drafts/${id}`,'PUT',{channel:'email',subject:'Stale',body:'Stale',version:1})).status,409);
 const another=await app.add({name:'Another',website:'https://another.example'});assert.equal((await app.call(`/outreach/${another.id}/drafts/${id}`,'PUT',{channel:'email',subject:'x',body:'x',version:2})).status,404);
 assert.equal((await app.call(`/outreach/${prospect.id}`)).data.total,1);
 }finally{await app.close();}
});
test('generation is on demand and cached by public evidence, channel and purpose; private fields stay out',async()=>{
 let calls=0;let context:any;
 const app=await fixture({drafter:{generate:async(input)=>{calls++;context=input;return result;}}});try{await app.signIn();const prospect=await app.add();assert.equal(calls,0);
 const input={requestId:randomUUID(),channel:'email',purpose:'Introduce storyboarding',prospectVersion:prospect.version};
 const first=await app.call(`/outreach/${prospect.id}/generate`,'POST',input);assert.equal(first.status,201);assert.equal(first.data.draft.status,'completed');assert.equal(calls,1);
 assert.deepEqual(Object.keys(context).sort(),['category','channel','name','purpose','sources']);assert.equal(JSON.stringify(context).includes('private@example.com'),false);assert.equal(JSON.stringify(context).includes('Internal'),false);
 const cached=await app.call(`/outreach/${prospect.id}/generate`,'POST',{...input,requestId:randomUUID()});assert.equal(cached.data.cached,true);assert.equal(cached.data.draft.id,first.data.draft.id);assert.equal(calls,1);
 assert.equal((await app.call(`/outreach/${prospect.id}/generate`,'POST',{...input,purpose:'Different goal'})).status,409);
 await app.call(`/outreach/${prospect.id}/generate`,'POST',{...input,requestId:randomUUID(),channel:'linkedin'});assert.equal(calls,2);
 const state=(await app.call(`/outreach/${prospect.id}`)).data;assert.equal(state.generationsRemaining,8);assert.equal(state.drafts[0].subject,'');
 }finally{await app.close();}
});
test('missing excerpts, stale prospect versions and absent AI keys prevent provider calls',async()=>{
 let calls=0;const app=await fixture({drafter:{generate:async()=>{calls++;return result;}}});try{await app.signIn();const prospect=await app.add({sources:[{...source,note:''}]});
 const input={requestId:randomUUID(),channel:'email',purpose:'Say hello',prospectVersion:prospect.version};assert.equal((await app.call(`/outreach/${prospect.id}/generate`,'POST',input)).status,400);
 assert.equal((await app.call(`/outreach/${prospect.id}/generate`,'POST',{...input,prospectVersion:prospect.version+1})).status,409);assert.equal(calls,0);
 }finally{await app.close();}
 const missing=await fixture();try{await missing.signIn();const p=await missing.add();assert.equal((await missing.call(`/outreach/${p.id}/generate`,'POST',{requestId:randomUUID(),channel:'email',purpose:'Hello',prospectVersion:p.version})).status,503);}finally{await missing.close();}
});
test('failed generation retains history without exposing internals and does not alter existing drafts',async()=>{
 const app=await fixture({drafter:{generate:async()=>{throw new Error('secret backend detail');}}});try{await app.signIn();const prospect=await app.add();
 const prior=await app.call(`/outreach/${prospect.id}/drafts`,'POST',{requestId:randomUUID(),channel:'email',subject:'Keep',body:'Saved manual draft'});
 const failed=await app.call(`/outreach/${prospect.id}/generate`,'POST',{requestId:randomUUID(),channel:'email',purpose:'Hello',prospectVersion:prospect.version});assert.equal(failed.data.draft.status,'failed');assert.equal(JSON.stringify(failed.data).includes('secret'),false);
 const state=(await app.call(`/outreach/${prospect.id}`)).data;assert.equal(state.total,2);assert.equal(state.drafts.find((item:any)=>item.id===prior.data.draft.id).body,'Saved manual draft');
 }finally{await app.close();}
});
test('concurrent identical requests share one generation; stale work expires and daily quota persists',async()=>{
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),hold=new Promise<void>(resolve=>release=resolve);let calls=0;
 const app=await fixture({drafter:{generate:async()=>{calls++;started();await hold;return result;}}});try{await app.signIn();const p=await app.add();const input={requestId:randomUUID(),channel:'email',purpose:'Hello',prospectVersion:p.version};
 const pending=app.call(`/outreach/${p.id}/generate`,'POST',input);await ready;
 assert.equal((await app.call(`/outreach/${p.id}/generate`,'POST',{...input,requestId:randomUUID()})).data.draft.status,'running');
 assert.equal((await app.call(`/outreach/${p.id}/generate`,'POST',{...input,requestId:randomUUID(),purpose:'Other'})).status,409);release();await pending;assert.equal(calls,1);
 for(let i=0;i<9;i++)await app.pool.query("INSERT INTO outreach_drafts(id,prospect_id,channel,origin,status,prospect_version) VALUES($1,$2,'email','ai','failed',1)",[randomUUID(),p.id]);
 assert.equal((await app.call(`/outreach/${p.id}/generate`,'POST',{...input,requestId:randomUUID(),purpose:'New goal'})).status,429);
 assert.equal((await app.call(`/outreach/${p.id}/generate`,'POST',{...input,requestId:randomUUID()})).data.cached,true);assert.equal(calls,1);
 await app.pool.query("INSERT INTO outreach_drafts(id,prospect_id,channel,origin,status,prospect_version,created_at) VALUES($1,$2,'email','ai','running',1,NOW()-INTERVAL '3 minutes')",[randomUUID(),p.id]);
 const state=(await app.call(`/outreach/${p.id}`)).data;assert.equal(state.generationsRemaining,0);assert.equal(state.drafts.some((item:any)=>item.status==='running'),false);
 }finally{release();await app.close();}
});
test('free-model transport restricts spending, validates exact quotes and never accepts invented evidence',async()=>{
 const requests:any[]=[];const {model,...body}=result;
 const fetcher=(async(url:unknown,options:any)=>{requests.push({url,...options,body:JSON.parse(options.body)});return new Response(JSON.stringify({model,choices:[{message:{content:JSON.stringify(body)}}]}));}) as typeof fetch;
 const context={name:'Synthetic Studio',category:'production_company',channel:'email' as const,purpose:'Hello',sources:[source]};
 assert.deepEqual(await createOpenRouterDrafter('test-only-secret',fetcher)!.generate(context),result);
 assert.equal(requests[0].body.model,'openrouter/free');assert.deepEqual(requests[0].body.provider.max_price,{prompt:0,completion:0});assert.equal(requests[0].body.tools,undefined);assert.equal(requests[0].body.plugins,undefined);
 const bad=(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...body,evidence:[{sourceIndex:1,quote:'Invented claim'}]})}}]}))) as typeof fetch;
 await assert.rejects(()=>createOpenRouterDrafter('test',bad)!.generate(context),/support/);
 const failure=(async()=>new Response('secret provider details',{status:401})) as typeof fetch;await assert.rejects(()=>createOpenRouterDrafter('test',failure)!.generate(context),/API key/);
});

test('changing an AI draft channel preserves it while allowing a fresh generation for the original channel',async()=>{
 let calls=0;const app=await fixture({drafter:{generate:async()=>{calls++;return result;}}});try{await app.signIn();const p=await app.add();
 const input={requestId:randomUUID(),channel:'email',purpose:'Introduce storyboarding',prospectVersion:p.version};const first=(await app.call(`/outreach/${p.id}/generate`,'POST',input)).data.draft;
 const edited=await app.call(`/outreach/${p.id}/drafts/${first.id}`,'PUT',{channel:'linkedin',subject:'',body:'Edited LinkedIn message',version:first.version});assert.equal(edited.status,200);
 const fresh=await app.call(`/outreach/${p.id}/generate`,'POST',{...input,requestId:randomUUID()});assert.equal(fresh.data.cached,false);assert.equal(fresh.data.draft.channel,'email');assert.notEqual(fresh.data.draft.id,first.id);assert.equal(calls,2);
 const history=(await app.call(`/outreach/${p.id}`)).data.drafts;assert.equal(history.find((item:any)=>item.id===first.id).body,'Edited LinkedIn message');
 }finally{await app.close();}
});
