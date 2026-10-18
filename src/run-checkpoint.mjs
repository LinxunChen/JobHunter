const pick=(value,keys)=>value==null?value:Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
export const stepResult=result=>{
 const value=pick(result,['id','sourceId','status','stage','error','gaps','considered','pendingJobIds','results','limit','profileId','profileVersion','change','nextCheckAt','nextSundayCheck','capability','recovery']);
 if(value?.capability&&value.results)value.results=value.results.map(item=>({id:item.id,kind:item.kind,result:pick(item.result,['id','status','finalResult'])}));
 return value;
};
const draft=value=>pick(value,['id','kind','status','date']);
export function runCheckpoint(run) {
 return {...pick(run,['id','date','scheduledFor','trigger','status','startedAt','finishedAt','resumedAt','resumeCount','cycleAttempts','retryAt','owner','sources','gaps','recovery','legacySnapshot']),storageVersion:2,
  steps:run.steps.map(entry=>({...pick(entry,['key','status','startedAt','finishedAt','attempts']),result:stepResult(entry.result),history:(entry.history??[]).map(item=>({...pick(item,['status','startedAt','finishedAt']),result:stepResult(item.result)}))})),
  jobs:stepResult(run.jobs),today:run.today?{checkedAt:run.today.checkedAt,dailyDigest:draft(run.today.dailyDigest),importantDraft:draft(run.today.importantDraft)}:undefined,
  coverage:run.coverage?{counts:run.coverage.counts}:undefined,
  notifications:run.notifications?{recovery:run.notifications.recovery,capability:run.notifications.capability,results:(run.notifications.results??[]).map(item=>({id:item.id,kind:item.kind,result:pick(item.result,['id','status','finalResult'])}))}:undefined,
 };
}
