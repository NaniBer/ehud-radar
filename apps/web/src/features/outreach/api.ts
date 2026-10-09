import { ProspectError, type Source } from '../prospects/api';
export type Channel='email'|'linkedin';
export type Research={version:number;researchSummary:string;contactRole:string;contactSourceUrl:string;status:'new'|'contacted'|'replied'|'follow_up'|'closed';followUpDate:string;notes:string};
export type Draft={id:string;prospectId:string;channel:Channel;purpose:string;origin:'manual'|'ai';status:'running'|'completed'|'failed';subject:string;body:string;evidence:{sourceIndex:number;quote:string}[];caveats:string[];sources:Source[];model:string;error:string;version:number;prospectVersion:number;createdAt:string;updatedAt:string};
export type OutreachData={research:Research;drafts:Draft[];total:number;page:number;pageSize:number;aiReady:boolean;generationsRemaining:number;dailyLimit:number};
export async function outreachRequest<T>(path:string,options:{method?:'GET'|'POST'|'PUT';body?:object;csrfToken?:string;signal?:AbortSignal}={}):Promise<T>{
  let response:Response;
  try{response=await fetch(`/api/outreach${path}`,{method:options.method||'GET',credentials:'same-origin',
    headers:options.body?{'Content-Type':'application/json','X-CSRF-Token':options.csrfToken||''}:undefined,
    body:options.body?JSON.stringify(options.body):undefined,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
  }catch(error){if(options.signal?.aborted)throw error;throw new ProspectError('The request could not finish. Your edits are still here. Check saved draft history before generating again.',0);}
  const data=await response.json().catch(()=>null);if(!response.ok)throw new ProspectError(data?.error||'Research and drafts are unavailable. Try again.',response.status);return data as T;
}
