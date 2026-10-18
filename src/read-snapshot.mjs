import {AsyncLocalStorage} from 'node:async_hooks';

// Reuse derived reads only inside one computation. No data survives a request.
// Both same-connection writes and other-process commits invalidate the view.
// Read models are JSON objects/arrays. Reuse immutable strings instead of
// repeatedly serializing large original texts through the structured clone engine.
function copy(value,seen=new Map()) {
 if(value===null||typeof value!=='object')return value;
 if(seen.has(value))return seen.get(value);
 const prototype=Object.getPrototypeOf(value);
 if(!Array.isArray(value)&&prototype!==Object.prototype&&prototype!==null)return structuredClone(value);
 const result=Array.isArray(value)?[]:Object.create(prototype);seen.set(value,result);
 for(const key of Object.keys(value))result[key]=copy(value[key],seen);
 return result;
}
export function createReadSnapshot({revision,clock=()=>new Date()}) {
 const context=new AsyncLocalStorage();
 const run=work=>context.getStore()?work():context.run({revision:revision(),time:clock(),values:new Map(),readDepth:0},work);
 const memoize=(name,work,{copyResult=true}={})=>(...args)=>{
  const state=context.getStore();if(!state)return work(...args);
  if(state.readDepth===0){const current=revision();
   if(current!==state.revision){state.values.clear();state.revision=current;}
  }
  const keyArgs=name==='listJobs'?[args[0]??{}]:name==='listJobView'?[args[0]??'all',args[1]??{}]:name==='getRecruitmentState'?[args[0],{at:args[1]?.at??state.time.toISOString(),includeHistory:args[1]?.includeHistory??true}]:args;
  const key=name+'|'+JSON.stringify(keyArgs);
  if(state.values.has(key))return copyResult?copy(state.values.get(key)):state.values.get(key);
  state.readDepth++;
  try{const value=work(...args);state.values.set(key,copyResult?copy(value):value);return value;}
  finally{state.readDepth--;}
 };
 return {run,memoize,now:()=>new Date(context.getStore()?.time??clock())};
}
