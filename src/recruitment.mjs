import {matchesTargetScope} from './local-settings.mjs';
import {validOfficialApplicationUrl} from './official-application-link.mjs';
import { beijingDay as day,calendarDayDifference as dayDifference } from './beijing-time.mjs';
import { sourceCapabilities } from './source-capabilities.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {jobRelevance,targetLocation} from './job-relevance.mjs';
import {processingScopeVersion} from './processing-scope.mjs';
export function createRecruitmentOperations({db,application,now,verificationMode=false,ValidationError}) {
  db.exec('CREATE TABLE IF NOT EXISTS recruitment_observations (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recruitment_personal_dates (job_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const requireJob=id=>{const job=application.getSourceJob(id);if(!job)throw new ValidationError('岗位不存在');return job;};
  const timestamp=value=>{if(typeof value!=='string'||!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new ValidationError('观察时刻需含时区');return new Date(value).toISOString();};
  const validateEvidence=value=>{
    let url;try{url=new URL(value?.url);}catch{throw new ValidationError('状态证据需完整来源链接');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||typeof value.text!=='string'||typeof value.quote!=='string'||!value.quote.trim()||!value.text.includes(value.quote))throw new ValidationError('状态证据需要可逐字核对的原文引用');
    return structuredClone(value);
  };
  const dateFact=value=>{
    if(!value || typeof value.raw!=='string')throw new ValidationError('已确认日期须保留原值');
    const evidence=validateEvidence(value.evidence);
    if(!evidence.quote.includes(value.raw))throw new ValidationError('日期原值不在引用中');
    let raw=value.raw,normalized;
    if (Number(raw.match(/^([0-9]{4})/)?.[1]) >= 2500) throw new ValidationError('远年占位日期不可作为报名起止');
    const local=raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/);
    if(local){const date=local[1]+'-'+local[2].padStart(2,'0')+'-'+local[3].padStart(2,'0'),parsed=new Date(date+'T00:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date||Number(local[4])>23||Number(local[5])>59)throw new ValidationError('日期或时分无效');return {...value,evidence,value:date+'T'+local[4].padStart(2,'0')+':'+local[5],precision:'local_minute',timeZone:null,date};}
    const chinese=raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if(chinese)raw=chinese[1]+'-'+chinese[2].padStart(2,'0')+'-'+chinese[3].padStart(2,'0');
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){
      const parsed=new Date(raw+'T00:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==raw)throw new ValidationError('日期无效');normalized=raw;
      return {...value,evidence,value:normalized,precision:'day'};
    }
    normalized=timestamp(raw);return {...value,evidence,value:normalized,precision:'instant'};
  };
  const history=(id,{stateOnly=false}={})=>{const values=application.getRecruitmentObservations?application.getRecruitmentObservations(id,{stateOnly}):db.prepare('SELECT body FROM recruitment_observations WHERE job_id=? ORDER BY rowid').all(id).map(row=>JSON.parse(row.body));return stateOnly?values.filter(item=>item.acquisition==='success'&&!item.historical):values;};
  const operations = {
    setJobReminderDate(jobId,input) {
      requireJob(jobId);
      if(typeof input?.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.date))throw new ValidationError('本人待办需要日级日期');
      const parsed=new Date(input.date+'T00:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==input.date)throw new ValidationError('本人待办日期无效');
      if(input.note!=null&&typeof input.note!=='string')throw new ValidationError('待办说明需要文本');
      const value={date:input.date,note:input.note??null,recordedAt:now().toISOString()};db.prepare('INSERT INTO recruitment_personal_dates VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET body=excluded.body').run(jobId,JSON.stringify(value));return value;
    },
    recordRecruitmentObservation(jobId,input) {
      const job=requireJob(jobId);
      if(!input||!job.sourceIdentities?.some(x=>x.sourceId===input.sourceId&&x.externalId===input.externalId)||!['success','failed'].includes(input.acquisition))throw new ValidationError('观察必须对应岗位可靠来源身份');
      if(input.applicationUrl!=null&&!validOfficialApplicationUrl(input.sourceId,input.applicationUrl))throw new ValidationError('投递入口须为对应来源的官方跨系统岗位地址');
      for(const field of ['listComplete','listed','detailAccessible','applicationOpen'])if(input[field]!=null&&typeof input[field]!=='boolean')throw new ValidationError('观察结果必须为布尔值或未知');
      const observation={...structuredClone(input),id:input.id??randomUUID(),jobId,observedAt:timestamp(input.observedAt),evidence:validateEvidence(input.evidence)};
      for(const field of ['published','start','deadline'])if(input[field]!=null)observation[field]=dateFact(input[field]);
      if(input.explicitEnd!=null){observation.explicitEnd=validateEvidence(input.explicitEnd);if(!/已结束|招聘结束|报名结束|停止报名|停止招聘/.test(observation.explicitEnd.quote)||/未结束|不结束|未报名结束|未停止|不停止|将.*结束/.test(observation.explicitEnd.quote))throw new ValidationError('明确结束需原文结束声明');}
      const prior=history(jobId);observation.historical=prior.some(x=>x.observedAt>observation.observedAt);
      const existing=db.prepare('SELECT body FROM recruitment_observations WHERE id=?').get(observation.id);
      if(existing){const saved=JSON.parse(existing.body);if(saved.jobId!==jobId)throw new ValidationError('观察ID已属于另一岗位');observation.historical=saved.historical;if(!isDeepStrictEqual(saved,observation))throw new ValidationError('观察ID已对应另一份原文证据');return saved;}
      db.prepare('INSERT INTO recruitment_observations VALUES(?,?,?)').run(observation.id,jobId,JSON.stringify(observation));return observation;
    },
    recordRecruitmentSourceCheck(run,{persist=true,jobId}={}) {
      if(run.sourceId!=='efunds-social'||!['success','partial','failed'].includes(run.status))return [];
      if(run.legacyJobProjection){
        const projected=run.legacyJobProjection,jobs=jobId?[requireJob(jobId)]:db.prepare('SELECT body FROM jobs ORDER BY rowid').all().map(row=>JSON.parse(row.body)),results=[];
        const text=`来源检查 ${run.id}；列表${run.listCount??'未知'}项；完整分页${run.listComplete===true?'已核验':'未核验'}`,evidence={url:projected.url,text,quote:run.id,locator:'来源检查快照及完整分页；原文按sourceCheckId查阅'};
        for(const job of jobs)for(const identity of job.sourceIdentities??[]){if(identity.sourceId!==run.sourceId||identity.externalId!==projected.externalId)continue;
          const id=run.id+':'+job.id+':'+identity.externalId;if(db.prepare('SELECT id FROM recruitment_observations WHERE id=?').get(id))continue;
          const {externalId,url,...facts}=projected,input={id,...identity,...facts,observedAt:run.checkedAt,evidence,error:run.error??null,sourceCheckId:run.id};
          results.push(persist?operations.recordRecruitmentObservation(job.id,input):{...input,jobId:job.id,observedAt:timestamp(input.observedAt),historical:false,verification:'read_only_projection'});
        }
        return results;
      }
      if(run.recruitmentProjection)run={...run,...run.recruitmentProjection,details:run.recruitmentProjection.details.map(detail=>({...detail,raw:{data:{...detail.raw.data,canDelivery:typeof detail.raw.data.canDelivery==='number'?Boolean(detail.raw.data.canDelivery):detail.raw.data.canDelivery}}}))};
      const jobs=jobId?[requireJob(jobId)]:db.prepare('SELECT body FROM jobs ORDER BY rowid').all().map(row=>JSON.parse(row.body)),results=[];
      const items=(run.pages??[]).flatMap(page=>page.raw?.data?.pageForm?.pageData??[]);
      const text=`来源检查 ${run.id}；列表${run.listCount??'未知'}项；完整分页${run.listComplete===true?'已核验':'未核验'}`,evidence={url:run.pages?.[0]?.url??run.officialChain?.[0]?.url??'https://job.efunds.com.cn/',text,quote:run.id,locator:'来源检查快照及完整分页；原文按sourceCheckId查阅'};
      for(const job of jobs)for(const identity of job.sourceIdentities??[]){if(identity.sourceId!==run.sourceId)continue;
        const id=run.id+':'+job.id+':'+identity.externalId;
        if(db.prepare('SELECT id FROM recruitment_observations WHERE id=?').get(id))continue;
        const detail=(run.details??[]).find(x=>x.raw?.data?.postId===identity.externalId),listed=items.some(x=>x.postId===identity.externalId);
        const validDetail=detail?.status===200&&detail.applicationPage?.status===200&&typeof detail.applicationPage.raw==='string'&&detail.applicationPage.raw.includes('/pb/js/posDetail.js');
        const acquired=run.listComplete===true&&(run.pages??[]).length>0&&run.pages.every(page=>Array.isArray(page.raw?.data?.pageForm?.pageData))&&items.length===run.listCount&&new Set(items.map(item=>item.postId)).size===run.listCount&&run.pages.at(-1).raw.data.pageForm.dataCount===run.listCount;
        const input={id,...identity,observedAt:run.checkedAt,acquisition:acquired?'success':'failed',listComplete:acquired,listed:acquired?listed:null,detailAccessible:validDetail?true:null,applicationOpen:validDetail&&typeof detail?.raw?.data?.canDelivery==='boolean'?detail.raw.data.canDelivery&&detail.raw.data.showDeliverButton===1:null,evidence,error:run.error??null,sourceCheckId:run.id};
        results.push(persist?operations.recordRecruitmentObservation(job.id,input):{...input,jobId:job.id,observedAt:timestamp(input.observedAt),historical:false,verification:'read_only_projection'});
      }
      return results;
    },
    async checkDueRecruitmentDetails({sourceId='efunds-social',trigger='manual',scheduledFor,at=now().toISOString()}={}) {
      if(!application.getSourceRecruitmentSupport(sourceId).supported)return application.unsupportedRecruitmentResult(sourceId);
      const capability = sourceCapabilities[sourceId];
      if (!capability || typeof application[capability.method] !== 'function') throw new ValidationError('该来源尚无详情检查入口');
      const monitoring=application.getSourceMonitoringStatus(sourceId);
      if(!monitoring.enabled)return {sourceId,status:'paused',monitoring,gaps:[],businessGaps:[monitoring.reason],jobIds:[]};
      const pending = operations.listRecruitmentReviewPlan({at}).filter(item=>item.sourceId===sourceId&&item.due);
      const selected = [], deferred = [];
      const counts = {};
      for (const entry of pending) {
        const field = entry.selectionField, key = field+':'+entry.selectionId;
        if(sourceId==='boc-social'&&field===capability.urls&&!entry.jobId&&!application.getSourceSettings(sourceId).announcementScopes?.[entry.selectionId]&&selected.some(item=>item.selectionField===field&&!item.jobId&&!application.getSourceSettings(sourceId).announcementScopes?.[item.selectionId])){deferred.push({...entry,deferReason:'每轮最多1篇尚未拆分的完整公告；其余持久等待后续批次'});continue;}
        if (selected.some(item=>item.selectionField+':'+item.selectionId===key)) {
          if(sourceId==='boc-social'&&entry.jobId&&!selected.some(item=>item.jobId===entry.jobId))deferred.push(entry);
          continue;
        }
        const limit = field===capability.urls?capability.urlLimit:capability.limit;
        if ((counts[field]??0) >= limit) deferred.push(entry);
        else {selected.push(entry);counts[field]=(counts[field]??0)+1;}
      }
      const settings = application.getSourceSettings(sourceId);
      const input = {[capability.field]:selected.filter(item=>item.selectionField===capability.field).map(item=>item.selectionId),listOnly:!selected.length,trigger,scheduledFor};
      if (capability.urls) {input[capability.urls]=selected.filter(item=>item.selectionField===capability.urls).map(item=>item.selectionId);input.announcementScopes=Object.fromEntries(input[capability.urls].map(url=>{
        const entry=selected.find(item=>item.selectionId===url),job=entry.jobId?application.getSourceJob(entry.jobId):null,announcement=job?.announcementId?application.getAnnouncement(job.announcementId):null;
        const scope=job?{targetJob:Object.fromEntries(['title','recruitmentUnit','department','batch'].map(field=>[field,job[field]??null])),...(announcement?.documentScopes?{documentScopes:announcement.documentScopes}:{})}:settings.announcementScopes?.[url];
        return [url,scope];
      }).filter(([,scope])=>scope));}
      const run = await application[capability.method](input);
      application.recordCandidateAttempts(sourceId,selected,run);
      const discovered=application.listSourceCandidates(sourceId);
      const result = {...run,discoveryCandidates:discovered,discoveryPendingCount:discovered.filter(item=>item.status==='pending').length,reviewPendingCount:pending.length,reviewSelected:selected,reviewDeferred:deferred,reviewDeferredPostIds:deferred.map(item=>item.externalId)};
      db.prepare('UPDATE source_checks SET body=? WHERE id=?').run(JSON.stringify(result),run.id);
      application.recordSourceReviewMetadata(run.id,{reviewPendingCount:result.reviewPendingCount,reviewSelected:selected,reviewDeferred:deferred,reviewDeferredPostIds:result.reviewDeferredPostIds,listOnly:input.listOnly});
      return result;
    },
    getRecruitmentState(jobId,{at:time=now().toISOString(),includeHistory=true}={}) {
      const projected=[];
      const job=requireJob(jobId);
      for(const identity of job.sourceIdentities??[])if(identity.sourceId==='efunds-social')for(const run of application.getLegacyRecruitmentChecks?.(jobId,identity,{stateOnly:!includeHistory})??[])projected.push(...operations.recordRecruitmentSourceCheck(run,{persist:false,jobId}).filter(item=>item.jobId===jobId));
      const at=new Date(timestamp(time)),today=day(at),observations=[...history(jobId,{stateOnly:!includeHistory}),...projected];let status=job.recruitmentStatus==='publicly_listed_open'&&job.sourceEvidence?.listed===true?'publicly_listed_open':'unverified',lastSuccessfulObservationAt=null,published=null,officialStart=null,officialDeadline=null,lastOpenAt=null,continuousSince=null,lastListedAt=null,lastDetailCheckedAt=null,lastApplicationOpen=null;const deadlineHistory=[];let applicationUrl;
      if(status==='publicly_listed_open')lastOpenAt=job.sourceEvidence.checkedAt??job.lastSuccessfullyCheckedAt??null;
      for(const observation of [...observations].sort((a,b)=>a.observedAt.localeCompare(b.observedAt))){
        if(observation.historical||observation.acquisition!=='success')continue;
        lastSuccessfulObservationAt=observation.observedAt;if(validOfficialApplicationUrl(observation.sourceId,observation.applicationUrl))applicationUrl=observation.applicationUrl;
        if(typeof observation.applicationOpen==='boolean')lastApplicationOpen=observation.applicationOpen;
        if(observation.detailAccessible===true)lastDetailCheckedAt=observation.observedAt;
        if(observation.published)published=observation.published;
        if(observation.start&&Number(observation.start.value?.slice(0,4))<2500)officialStart=observation.start;
        if(observation.deadline&&Number(observation.deadline.value?.slice(0,4))<2500){if(!officialDeadline||officialDeadline.value!==observation.deadline.value)deadlineHistory.push({...observation.deadline,observedAt:observation.observedAt,change:officialDeadline?(observation.deadline.value>officialDeadline.value?'extended':'changed'):'first_confirmed',previous:officialDeadline});officialDeadline=observation.deadline;}
        if(observation.listComplete&&observation.listed===true){if(!lastListedAt||dayDifference(day(observation.observedAt),day(lastListedAt))>8)continuousSince=observation.observedAt;lastListedAt=observation.observedAt;}
        if(observation.listComplete&&observation.listed===false){continuousSince=null;lastListedAt=null;}
        if(observation.explicitEnd)status='ended';
        else if(observation.listComplete&&observation.listed===false)status='suspected_offline';
        else if(observation.detailAccessible===true&&observation.applicationOpen===false)status='unverified';
        else if(observation.listed===true&&observation.applicationOpen===true&&(observation.listComplete||observation.detailAccessible===true)){status='publicly_listed_open';lastOpenAt=observation.observedAt;}
      }
      // Backfill only the official start missing from old ICBC observations, from their saved detail snapshot.
      // This projection neither fetches a source nor changes the original observation or notification history.
      if (!officialStart && job.sourceIdentities?.some(identity => identity.sourceId === 'icbc-social')) {
        for (const observation of [...observations].sort((a,b)=>b.observedAt.localeCompare(a.observedAt))) {
          if (observation.historical || observation.acquisition !== 'success' || observation.sourceId !== 'icbc-social' || !observation.sourceCheckId) continue;
          const run=application.getStoredCheckSummary(observation.sourceCheckId);
          if(!run)continue;
          const detail=(run.registrationStarts??[]).find(item=>item.externalId===observation.externalId),raw=detail?.raw;
          if(!detail?.url||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw))continue;
          const normalized = raw.replace(' ','T') + '+08:00';
          try { officialStart = dateFact({raw:normalized,sourceRaw:raw,sourceCheckId:run.id,evidence:{url:detail.url,text:'官方原值：'+raw+'\n平台北京时间规范化：'+normalized,quote:normalized,locator:'存量官方详情enterBeginTime，北京时间规范化'}}); break; }
          catch { /* Invalid cached values remain unknown. */ }
        }
      }
      const dateGaps=[];
      for(const value of job.dateEvidence??[]){if(value.meaning==='unverified')continue;const quote=value.evidence?.find(ref=>typeof ref.quote==='string'&&ref.quote.includes(value.raw))?.quote;
        try{const fact=dateFact({raw:value.raw,evidence:{url:job.sourceUrl,text:job.originalText,quote}});if(value.meaning==='explicit_publish_date'&&!published)published=fact;if(value.meaning==='explicit_registration_start'&&!officialStart)officialStart=fact;if(value.meaning==='explicit_deadline'&&!officialDeadline){officialDeadline=fact;deadlineHistory.push({...fact,change:'confirmed_source_snapshot',observedAt:job.lastSuccessfullyCheckedAt??job.firstDiscoveredAt});}}
        catch(error){dateGaps.push(value.field+'：'+error.message);}
      }
      if(officialDeadline?.precision==='local_minute')dateGaps.push('来源明示截止时分但时区未披露，保留原值与分钟精度，不计算精确倒计时');
      const deadlinePassed=officialDeadline?(officialDeadline.precision==='local_minute'?today>officialDeadline.date:officialDeadline.precision==='day'?today>officialDeadline.value:at.getTime()>Date.parse(officialDeadline.value)):false;
      const deadlineConflict=deadlinePassed&&status==='publicly_listed_open';
      if(deadlineConflict)status='unverified';
      else if(deadlinePassed&&lastApplicationOpen===false&&status==='unverified')status='ended';
      const remainingDays=officialDeadline&&officialDeadline.precision!=='local_minute'?dayDifference(officialDeadline.precision==='day'?officialDeadline.value:day(officialDeadline.value),today):null;
      const todoRow=db.prepare('SELECT body FROM recruitment_personal_dates WHERE job_id=?').get(jobId);
      const publicationDay=published?(published.precision==='local_minute'?published.date:published.precision==='day'?published.value:day(published.value)):null;
      const observedDays=continuousSince&&lastListedAt?dayDifference(day(lastListedAt),day(continuousSince)):null;
      const days=publicationDay?Math.max(0,dayDifference(today,publicationDay)):observedDays;
      const personal=application.getPersonalState(jobId),reasons=[];
      if(personal.followed)reasons.push('followed');if(personal.preparing)reasons.push('preparing');if(remainingDays!==null&&remainingDays>=0&&remainingDays<=7&&!deadlinePassed&&status!=='ended')reasons.push('near_official_deadline');
      const intervalDays=reasons.length?1:7,nextReviewAt=lastDetailCheckedAt?new Date(Date.parse(lastDetailCheckedAt)+intervalDays*86400000).toISOString():null;
      const review={intervalDays,reasons,nextReviewAt,due:nextReviewAt===null||at.getTime()>=Date.parse(nextReviewAt),lastDetailCheckedAt};
      const freshOpen=status==='publicly_listed_open'&&lastOpenAt&&at.getTime()-Date.parse(lastOpenAt)<=intervalDays*86400000;
      const label=days>=180&&!freshOpen&&status!=='ended'?'long_term_unverified':days>=90?'long_posted':null;
      if(label==='long_term_unverified'&&status!=='ended')status='unverified';
      return {jobId,status,review,...(applicationUrl?{applicationUrl}:{}),registrationRemindersSuppressed:personal.registrationRemindersSuppressed||status==='ended'||deadlinePassed,lastSuccessfulObservationAt,lastOpenAt,history:includeHistory?observations:[],checkedAt:at.toISOString(),longevity:{days,label,basis:publicationDay?'verified_publication_date':observedDays!==null?'continuous_observations':null,continuousSince,observedThrough:lastListedAt,observationGapsPossible:!publicationDay&&(!lastListedAt||dayDifference(today,day(lastListedAt))>8)},dates:{published,officialStart,officialDeadline,deadlineHistory,gaps:dateGaps,deadlinePassed,deadlineConflict,remainingDays,ageQualificationWindows:job.knownConditions.filter(x=>/年龄|周岁|出生/.test(x)),personalTodo:todoRow?JSON.parse(todoRow.body):null,unverified:(job.dateEvidence??[]).filter(x=>x.meaning==='unverified')}};
    },
    listRecruitmentReviewPlan({at=now().toISOString()}={}) {
      const entries=[], jobs=db.prepare('SELECT body FROM jobs ORDER BY rowid').all().map(row=>JSON.parse(row.body));
      const candidates=application.listSourceCandidates?.()??[],candidateByKey=new Map(candidates.map(item=>[[item.sourceId,item.selectionField,item.externalId].join(':'),item]));
      for(const job of jobs){const state=operations.getRecruitmentState(job.id,{at,includeHistory:false});for(const identity of job.sourceIdentities??[]){
        const capability=sourceCapabilities[identity.sourceId];if(!capability)continue;
        const selectionId=capability.selectionFromIdentity?capability.selectionFromIdentity(identity.externalId):capability.urls&&identity.externalId.startsWith('https://www.boc.cn/')?identity.externalId.split('#')[0]:identity.sourceId==='beijing-sasac'?identity.externalId.split('#')[0]:identity.externalId;
        const selectionField=capability.urls&&capability.validUrl(selectionId)?capability.urls:capability.field;
        if(!(selectionField===capability.urls?capability.validUrl:capability.valid)(selectionId))continue;
        entries.push({jobId:job.id,...identity,selectionId,selectionField,...state.review,status:state.status});
      }}
      for(const [sourceId,capability] of Object.entries(sourceCapabilities)){
        const settings=application.getSourceSettings(sourceId);
        for(const field of [capability.field,...(capability.urls?[capability.urls]:[])])for(const externalId of settings[field]??[])if(!entries.some(x=>x.sourceId===sourceId&&x.selectionId===externalId))entries.push({jobId:null,sourceId,externalId,selectionId:externalId,selectionField:field,intervalDays:7,reasons:['selected_unprocessed'],due:true,nextReviewAt:null,lastDetailCheckedAt:null,status:'unverified'});
      }
      for(const candidate of candidates){
        if(['processed','excluded'].includes(candidate.status)||!candidate.scopeChanged&&entries.some(entry=>entry.sourceId===candidate.sourceId&&entry.selectionField===candidate.selectionField&&entry.selectionId===candidate.externalId))continue;
        if(jobRelevance(candidate).status==='out_of_scope')continue;
        const screened=candidate.screeningDecision?.status==='needs_material'&&candidate.lastScreenedAt;
        const onChange=screened&&candidate.screeningDecision.reviewPolicy==='on_change';
        const intervalDays=screened?7:1,lastCheckedAt=screened?candidate.lastScreenedAt:candidate.lastAttemptAt;
        const atTime=Date.parse(at),next=lastCheckedAt?new Date(Date.parse(lastCheckedAt)+intervalDays*86400000).toISOString():null;
        entries.push({jobId:null,sourceId:candidate.sourceId,externalId:candidate.externalId,selectionId:candidate.externalId,selectionField:candidate.selectionField,intervalDays,reasons:[onChange?'historical_listing_on_change':screened?'discovery_material_pending':'discovered_unprocessed'],due:onChange?false:!next||atTime>=Date.parse(next),nextReviewAt:onChange?null:next,...(onChange?{reviewPolicy:'on_change'}:{}),lastDetailCheckedAt:lastCheckedAt??null,status:'unverified',candidate});
      }
      const pendingProcessingIssues=application.listProcessingIssues().filter(x=>['failed','deferred','needs_material'].includes(x.status));
      for (const entry of entries) {
        const candidate=entry.candidate??candidateByKey.get([entry.sourceId,entry.selectionField,entry.selectionId].join(':'));
        if(!entry.jobId&&candidate?.screeningDecision?.reviewPolicy==='on_change'){entry.due=false;entry.nextReviewAt=null;entry.reviewPolicy='on_change';}
        if(!entry.jobId&&candidate&&(candidate.status==='excluded'||jobRelevance(candidate).status==='out_of_scope')){entry.due=false;entry.directionBlocked=true;entry.directionReason=candidate.excludedReason??'明确非技术岗位线索，不占用自动加工额度';}
        const job=entry.jobId?application.getSourceJob(entry.jobId):null;
        if(job&&(job.evidenceUse==='historical'||jobRelevance(job).status==='out_of_scope'||targetLocation(job).status==='excluded')){entry.due=false;entry.directionBlocked=true;entry.directionReason='历史、非北京或非技术岗位不再排入自动详情加工';}
        const capability=sourceCapabilities[entry.sourceId];
        const issue=pendingProcessingIssues.filter(x=>x.sourceId===entry.sourceId&&(capability.selectionFromIdentity?capability.selectionFromIdentity(x.externalId):capability.urls&&x.externalId.startsWith('https://www.boc.cn/')?x.externalId.split('#')[0]:x.externalId)===entry.selectionId).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
        if(issue?.scopeVersion===processingScopeVersion&&matchesTargetScope(issue.targetScopeKey)&&['failed','deferred'].includes(issue.status)&&issue.retryPolicy==='backoff'){
          entry.processingRetry=true;
          // Retry saved work at its own backoff deadline. The normal 24-hour
          // discovery interval must not postpone a budget recovery to day 3.
          if(!entry.directionBlocked){entry.nextReviewAt=issue.nextReviewAt;entry.due=!issue.nextReviewAt||Date.parse(at)>=Date.parse(issue.nextReviewAt);}
        }
        if(issue?.scopeVersion===processingScopeVersion&&matchesTargetScope(issue.targetScopeKey)&&(issue.retryPolicy==='on_change'||issue.nextReviewAt&&Date.parse(at)<Date.parse(issue.nextReviewAt))){entry.due=false;entry.processingBlocked=true;entry.nextReviewAt=issue.nextReviewAt;entry.processingIssueId=issue.id;entry.processingReason=issue.reason;}
        const sourceStatus=application.getSourceMonitoringStatus(entry.sourceId);
        if(sourceStatus.newOnlySince&&(!candidate||candidate.firstDiscoveredAt<=sourceStatus.newOnlySince)){entry.due=false;entry.newOnlyBlocked=true;entry.processingReason='补充渠道只跟踪新增，既有线索保留，不再自动重读';}
        const decision=entry.jobId?application.getJobMonitoringStatus(entry.jobId,{sourceId:entry.sourceId}):{enabled:sourceStatus.enabled&&!sourceStatus.scopeRestricted,reason:sourceStatus.reason??'共享来源的候选机构范围待核验，不自动读取详情或加工'};
        if(!decision.enabled){entry.due=false;entry.monitoringBlocked=true;entry.monitoringReason=decision.reason;}
      }
      const priority=entry=>entry.reasons.some(reason=>['followed','preparing','near_official_deadline'].includes(reason))?3:entry.processingRetry?2:entry.jobId===null?1:0;
      return entries.sort((a,b)=>priority(b)-priority(a)||(a.nextReviewAt??'').localeCompare(b.nextReviewAt??'')||(b.candidate?.raw?.listDate??'').localeCompare(a.candidate?.raw?.listDate??''));
    },
  };
  return operations;
}

// Build shared lookup data once per legacy check, then project only the requested
// role. Full saved lists/details remain available through the history endpoint.
export function indexLegacyRecruitmentCheck(run) {
 const projection=run.recruitmentProjection??run,pages=projection.pages??[],details=projection.details??[];
 const rows=pages.flatMap(page=>page.raw?.data?.pageForm?.pageData??[]),listed=new Set(rows.map(row=>row.postId));
 const complete=run.listComplete===true&&pages.length>0&&pages.every(page=>Array.isArray(page.raw?.data?.pageForm?.pageData))&&rows.length===run.listCount&&listed.size===run.listCount&&pages.at(-1).raw.data.pageForm.dataCount===run.listCount;
 const byId=new Map();
 for(const detail of details){const data=detail.raw?.data,id=data?.postId;if(!id||byId.has(id))continue;
  const valid=detail.status===200&&detail.applicationPage?.status===200&&typeof detail.applicationPage.raw==='string'&&detail.applicationPage.raw.includes('/pb/js/posDetail.js');
  const canDelivery=run.recruitmentProjection&&typeof data.canDelivery==='number'?Boolean(data.canDelivery):data.canDelivery;
  byId.set(id,{detailAccessible:valid?true:null,applicationOpen:valid&&typeof canDelivery==='boolean'?canDelivery&&data.showDeliverButton===1:null});
 }
 return {id:run.id,sourceId:run.sourceId,status:run.status,checkedAt:run.checkedAt,listCount:run.listCount,listComplete:run.listComplete,error:run.error??null,url:pages[0]?.url??run.officialChain?.[0]?.url??'https://job.efunds.com.cn/',complete,listed,details:byId};
}
