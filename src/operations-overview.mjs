import {beijingDay} from './beijing-time.mjs';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from './processing-owner.mjs';
import {createHash} from 'node:crypto';
import {groupOperationIssues,issueCategoryLabels} from './operation-issues.mjs';

// Overview carries coverage summaries. Raw responses and attachments remain in source history.
const summarizeCheck=run=>{
 if(!run)return null;
 const fields=['id','sourceId','status','trigger','checkedAt','error','gaps','failureCategory','stage','listOnly','listCount','listComplete','catalogCount','catalogComplete','platformListComplete','attachmentsChecked','verification'];
 const result=Object.fromEntries(fields.filter(key=>Object.hasOwn(run,key)).map(key=>[key,run[key]]));
 result.coverage={...run.coverage};
 for(const key of ['details','platformDetails','pages','catalogPages','platformPages','platformJobs'])if(Array.isArray(run[key]))result.coverage[key]=run[key].length;
 if(run.jobIds)result.jobIds=run.jobIds;
 if(run.announcements){const files=run.announcements.flatMap(item=>item.attachments??[]);Object.assign(result.coverage,{announcements:run.announcements.length,attachments:files.length,attachmentsObtained:files.filter(file=>file.status===200).length});}
 return result;
};
const changeLabels={added:'岗位新增',operated:'岗位操作',deadline:'岗位临期'};
const legacyChangeLabels={ended:'新确认结束',suspected_offline:'疑似下线',entered:'可考虑岗位进入',left:'可考虑岗位移出'};
const allChangeLabels={...changeLabels,...legacyChangeLabels};
export {changeLabels,allChangeLabels};
export function operationalChangeRange(date,period='day') {
 if(period==='day')return {startDate:date,endDate:date};
 const at=Date.parse(date+'T04:00:00Z'),offset=(new Date(at).getUTCDay()+6)%7;
 const start=at-offset*86400000;
 return {startDate:new Date(start).toISOString().slice(0,10),endDate:new Date(start+6*86400000).toISOString().slice(0,10)};
}
const progressFor=(run,sources,at)=>{
    const current=run?.steps?.find(step=>step.status==='started');
    return {checked:run?.sources?.length??0,total:sources.filter(source=>source.implemented).length,currentStep:current?.key??null,currentSourceId:current?.key?.startsWith('source:')?current.key.slice(7):null,lastProgressAt:[run?.startedAt,run?.resumedAt,...(run?.steps??[]).flatMap(step=>[step.startedAt,step.finishedAt])].filter(Boolean).sort().at(-1)??null,elapsedMinutes:run?Math.max(0,Math.floor((Date.parse(at)-Date.parse(run.startedAt))/60000)):0};
};
export function createOperationsOverview({db,application,now,verificationMode,ValidationError}) {
 db.exec(`CREATE TABLE IF NOT EXISTS operational_state (id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_transitions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS scheduler_activity (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
 const parse=row=>row?JSON.parse(row.body):null;
 const stamp=()=>now().toISOString();
 const get=()=>parse(db.prepare('SELECT body FROM operational_state WHERE id=?').get('baseline'));
 const snapshot=jobIds=>Object.fromEntries((jobIds?jobIds.map(id=>application.getJobView(id,{includeHistory:false})).filter(Boolean):application.listJobView()).map(job=>[job.id,{jobId:job.id,title:job.title,recruitmentUnit:job.recruitmentUnit,group:job.display.group,status:job.recruitment.status,reason:job.display.exclusionReason??job.display.recruitment.label}]));
 const saveState=value=>db.prepare('INSERT INTO operational_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run('baseline',JSON.stringify(value));
 if(!verificationMode&&!get())saveState({startedAt:stamp(),checkedAt:stamp(),jobs:snapshot()});
 const operations={
  recordOperationalChanges({jobIds}={}) {
   if(verificationMode)throw new ValidationError('恢复核对模式不记录变化');
   const prior=get(),at=stamp();if(!prior||prior.checkedAt>at)return;
   const jobs=snapshot(jobIds);db.exec('SAVEPOINT operational_changes');
   try {
    for(const item of Object.values(jobs)) {
     const old=prior.jobs[item.jobId];
     const kinds=[];
     if(old&&old.status!==item.status&&['ended','suspected_offline'].includes(item.status))kinds.push(item.status);
     if(!old&&item.group==='active')kinds.push('entered');
     if(old&&old.group!==item.group){if(item.group==='active')kinds.push('entered');else if(old.group==='active'||item.group==='history')kinds.push('left');}
     for(const kind of kinds) {
      const date=beijingDay(at),id=createHash('sha256').update([date,item.jobId,kind].join('|')).digest('hex');
      const reason=kind==='entered'?(old?'当前资格、匹配或招聘证据恢复，回到活跃表':'新入库岗位进入活跃表，资格与匹配按岗位依据展示'):item.reason;
      const event={...item,id,date,kind,label:allChangeLabels[kind],at,before:old??null,reason};
      db.prepare('INSERT OR IGNORE INTO job_transitions VALUES(?,?)').run(id,JSON.stringify(event));
     }
    }
    saveState({...prior,checkedAt:at,jobs:jobIds?{...prior.jobs,...jobs}:jobs});db.exec('RELEASE operational_changes');
   }catch(error){db.exec('ROLLBACK TO operational_changes; RELEASE operational_changes');throw error;}
  },
  getOperationalChanges({date=beijingDay(stamp()),kind,period='day'}={}) {
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||(kind&&!Object.hasOwn(allChangeLabels,kind))||!['day','week'].includes(period))throw new ValidationError('变化日期、类型或周期无效');
   const {startDate,endDate}=operationalChangeRange(date,period),included=day=>day>=startDate&&day<=endDate;
   const added=application.listJobs().filter(job=>Number.isFinite(Date.parse(job.firstDiscoveredAt))&&included(beijingDay(job.firstDiscoveredAt))).map(job=>({jobId:job.id,title:job.title,recruitmentUnit:job.recruitmentUnit,date:beijingDay(job.firstDiscoveredAt),at:job.firstDiscoveredAt,kind:'added',label:changeLabels.added,reason:'首次正式入库；来源线索不计入岗位数'}));
   const transitions=db.prepare("SELECT t.body FROM history_records h JOIN job_transitions t ON t.id=h.id WHERE h.kind='job_transitions' AND h.date>=? AND h.date<=? ORDER BY h.ordinal DESC").all(startDate,endDate).map(parse);
   const jobMap=new Map(application.listJobs().map(job=>[job.id,job]));
   const marks=[...application.listPersonalMarkEvents(),...application.listApplications().flatMap(application=>application.events.filter(event=>['applied','correction'].includes(event.type)).map(event=>({jobId:application.jobId,at:event.recordedAt,actions:[{field:'applied',after:event.type==='applied'}]})))];
   const operated=marks.filter(event=>jobMap.has(event.jobId)&&included(beijingDay(event.at))&&event.at<=stamp()).map(event=>({jobId:event.jobId,title:jobMap.get(event.jobId).title,recruitmentUnit:jobMap.get(event.jobId).recruitmentUnit,date:beijingDay(event.at),at:event.at,kind:'operated',label:changeLabels.operated,reason:event.actions.map(action=>({followed:action.after?'关注':'取消关注',notInterested:action.after?'排除':'取消排除',applied:action.after?'标记已投递':'撤销已投递误勾'}[action.field])).join('、')}));
   // Near-deadline is a current snapshot, not a fabricated historical change event.
   const deadline=included(beijingDay(stamp()))&&(!kind||kind==='deadline')?application.listJobView().filter(job=>job.display.registration.urgent&&job.display.group!=='history').map(job=>({jobId:job.id,title:job.title,recruitmentUnit:job.recruitmentUnit,date:beijingDay(stamp()),at:stamp(),kind:'deadline',label:changeLabels.deadline,reason:`官方截止 ${job.display.registration.deadlineLabel}；${job.display.registration.remainingDays===0?'今日截止':'剩余 '+job.display.registration.remainingDays+' 天'}`})):[];
   const items=[...added,...transitions,...operated,...deadline].filter(item=>!kind||item.kind===kind);
   if(period==='day')return items;
   // Count jobs per change type for the week, keeping the latest recorded reason.
   return [...new Map(items.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).map(item=>[item.jobId+'|'+item.kind,item])).values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  },
  beginSchedulerActivity() {
   const value={id:'latest',owner:beginProcessingOwner(),startedAt:stamp(),finishedAt:null,status:'running'};
   db.prepare('INSERT INTO scheduler_activity VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run('latest',JSON.stringify(value));return value;
  },
  finishSchedulerActivity(tick,result) {
   const latest=parse(db.prepare('SELECT body FROM scheduler_activity WHERE id=?').get('latest'));
   if(latest?.owner.id===tick.owner.id)db.prepare('UPDATE scheduler_activity SET body=? WHERE id=?').run(JSON.stringify({...tick,finishedAt:stamp(),status:result?.status??'failed',nextCheckAt:result?.nextCheckAt??result?.retryAt??null}),'latest');
   endProcessingOwner(tick.owner);
  },
  getOperationsProgress() {
   const at=stamp(),date=beijingDay(at),revision=date+':'+application.getOperationsRevision();
   const lock=parse(db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle'));
   const signal=parse(db.prepare('SELECT body FROM scheduler_activity WHERE id=?').get('latest'));
   const active=lock&&processingOwnerAlive(lock.owner)!==false;
   const run=active&&lock.runId?application.getScheduledRun(lock.runId):null;
   const sources=db.prepare("SELECT id,json_extract(body,'$.name') name FROM source_registry WHERE json_extract(body,'$.implemented')=1").all().map(source=>({...source,implemented:true}));
   const progress=run?progressFor(run,sources,at):null;
   if(progress)progress.currentSourceName=sources.find(source=>source.id===progress.currentSourceId)?.name??null;
   const status=signal?.status==='running'&&processingOwnerAlive(signal.owner)===true?'checking':!signal?'no_signal':Date.parse(at)-Date.parse(signal.finishedAt??signal.startedAt)>180000?'stale':'online';
   return {at,date,revision,busy:active?{runId:lock.runId??null,taskId:lock.taskId??null,date:run?.date??null,progress}:null,scheduler:{status,lastActivityAt:signal?.finishedAt??signal?.startedAt??null}};
  },
  getOperationsOverview() {
   const at=stamp(),date=beijingDay(at),revision=date+':'+application.getOperationsRevision(),coverage=application.getSourcesOverview({historyLimit:1});
   const dates=Array.from({length:7},(_,n)=>beijingDay(new Date(Date.parse(date+'T04:00:00Z')-n*86400000).toISOString()));
   const runs=dates.flatMap(value=>application.listRunSummaries({fromDate:value,toDate:value,limit:1}));
   const signal=parse(db.prepare('SELECT body FROM scheduler_activity WHERE id=?').get('latest'));
   const lock=parse(db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle'));
   const live=signal?.status==='running'&&processingOwnerAlive(signal.owner)===true;
   const scheduler={...signal,status:live?'checking':!signal?'no_signal':Date.parse(at)-Date.parse(signal.finishedAt??signal.startedAt)>180000?'stale':'online',lastActivityAt:signal?.finishedAt??signal?.startedAt??null};
   const runProgress=run=>progressFor(run,coverage.sources,at);
   const latestBackup=application.listBackups()[0];
   const days=dates.map(date=>{
    const run=runs.find(run=>run.date===date);
    let status=!run?'not_run':run.status==='running'&&processingOwnerAlive(run.owner)===false?'interrupted':run.status;
    let reconciledSourceCount=0;
    // Later checks update today's business view, never historical run records.
    const sources=(run?.sources??[]).map(source=>{
     if(date!==beijingDay(at)||!['completed','partial'].includes(status))return source;
     const latest=coverage.sources.find(x=>x.id===source.sourceId)?.latest;
     const step=run.steps?.find(x=>x.key==='source:'+source.sourceId);
     if(!latest||latest.id===source.checkId||beijingDay(latest.checkedAt)!==date||Date.parse(latest.checkedAt)<=Date.parse(step?.finishedAt??run.startedAt))return source;
     reconciledSourceCount++;
     return {...source,status:latest.status,checkId:latest.id,error:latest.error??null,gaps:latest.gaps??[],originalCheckId:source.checkId,checkedAt:latest.checkedAt};
    }),progress=runProgress(run);
    const backupStep=run?.steps?.find(step=>step.key==='backup');
    const reconciledBackup=Boolean(date===beijingDay(at)&&backupStep?.result?.status==='failed'&&latestBackup?.status==='verified'&&Date.parse(latestBackup.createdAt)>=Date.parse(backupStep.finishedAt??run.finishedAt??run.startedAt));
    if(reconciledSourceCount||reconciledBackup){
     const otherFailure=(run.gaps??[]).length||run.jobs?.status!=='completed'||run.steps?.some(step=>step.key==='career'&&['failed','partial'].includes(step.result?.status)||step.key==='backup'&&step.result?.status==='failed'&&!reconciledBackup);
     status=sources.every(x=>['success','paused','unsupported_type'].includes(x.status))&&!otherFailure?'completed':'partial';
    }
    const displayLabel={completed:'已完成',partial:run?.finishedAt?'已完成，有待处理':'有待处理',failed:'检查失败',running:progress.elapsedMinutes>=60?'检查耗时较长':'检查中',interrupted:'检查中断',not_run:'未运行'}[status]??'状态待核验';
    return {date,status,historicalStatus:run?.status??null,reconciledSourceCount,reconciledBackup,displayLabel,progress,sourceCounts:{success:sources.filter(x=>x.status==='success').length,partial:sources.filter(x=>x.status==='partial').length,failed:sources.filter(x=>x.status==='failed').length,unsupported:sources.filter(x=>x.status==='unsupported_type').length,paused:sources.filter(x=>x.status==='paused').length},runId:run?.id??null,startedAt:run?.startedAt??null,finishedAt:run?.finishedAt??null,sources,steps:(run?.steps??[]).map(step=>({key:step.key,status:step.status,result:{status:step.result?.status,gaps:step.result?.gaps}}))};
   });
   const today=days[0],todayRun=runs.find(run=>run.date===date),manualTask=application.listSourceCheckTasks?.({limit:1})[0];
   let nextCheckAt=date+'T01:00:00.000Z';
   if(todayRun&&['completed','partial'].includes(today.status))nextCheckAt=todayRun.retryAt??new Date(Date.parse(nextCheckAt)+86400000).toISOString();
   if(todayRun&&['running','interrupted','failed'].includes(today.status)&&nextCheckAt<=at)nextCheckAt=new Date(Date.parse(nextCheckAt)+86400000).toISOString();
   const processingIssues=application.listProcessingIssues().filter(x=>application.getSourceMonitoringStatus(x.sourceId).enabled);
   const knownProcessingSources=new Set(application.listProcessingIssues({includeResolved:true}).map(x=>x.sourceId));
   const processingQueue={deferred:processingIssues.filter(x=>x.status==='deferred').length,needsMaterial:processingIssues.filter(x=>x.status==='needs_material'&&x.retryPolicy!=='on_change').length,awaitingChange:processingIssues.filter(x=>x.status==='needs_material'&&x.retryPolicy==='on_change').length,matchingPending:pendingAutomaticMatches(application).map(x=>({jobId:x.id,title:x.title})),items:processingIssues.filter(x=>x.status!=='failed')};
   const issues=new Map(),budgetPending=[];
   const addIssue=(reason,entry)=>{if(/今日自动模型调用已达\d+次/.test(reason)){budgetPending.push({reason,...entry});return;}const key=reason.replace(/^https?:\/\/[^\s：]+：\s*/,'').replace(/\s+/g,' ').trim();const issue=issues.get(key)??{reason:key,items:[]};issue.items.push(entry);issues.set(key,issue);};
   for(const source of coverage.sources.filter(x=>x.monitoring.enabled)) {
    const latest=source.latest;
    if(latest&&['failed','partial'].includes(latest.status))for(const reason of [...new Set([latest.error,...(latest.gaps??[])].filter(Boolean))]){
     if(knownProcessingSources.has(source.id)&&/Codex|模型加工|本地加工进程|本批后续模型|今日自动模型/.test(reason))continue;
     addIssue(reason,{sourceId:source.id,name:source.name,checkId:latest.id,at:latest.checkedAt});
    }
   }
   for(const issue of processingIssues.filter(x=>x.status==='failed'))addIssue(issue.title+'：'+issue.reason,{sourceId:issue.sourceId,name:issue.title,announcementId:issue.announcementId,issueId:issue.id,at:issue.lastSeenAt,category:issue.category,diagnostics:issue.diagnostics});
   if(todayRun&&['failed','interrupted'].includes(today.status))addIssue('今日周期未完成，检查运行历史',{name:'每日周期',runId:todayRun.id});
   if(manualTask&&['failed','interrupted'].includes(manualTask.status))addIssue(manualTask.error??manualTask.reason??'手动检查未完成',{name:'手动检查',taskId:manualTask.id});
   const pendingIds=[...new Set([...(todayRun?.jobs?.pendingJobIds??[]),...(manualTask?.jobs?.pendingJobIds??[])])];
   const pendingJobs=(pendingIds.length?application.listJobView():[]).filter(job=>pendingIds.includes(job.id)&&application.isJobMonitoringEnabled(job.id)&&(!job.matching||job.matching.status!=='completed'||job.matching.stale||job.matching.profileStale));
   if(pendingJobs.length)addIssue(`${pendingJobs.length} 个岗位匹配尚未完成`,{name:'岗位匹配',jobIds:pendingJobs.map(x=>x.id),runId:todayRun?.id});
   for(const step of todayRun?.steps??[]) {
    if(step.key.startsWith('source:')||!['failed','partial','pending','unavailable'].includes(step.result?.status))continue;
    if(step.key==='career'&&application.getCareerRefresh()?.status==='completed')continue;
    if(step.key==='jobs'&&application.listCareerProfiles().length&& !pendingJobs.length)continue;
    if(step.key==='backup'&&application.listBackups()[0]?.status==='verified')continue;
    for(const reason of step.result.gaps??[])addIssue(reason,{name:{career:'职业资料',jobs:'岗位匹配',backup:'备份'}[step.key]??step.key,runId:todayRun.id});
   }
   const exceptions=[...issues.values()],exceptionGroups=groupOperationIssues(exceptions),exceptionSummary={total:exceptions.length,actualFailures:exceptionGroups.filter(group=>group.code!=='model_deferred').reduce((total,group)=>total+group.count,0),deferred:exceptionGroups.filter(group=>group.code==='model_deferred').reduce((total,group)=>total+group.count,0),groups:exceptionGroups.length,categories:Object.fromEntries(Object.keys(issueCategoryLabels).map(category=>[category,exceptionGroups.filter(group=>group.category===category).reduce((total,group)=>total+group.count,0)]))};
   if(today.status==='completed'&&exceptionSummary.actualFailures)today.displayLabel='检查已完成，有待处理';
   else if(today.status==='completed'&&(processingQueue.deferred||processingQueue.matchingPending.length))today.displayLabel='检查已完成，有排队任务';
   const activeRun=lock?.runId?application.getScheduledRun(lock.runId):null;
   const busy=lock&&processingOwnerAlive(lock.owner)!==false?{runId:lock.runId??null,taskId:lock.taskId??null,...(activeRun?{date:activeRun.date,progress:runProgress(activeRun)}:{})}:null;
   const objects=coverage.monitoringObjects, included=objects.filter(x=>x.monitoringStatus!=='removed');
   const period='week',range=operationalChangeRange(date,period),changes=operations.getOperationalChanges({date,period}),baseline=get();
   const sources=coverage.sources.map(source=>({id:source.id,name:source.name,kind:source.kind,scope:source.scope,implemented:source.implemented,monitoring:source.monitoring,recruitmentEntries:source.recruitmentEntries,lastSuccessfulAt:source.lastSuccessfulAt,latest:summarizeCheck(source.latest)}));
   const modelUsage={...application.getModelUsageSummary(),budget:application.getModelBudgetStatus(),budgetPending};
   return {at,date,revision,today,days,scheduler,busy,modelUsage,processingIssues,processingQueue,notification:application.getNotificationStatus(),nextCheckAt,schedule:'北京时间每日09:00；离线恢复补查当前',exceptions,exceptionGroups,exceptionSummary,institutions:{objects,counts:{included:included.length,implemented:included.filter(x=>x.integrationStatus==='implemented').length,pending:included.filter(x=>x.integrationStatus!=='implemented').length}},discovery:sources.filter(x=>x.kind==='discovery'),sources,changes:{date,period,...range,baselineStartedAt:baseline?.startedAt??null,historyNote:`新增／个人操作按本周统计，每岗每类只计一次；个人操作包括关注、已投递、排除及撤销，旧关注／排除无时间的不补计；临期为当前官方截止剩余0—7天；${baseline?'招聘状态记录从 '+new Date(Date.parse(baseline.startedAt)+28800000).toISOString().slice(0,16).replace('T',' ')+' 开始，之前转移未记录':'历史转移未记录'}`,counts:Object.fromEntries(Object.keys(allChangeLabels).map(kind=>[kind,Object.hasOwn(legacyChangeLabels,kind)&&(!baseline||range.endDate<beijingDay(baseline.startedAt))?null:changes.filter(x=>x.kind===kind).length]))},jobsCount:db.prepare('SELECT count(*) n FROM jobs').get().n};
  },
 };
 return operations;
}
import {pendingAutomaticMatches} from './necessary-jobs.mjs';
