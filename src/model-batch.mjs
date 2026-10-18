import {AsyncLocalStorage} from 'node:async_hooks';

// One source check / cycle shares this scope across extraction and matching.
// It limits repeated known failures, without suppressing source acquisition.
export function createModelBatch({recordAttempt,reserveAutomatic}={}) {
 const context=new AsyncLocalStorage();
 const run=(work,{automatic=false}={})=>{
  const state=context.getStore();
  if(!state)return context.run({failures:0,blocked:null,automatic},work);
  // A scheduled entry cannot evade its budget by being nested in a manual batch.
  return automatic&&!state.automatic?context.run({...state,automatic:true},work):work();
 };
 const guard=(processor,method)=>processor?{...processor,[method]:async(...args)=>{
  const state=context.getStore();
  if(state?.blocked){const error=Error('本批后续模型调用已暂停：'+state.blocked.message);error.receipt={completed:false,failureCategory:'batch_deferred',causeCategory:state.blocked.category};throw error;}
  const reservation=state?.automatic?reserveAutomatic?.({method}):null;
  let result;
  try{result=await processor[method](...args);}
  catch(error) {
   recordAttempt?.({method,receipt:error.receipt,...reservation});
   const category=error.receipt?.failureCategory;
   const systemic=['quota','rate_limit','authentication','model','configuration','connection','service','timeout','unknown','events','process','protocol'].includes(category);
   if(state&&systemic){state.failures++;if(['quota','authentication','model','configuration'].includes(category)||state.failures>=3)state.blocked={category,message:error.message};}
   throw error;
  }
  recordAttempt?.({method,receipt:result?.receipt,...reservation});
  if(state)state.failures=0;return result;
 }}:processor;
 return {run,guard,isAutomatic:()=>context.getStore()?.automatic===true};
}
