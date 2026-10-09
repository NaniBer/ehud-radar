import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import { createApp } from '../../app.js';
import { migrateDatabase } from '../../db/database.js';
import { createOpenRouterAssessor, createSerperSearch, createTavilySearch, DiscoveryError, type Assessor, type SearchProvider } from './providers.js';

const env = dotenv.parse(readFileSync(new URL('../../../../../.env',import.meta.url)));
const connectionString = process.env.TEST_DATABASE_URL || env.DATABASE_URL;
const origin='http://127.0.0.1:5174';
const source={title:'Test Films',url:'https://films.example/work',content:'Test Films produces commercials and music videos.'};
const fit={name:'Test Films',relevance:'Could suit creative production workflows; confirm interest.',confidence:'medium' as const,evidenceQuotes:['produces commercials'],caveats:['Location and contact details are unverified.'],model:'test/free'};
const {model: _testModel, ...fitBody}=fit;
async function fixture(options:{searchProvider?:SearchProvider;assessor?:Assessor;noSearch?:boolean}={}){
  const schema=`discovery_test_${randomBytes(8).toString('hex')}`;
  const admin=new pg.Pool({connectionString});await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});await migrateDatabase(pool);await migrateDatabase(pool);
  const setupToken=randomBytes(32).toString('hex');
  const application=createApp({pool,schemaName:schema,origin,secret:randomBytes(32).toString('hex'),setupToken,
    searchProvider:options.noSearch?undefined:options.searchProvider||{name:'Test search',search:async()=>[source]},assessor:options.assessor});
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
    async search(extra:object={}){return call('/discovery/runs','POST',{requestId:randomUUID(),category:'production_company',location:'Ethiopia',...extra});},
    async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));application.store.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}};
}

test('discovery is authenticated; all mutations enforce origin and CSRF; invalid inputs are rejected',async()=>{
  const app=await fixture();try{
    const id=randomUUID();
    for(const path of ['/discovery/state','/discovery/runs',`/discovery/runs/${id}`])assert.equal((await app.call(path)).status,401);
    for(const path of ['/discovery/runs',`/discovery/candidates/${id}/save`,`/discovery/candidates/${id}/dismiss`,`/discovery/candidates/${id}/assess`])assert.equal((await app.call(path,'POST',{})).status,401);
    await app.signIn();
    for(const path of ['/discovery/runs',`/discovery/candidates/${id}/save`,`/discovery/candidates/${id}/dismiss`,`/discovery/candidates/${id}/assess`]){
      assert.equal((await app.call(path,'POST',{}, {origin:'https://attacker.example'})).status,403);
      assert.equal((await app.call(path,'POST',{}, {csrf:''})).status,403);
    }
    assert.equal((await app.search({location:' '})).status,400);
    assert.equal((await app.search({category:'wrong'})).status,400);
    assert.equal((await app.search({limit:11})).status,400);
    assert.equal((await app.call('/discovery/runs/nope')).status,400);
    assert.equal((await app.call(`/discovery/runs/${id}`)).status,404);
    assert.equal((await app.call('/discovery/runs?page=0')).status,400);
    assert.equal((await app.call(`/discovery/candidates/${id}/save`,'POST',{fields:{name:'A',category:'brand'}})).status,404);
  }finally{await app.close();}
});

test('search persists evidence and history, removes duplicate/unsafe URLs, and repeats a request without another provider call',async()=>{
  let calls=0;let query='';
  const app=await fixture({searchProvider:{name:'Test search',async search(q){calls++;query=q;return [source,{...source,url:'http://www.films.example/work/?utm_source=feed#x'},{...source,url:'javascript:alert(1)'},{title:'Another',url:'https://another.example',content:'Other source'}];}}});
  try{await app.signIn();const requestId=randomUUID();const result=await app.search({requestId,keywords:'advertising'});
    assert.equal(result.status,201);assert.equal(result.data.run.status,'completed');assert.equal(result.data.candidates.length,2);
    assert.equal(query,'film production companies Ethiopia advertising');assert.equal(result.data.candidates[0].snippet,source.content);
    assert.equal(result.data.candidates[0].assessment,null);assert.equal((await app.pool.query('SELECT COUNT(*) FROM prospects')).rows[0].count,'0');
    assert.deepEqual((await app.call(`/discovery/runs/${requestId}`)).data,result.data);
    assert.equal((await app.search({requestId,keywords:'advertising'})).status,200);assert.equal(calls,1);
    assert.equal((await app.search({requestId,keywords:'changed'})).status,409);
    const history=await app.call('/discovery/runs');assert.equal(history.data.total,1);assert.equal(history.data.runs[0].candidateCount,2);
    assert.equal((await app.call('/discovery/runs?page=2')).data.runs.length,0);
  }finally{await app.close();}
});

test('provider failures are retained without exposing internal errors; empty results are a successful search',async()=>{
  let mode='fail';const app=await fixture({searchProvider:{name:'Test search',async search(){if(mode==='fail')throw new Error('secret provider detail');return [];}}});
  try{await app.signIn();const failed=await app.search();assert.equal(failed.data.run.status,'failed');assert.equal(JSON.stringify(failed.data).includes('secret'),false);
    mode='empty';const empty=await app.search();assert.equal(empty.data.run.status,'completed');assert.deepEqual(empty.data.candidates,[]);
    assert.equal((await app.call('/discovery/runs')).data.total,2);
  }finally{await app.close();}
});

test('one concurrent search is allowed, stale runs recover, and the persisted daily cap prevents extra requests',async()=>{
  let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const wait=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const app=await fixture({searchProvider:{name:'Test search',async search(){calls++;started();await wait;return [source];}}});
  try{await app.signIn();const pending=app.search();await ready;assert.equal((await app.search()).status,409);release();await pending;
    await app.pool.query("INSERT INTO discovery_runs(id,category,location,query,result_limit,provider,status,created_at) VALUES ($1,'brand','Ethiopia','old',5,'test','running',NOW()-INTERVAL '3 minutes')",[randomUUID()]);
    await app.call('/discovery/state');assert.equal((await app.pool.query("SELECT COUNT(*) FROM discovery_runs WHERE status='running'")).rows[0].count,'0');
    for(let i=0;i<18;i++)await app.pool.query("INSERT INTO discovery_runs(id,category,location,query,result_limit,provider,status) VALUES ($1,'brand','Ethiopia','quota',5,'test','completed')",[randomUUID()]);
    assert.equal((await app.search()).status,429);assert.equal(calls,1);assert.equal((await app.call('/discovery/state')).data.searchesRemaining,0);
  }finally{release();await app.close();}
});

test('candidate saves are atomic and idempotent, retain original evidence, and keep existing prospects unchanged',async()=>{
  const app=await fixture();try{await app.signIn();const run=await app.search();const item=run.data.candidates[0];
    const fields={name:'Reviewed Films',category:'production_company',website:source.url,notes:'Reviewed',sources:[]};
    const saved=await Promise.all([app.call(`/discovery/candidates/${item.id}/save`,'POST',{fields}),app.call(`/discovery/candidates/${item.id}/save`,'POST',{fields})]);
    assert.deepEqual(saved.map(result=>result.status),[200,200]);assert.equal(saved[0].data.prospect.id,saved[1].data.prospect.id);
    assert.deepEqual(saved[0].data.prospect.sources,[{title:source.title,url:source.url,note:source.content}]);
    assert.equal((await app.pool.query('SELECT COUNT(*) FROM prospects')).rows[0].count,'1');
    const second=(await app.search()).data.candidates[0];assert.equal(second.existingProspectId,saved[0].data.prospect.id);
    const duplicate=await app.call(`/discovery/candidates/${second.id}/save`,'POST',{fields:{...fields,notes:'Must not overwrite'}});
    assert.equal(duplicate.data.existing,true);assert.equal(duplicate.data.prospect.notes,'Reviewed');
    assert.equal((await app.call('/discovery/runs')).data.runs[0].savedCount,1);
    assert.equal((await app.call(`/discovery/candidates/${second.id}/save`,'POST',{fields:{...fields,website:'file:///tmp/private'}})).status,400);
    const dismissed=await app.call(`/discovery/candidates/${second.id}/dismiss`,'POST',{dismissed:true});assert.equal(dismissed.data.candidate.dismissed,true);
    assert.equal((await app.call(`/discovery/candidates/${second.id}/dismiss`,'POST',{dismissed:false})).data.candidate.dismissed,false);
  }finally{await app.close();}
});

test('fit assessment is on demand, persists and caches results, and errors do not prevent saving',async()=>{
  let calls=0;let fail=false;
  const app=await fixture({assessor:{model:'test/free',async assess(){calls++;if(fail)throw new DiscoveryError('The free model is rate limited.');return fit;}}});
  try{await app.signIn();const first=(await app.search()).data.candidates[0];assert.equal(calls,0);
    const assessed=await app.call(`/discovery/candidates/${first.id}/assess`,'POST',{});assert.deepEqual(assessed.data.candidate.assessment,fit);
    await app.call(`/discovery/candidates/${first.id}/assess`,'POST',{});assert.equal(calls,1);
    const second=(await app.search()).data.candidates[0];fail=true;
    const failed=await app.call(`/discovery/candidates/${second.id}/assess`,'POST',{});assert.equal(failed.data.candidate.assessmentStatus,'failed');
    assert.equal((await app.call(`/discovery/candidates/${second.id}/save`,'POST',{fields:{name:'Manual',category:'other'}})).status,200);
    for(let i=0;i<18;i++)await app.pool.query("INSERT INTO discovery_assessments(id,candidate_id,status) VALUES ($1,$2,'failed')",[randomUUID(),first.id]);
    assert.equal((await app.call(`/discovery/candidates/${second.id}/assess`,'POST',{})).status,429);assert.equal(calls,2);
  }finally{await app.close();}
});

test('missing provider keys give actionable state and never pretend that search succeeded',async()=>{
  const app=await fixture({noSearch:true});try{await app.signIn();const state=await app.call('/discovery/state');assert.equal(state.data.searchReady,false);assert.equal(state.data.aiReady,false);
    assert.equal((await app.search()).status,503);assert.equal((await app.call('/discovery/runs')).data.total,0);
    assert.equal((await app.call(`/discovery/candidates/${randomUUID()}/assess`,'POST',{})).status,503);
  }finally{await app.close();}
});

test('provider requests use Basic search and only free AI without online tools; assessments must quote supplied evidence',async()=>{
  const requests:any[]=[];
  const fakeFetch=(async(url:unknown,options:any)=>{requests.push({url,...options,body:JSON.parse(options.body)});return new Response(JSON.stringify(String(url).includes('tavily')?{results:[source]}:{model:'test/free',choices:[{message:{content:JSON.stringify(fitBody)}}]}),{status:200});}) as typeof fetch;
  assert.deepEqual(await createTavilySearch('test-secret',fakeFetch)!.search('query',5),[source]);
  assert.equal(requests[0].body.search_depth,'basic');assert.equal(requests[0].body.auto_parameters,false);
  assert.deepEqual(await createOpenRouterAssessor('test-secret','openrouter/free',fakeFetch)!.assess(source,'agency','Ethiopia'),fit);
  const body=requests[1].body;assert.equal(body.model,'openrouter/free');assert.equal(body.tools,undefined);assert.equal(body.plugins,undefined);assert.deepEqual(body.provider.max_price,{prompt:0,completion:0});
  assert.throws(()=>createOpenRouterAssessor('test-secret','paid/model'));
  const ungrounded=(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...fitBody,evidenceQuotes:['Invented evidence']})}}]}))) as typeof fetch;
  await assert.rejects(()=>createOpenRouterAssessor('test-secret','openrouter/free',ungrounded)!.assess(source,'agency','Ethiopia'),/ground/);
  const failure=(async()=>new Response('secret provider output',{status:401})) as typeof fetch;
  await assert.rejects(()=>createTavilySearch('test-secret',failure)!.search('query',5),/API key/);
  const serper=(async()=>new Response(JSON.stringify({organic:[{title:source.title,link:source.url,snippet:source.content}]}))) as typeof fetch;
  assert.deepEqual(await createSerperSearch('test-secret',serper)!.search('query',5),[source]);
});
