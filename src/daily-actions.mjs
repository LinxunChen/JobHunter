import {jobDisplay} from './job-display.mjs';
import {dailyReportContent} from './daily-job-report.mjs';
import {notificationRunSummary} from './notification-run-summary.mjs';
import {sourceFailureCategory} from './source-failure.mjs';
import { matchingPriority } from './matching-priority.mjs';
import { beijingDay as day } from './beijing-time.mjs';
import {createHash,randomUUID} from 'node:crypto';
export function createDailyActionOperations({db,application,now,ValidationError}) {
  db.exec('CREATE TABLE IF NOT EXISTS action_events (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notification_drafts (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS action_monitoring_cancellations (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS action_job_state (job_id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS daily_action_state (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS notification_daily_unique ON notification_drafts(json_extract(body,\'$.date\')) WHERE json_extract(body,\'$.kind\')=\'daily_digest\'');
  const parse=row=>row?JSON.parse(row.body):null;
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const time=value=>{if(typeof value!=='string'||!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new ValidationError('行动检查时刻需有效且含时区');return new Date(value).toISOString();};
  const notificationPolicy={timezone:'Asia/Shanghai',maxDailySendAttempts:3,maxDailyDigests:1,maxFeaturedJobs:5,dailyReport:true,extraImportantReminders:false,sendBudgetEnforcedBy:'task23',externalSending:false};
  const events=()=>db.prepare('SELECT body FROM action_events ORDER BY rowid').all().map(parse);
  const drafts=()=>db.prepare('SELECT body FROM notification_drafts ORDER BY rowid').all().map(parse);
  const saveEvent=event=>{db.prepare('INSERT INTO action_events VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(event.id,JSON.stringify(event));return event;};
  const emit=(key,value,at)=>{const id='event-'+digest(key),existing=parse(db.prepare('SELECT body FROM action_events WHERE id=?').get(id));if(existing){if(existing.monitoringSuppressed)return existing;if(value.type==='source_persistent_failure'&&existing.status==='pending')return saveEvent({...existing,...value,updatedAt:at});if(value.type==='opportunity'&&['pending','suppressed'].includes(existing.status))return saveEvent({...existing,...value,status:'pending',initialOpportunity:existing.initialOpportunity??existing.opportunity,reactivatedAt:existing.status==='suppressed'?at:existing.reactivatedAt});return existing;}return saveEvent({id,key,status:'pending',createdAt:at,...value});};
  const coverage=()=>{const overview=application.getSourcesOverview({historyLimit:1});const implemented=overview.sources.filter(x=>x.implemented);return {...overview,status:implemented.length&&implemented.every(x=>x.latest?.status==='success')?'checked_scope_success':'partial_or_unverified'};};
  const candidates=(at=now().toISOString())=>application.listJobs().flatMap(job=>{
    const personal=application.getPersonalState(job.id),match=application.getMatch(job.id),state=application.getRecruitmentState(job.id,{at,includeHistory:false});
    const qualification=match?.currentQualification,pending=qualification?.status==='pending'&&!qualification.stale&&!qualification.profileStale&&(qualification.profileSource?.kind==='qualification'||qualification.profileVersion===match?.profileVersion);
    if(!application.isJobMonitoringEnabled(job.id)||personal.notInterested||personal.remindersPaused||personal.applied||job.evidenceUse==='historical'||state.status!=='publicly_listed_open'||state.registrationRemindersSuppressed||match?.status!=='completed'||match.stale||match.profileStale||(!match.qualificationAllowsAction&&!pending))return [];
    const display=jobDisplay({...job,eligibility:qualification,matching:match,recruitment:state});
    if(display.locationFit.status==='excluded'||display.recruitment.status==='not_started'||(match.output.recommendation&&!['priority','consider'].includes(display.recommendation.level)))return [];
    const output=match.output,priorityBasis=matchingPriority(output);if(!priorityBasis)return [];
    return [{jobId:job.id,title:job.title,recruitmentUnit:job.recruitmentUnit,contractingEntity:job.contractingEntity,jobVersion:match.jobVersion,profileVersion:match.profileVersion,lastOpenAt:state.lastOpenAt,reviewDue:state.review.due,registrationAllowed:match.qualificationAllowsAction,qualification:{status:qualification.status,checks:qualification.checks.filter(check=>check.status==='pending')},discoveryLabel:state.dates.published?.value===day(job.firstDiscoveredAt)?'首次发现，已核验同日发布':'首次发现存量，原发布时间另列',firstDiscoveredAt:job.firstDiscoveredAt,publishedRaw:job.publishedAt,priorityBasis,matching:{technical:output.technical.level,business:output.business.level,scope:output.scope.level,route:output.route,explanation:output.technical.explanation},url:'/jobs/'+encodeURIComponent(job.id)}];
  }).sort((a,b)=>(a.priorityBasis==='direct_extension'?0:1)-(b.priorityBasis==='direct_extension'?0:1)||a.firstDiscoveredAt.localeCompare(b.firstDiscoveredAt)||a.jobId.localeCompare(b.jobId));
  const trackWatchedChanges=(at,{emitChanges=true,jobIds}={})=>{
    for(const job of application.listJobs()){
      if(jobIds&&!jobIds.includes(job.id))continue;
      const state=application.getRecruitmentState(job.id,{at,includeHistory:false}),personal=application.getPersonalState(job.id),previous=parse(db.prepare('SELECT body FROM action_job_state WHERE job_id=?').get(job.id));
      if(previous?.checkedAt>at)continue;
      const snapshot={sourceVersion:job.currentVersionId??null,title:job.title,location:job.location,conditions:job.knownConditions,applicationPath:job.applicationPath,status:state.status,deadline:state.dates.officialDeadline?.value??null},hash=digest(snapshot);
      if(emitChanges&&application.isJobMonitoringEnabled(job.id)&&previous&&previous.hash!==hash&&(personal.followed||personal.preparing||personal.applied)&&!personal.notInterested&&!personal.remindersPaused)emit(['watched_change',job.id,previous.hash,hash],{type:'watched_change',priority:1,jobId:job.id,title:job.title,deadline:state.dates.officialDeadline,registrationPrompt:false,evidence:{before:previous.snapshot,after:snapshot},qualificationRequiresReview:!application.getMatch(job.id)?.qualificationAllowsAction},at);
      db.prepare('INSERT INTO action_job_state VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET body=excluded.body').run(job.id,JSON.stringify({hash,snapshot,checkedAt:at}));
    }
  };
  const permitsRegistration = (job, state) => { const match=application.getMatch(job.id), display=jobDisplay({...job,matching:match,eligibility:application.getEligibility(job.id),recruitment:state});return application.isJobMonitoringEnabled(job.id) && match?.qualificationAllowsAction && display.locationFit.status!=='excluded' && display.recruitment.status!=='not_started' && (!match.output?.recommendation || ['priority','consider'].includes(display.recommendation.level)); };
  const suppressInvalid=at=>{
    const allowed=new Set(candidates(at).map(x=>x.jobId));
    for(const event of events().filter(e=>e.status==='pending'&&e.jobId)){
      const personal=application.getPersonalState(event.jobId),state=application.getRecruitmentState(event.jobId,{at});
      const invalid=personal.remindersPaused||personal.notInterested||(event.type==='opportunity'&&!allowed.has(event.jobId))||(event.registrationPrompt&&(state.registrationRemindersSuppressed||state.status!=='publicly_listed_open'||!permitsRegistration(application.getJob(event.jobId),state)));
      if(invalid)saveEvent({...event,status:'suppressed',suppressedAt:at,reason:'个人偏好或当前资格／招聘证据阻止该提示'});
    }
  };
  const deadlineEvents=(at,nextDigestAt)=>{
    for(const job of application.listJobs()){
      const state=application.getRecruitmentState(job.id,{at,includeHistory:false}),personal=application.getPersonalState(job.id),fact=state.dates.officialDeadline;
      if(!fact||state.registrationRemindersSuppressed||state.status!=='publicly_listed_open'||!permitsRegistration(job,state))continue;
      const days=state.dates.remainingDays,node=days<=1?1:days<=3?3:days<=7?7:null;
      for(const event of events().filter(e=>e.jobId===job.id&&e.type==='deadline_node'&&e.status==='pending'))if(event.deadline.value!==fact.value||(node&&event.node>node))saveEvent({...event,status:'superseded',supersededAt:at,reason:'采用最新截止和当前临期节点，不回放旧节点'});
      const latestChange=state.dates.deadlineHistory.at(-1);
      if(latestChange?.change==='extended'||latestChange?.change==='changed')emit(['deadline_changed',job.id,fact.value,latestChange.previous?.value],{type:'deadline_changed',priority:1,jobId:job.id,title:job.title,deadline:fact,evidence:latestChange,registrationPrompt:!personal.applied},at);
      if(node){const urgent=fact.precision==='day'?fact.value<=day(nextDigestAt):Date.parse(fact.value)<Date.parse(nextDigestAt);emit(['deadline_node',job.id,fact.value,node],{type:'deadline_node',priority:urgent?0:1,jobId:job.id,title:job.title,node,deadline:fact,firstDiscoveredAlreadyNear:!events().some(e=>e.jobId===job.id&&e.type==='deadline_node'),registrationPrompt:true},at);}
    }
  };
  const sourceEvents=at=>{
    const health=application.listSourceHealthEvents();
    const sources=application.getSourcesOverview({historyLimit:1}).sources;
    for(const item of health)if(item.status==='active'&&application.getSourceMonitoringStatus(item.sourceId).enabled)emit(['source_failure',item.id],{type:'source_persistent_failure',priority:3,sourceId:item.sourceId,sourceName:sources.find(source=>source.id===item.sourceId)?.name,sourceEventId:item.id,failureCategory:sourceFailureCategory({...item,status:item.checkStatus}),stage:item.stage,error:item.error,gaps:item.gaps??[],registrationPrompt:false},at);
    for(const event of events().filter(e=>e.type==='source_persistent_failure'&&e.status==='pending'))if(['recovered','reclassified'].includes(health.find(x=>x.id===event.sourceEventId)?.status))saveEvent({...event,status:'suppressed',reason:'来源已恢复或问题已重新归类，取消待发来源故障，原历史保留',suppressedAt:at});
  };
  const issues=()=>{
    const sourceIssues=coverage().sources.filter(x=>x.implemented&&x.latest?.status!=='success').map(source=>({sourceId:source.id,title:source.name,status:source.latest?.status??'not_checked',failureCategory:source.latest?.failureCategory??'unknown',stage:source.latest?.stage??null,gaps:source.latest?.gaps??['尚无实际完成检查'],error:source.latest?.error??null,acquired:{listComplete:source.latest?.listComplete??null,listCount:source.latest?.listCount??null,catalogComplete:source.latest?.catalogComplete??null,catalogCount:source.latest?.catalogCount??null,platformListComplete:source.latest?.platformListComplete??null,platformCount:source.latest?.platformJobs?.length??null,details:source.latest?.details?.length??null,attachmentsChecked:source.latest?.attachmentsChecked??null}}));
    const processing=application.listJobs().flatMap(job=>{const match=application.getMatch(job.id);return match?.status==='failed'||match?.stale||match?.profileStale?[{jobId:job.id,title:job.title,status:match.status,failureCategory:match.status==='failed'?'processing':'stale_judgment',gaps:match.gaps??[],registrationAllowed:false}]:[];});const qualification=application.listJobs().flatMap(job=>{const result=application.getEligibility(job.id),pending=result?.checks.filter(x=>x.status==='pending')??[];return pending.length?[{jobId:job.id,title:job.title,status:'pending',failureCategory:'qualification_review',gaps:pending.flatMap(x=>x.gaps?.length?x.gaps:[x.reason]),conditions:pending.map(x=>x.condition),registrationAllowed:false}]:[];});return [...sourceIssues,...processing,...qualification];
  };
  const reportAt=at=>{
    const sources=application.getSourcesOverview({historyLimit:1}).sources;
    const sourceIssues=sources.filter(source=>source.implemented&&source.monitoring?.enabled!==false&&['partial','failed'].includes(source.latest?.status)).map(source=>({sourceId:source.id,sourceName:source.name,status:source.latest.status,failureCategory:sourceFailureCategory(source.latest),stage:source.latest.stage,error:source.latest.error,gaps:source.latest.gaps??[]}));
    const runSummary=notificationRunSummary({at,sources,jobs:application.listJobs(),completedChecks:application.getCompletedSourceChecks({from:new Date(Date.parse(day(at)+'T00:00:00+08:00')).toISOString(),through:at})});
    const firstConsidered=new Map(db.prepare("SELECT json_extract(body,'$.jobId') jobId,min(json_extract(body,'$.at')) at FROM job_transitions WHERE json_extract(body,'$.kind')='entered' GROUP BY json_extract(body,'$.jobId')").all().map(row=>[row.jobId,row.at]));
    const allEvents=events();for(const event of allEvents.filter(event=>event.type==='opportunity'))if(!firstConsidered.has(event.jobId)||event.createdAt<firstConsidered.get(event.jobId))firstConsidered.set(event.jobId,event.createdAt);
    const jobs=application.listJobView().map(job=>{const recruitment=application.getRecruitmentState(job.id,{at,includeHistory:false});return {...job,recruitment,display:jobDisplay({...job,recruitment})};});
    const lastReportAt=drafts().filter(draft=>draft.kind==='daily_digest'&&draft.status==='held_for_delivery'&&draft.date<day(at)).map(draft=>draft.heldAt).sort().at(-1);
    return dailyReportContent({at,jobs,opportunities:candidates(at),firstConsidered,events:allEvents,lastReportAt,monitoringEnabled:id=>application.isJobMonitoringEnabled(id),sourceIssues,runSummary,operations:application.getOperationsOverview()});
  };
  const buildDraft=(at,allEvents)=>{
    const date=day(at),existing=drafts().find(x=>x.kind==='daily_digest'&&x.date===date);
    if(existing?.status==='held_for_delivery')return null;
    const rendered=reportAt(at),shown=new Set(Object.values(rendered.report.sections).flat().map(item=>item.jobId));
    const pending=allEvents.filter(x=>x.status==='pending');
    const eventIds=pending.filter(event=>shown.has(event.jobId)||event.type==='source_persistent_failure').map(event=>event.id);
    const featuredIds=new Set(rendered.report.sections.newConsiderable.filter(item=>item.detailed).map(item=>item.jobId));
    const featuredJobs=candidates(at).filter(item=>featuredIds.has(item.jobId));
    const importantGroups=new Map();
    for(const event of pending.filter(event=>event.priority<2&&shown.has(event.jobId))){
      const item=importantGroups.get(event.jobId)??{jobId:event.jobId,priority:event.priority,deadline:application.getRecruitmentState(event.jobId,{at}).dates.officialDeadline,events:[]};
      item.priority=Math.min(item.priority,event.priority);item.events.push(event);importantGroups.set(event.jobId,item);
    }
    const important=[...importantGroups.values()].sort((a,b)=>a.priority-b.priority||(a.deadline?.value??'9999').localeCompare(b.deadline?.value??'9999'));
    const draft={id:existing?.id??randomUUID(),kind:'daily_digest',date,status:'pending',createdAt:existing?.createdAt??at,updatedAt:at,featuredJobs,important,sourceIssues:rendered.sourceIssues,omittedImportantCount:pending.filter(event=>event.priority<2&&!shown.has(event.jobId)).length,omittedSourceCount:0,eventIds,omittedEventIds:pending.filter(x=>!eventIds.includes(x.id)).map(x=>x.id),policy:notificationPolicy,...rendered};
    db.prepare('INSERT INTO notification_drafts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(draft.id,JSON.stringify(draft));return draft;
  };
  const suppressPausedActions=({baseline=false,jobIds}={})=>{
    for(const event of events()) {
      const paused=event.jobId?!application.isJobMonitoringEnabled(event.jobId):event.sourceId?!application.getSourceMonitoringStatus(event.sourceId).enabled:false;
      if(paused&&['pending','suppressed','held_for_delivery'].includes(event.status)&&!event.monitoringSuppressed) {
        // Held/sent evidence stays intact. A separate cancellation marker stops a retry.
        if(event.status==='held_for_delivery') {
          const delivery=application.getNotificationDelivery?.(event.draftId);
          if(delivery&&['in_progress','retry_wait'].includes(delivery.status))db.prepare('INSERT OR IGNORE INTO action_monitoring_cancellations VALUES(?,?)').run(event.id,JSON.stringify({eventId:event.id,cancelledAt:now().toISOString(),reason:'暂停期间的旧发送不自动重试'}));
          continue;
        }
        saveEvent({...event,status:'suppressed',monitoringSuppressed:true,suppressedAt:now().toISOString(),reason:'机构或发现入口暂停，恢复后不补发本条旧提醒'});
      }
    }
    // Advance watched snapshots on pause/resume, so changes made while paused are not replayed.
    if(baseline)trackWatchedChanges(now().toISOString(),{emitChanges:false,jobIds});
  };
  // All day-precision rules change at Beijing midnight. Instant start/end facts
  // can change within the day; deadlinePassed uses strict >, hence the 1ms edge.
  const nextBoundary=at=>{
    const boundaries=[Date.parse(day(at)+'T00:00:00+08:00')+86400000];
    for(const job of application.listJobs()){
      const dates=application.getRecruitmentState(job.id,{at,includeHistory:false}).dates;
      for(const [fact,offset] of [[dates.officialStart,0],[dates.officialDeadline,1]])
        if(fact?.precision==='instant'&&Date.parse(fact.value)+offset>Date.parse(at))boundaries.push(Date.parse(fact.value)+offset);
    }
    return new Date(Math.min(...boundaries)).toISOString();
  };
  const operations={
    prepareDailyActionsIfNeeded() {
      const at=now().toISOString(),prior=parse(db.prepare('SELECT body FROM daily_action_state WHERE id=?').get('last'));
      const held=db.prepare("SELECT id FROM notification_drafts WHERE json_extract(body,'$.kind')='daily_digest' AND json_extract(body,'$.date')=? AND json_extract(body,'$.status')='held_for_delivery'").get(day(at));
      if(held&&prior?.inputRevision===application.getBusinessRevision()&&at>=prior.checkedAt&&at<prior.nextCheckAt)return {checkedAt:prior.checkedAt,unchanged:true,dailyDigest:null,importantDraft:null};
      return application.prepareDailyActions();
    },
    suppressPausedActions,
    wasReminderPaused:id=>Boolean(db.prepare('SELECT id FROM action_monitoring_cancellations WHERE id=?').get(id)),
    handoffNotificationDraft(id,{attemptId}={}) {
      if(typeof attemptId!=='string'||!attemptId.trim())throw new ValidationError('交接须关联通知执行方已保留预算的尝试ID，本入口不发送');
      let draft=parse(db.prepare('SELECT body FROM notification_drafts WHERE id=?').get(id));if(!draft)throw new ValidationError('待发送内容不存在');
      if(draft.status==='held_for_delivery'){if(draft.attemptId!==attemptId)throw new ValidationError('该内容已交接，不自动重发');return draft;}
      operations.prepareDailyActions();draft=parse(db.prepare('SELECT body FROM notification_drafts WHERE id=?').get(id));
      if(draft.status!=='pending'||(!draft.policy?.dailyReport&&!draft.eventIds.length))throw new ValidationError('当前内容已无行动价值，不能交接');
      const ownsTransaction=!db.isTransaction;if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
      try{draft={...draft,status:'held_for_delivery',attemptId,heldAt:now().toISOString(),deliveryState:'未判定，由通知执行记录核验'};
        for(const eventId of draft.eventIds){const event=parse(db.prepare('SELECT body FROM action_events WHERE id=?').get(eventId));if(!event||event.status!=='pending')throw new ValidationError('事件已被处理或取消，不重复交接');saveEvent({...event,status:'held_for_delivery',draftId:id,attemptId,heldAt:draft.heldAt});}
        db.prepare('UPDATE notification_drafts SET body=? WHERE id=?').run(JSON.stringify(draft),id);if(ownsTransaction)db.exec('COMMIT');return draft;
      }catch(error){if(ownsTransaction)db.exec('ROLLBACK');throw error;}
    },
    getNotificationPreview(id) {
      if(id){const draft=parse(db.prepare('SELECT body FROM notification_drafts WHERE id=?').get(id));if(!draft)throw new ValidationError('通知草稿不存在');return {title:draft.title,...draft};}
      return {kind:'preview',...reportAt(now().toISOString())};
    },
    getActionEvents:events,listNotificationDrafts:drafts,getNotificationDraft:id=>parse(db.prepare('SELECT body FROM notification_drafts WHERE id=?').get(id)),getToday({at=now().toISOString()}={}){at=time(at);return {checkedAt:at,events:events(),drafts:drafts(),coverage:coverage(),notificationPolicy,opportunities:candidates(at),important:events().filter(x=>x.priority<2&&x.status==='pending'),personalTodos:application.listJobs().flatMap(job=>{const todo=application.getRecruitmentState(job.id,{at,includeHistory:false}).dates.personalTodo;return todo?[{jobId:job.id,title:job.title,...todo}]:[];}),issues:issues()};},prepareDailyActions({at=now().toISOString(),nextDigestAt}={}){at=time(at);const inputRevision=application.getBusinessRevision();const prior=parse(db.prepare('SELECT body FROM daily_action_state WHERE id=?').get('last'));if(prior?.checkedAt>at)return {...operations.getToday({at:prior.checkedAt}),historical:true,dailyDigest:null,importantDraft:null};nextDigestAt=time(nextDigestAt??new Date(Date.parse(day(at)+'T01:00:00Z')+86400000).toISOString());if(nextDigestAt<=at)throw new ValidationError('下一摘要时刻必须晚于当前检查');suppressPausedActions();sourceEvents(at);trackWatchedChanges(at);deadlineEvents(at,nextDigestAt);for(const opportunity of candidates(at))emit(['opportunity',opportunity.jobId],{type:'opportunity',priority:2,jobId:opportunity.jobId,opportunity},at);suppressInvalid(at);const today=operations.getToday({at});const draft=buildDraft(at,today.events);db.prepare('INSERT INTO daily_action_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run('last',JSON.stringify({checkedAt:at,inputRevision,nextCheckAt:nextBoundary(at)}));return {...today,dailyDigest:draft?.kind==='daily_digest'?draft:null,importantDraft:draft?.kind==='important_reminder'?draft:null};}};
  // Reuse derived state within a synchronous preparation/read only. Writes
  // invalidate the snapshot; no state survives to a later dispatch check.
  for(const name of ['prepareDailyActions','getToday']){
    const operation=operations[name];
    operations[name]=(...args)=>application.withReadSnapshot(()=>operation(...args));
  }
  return operations;
}
