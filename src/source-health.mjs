import { sourceCapabilities,recruitmentEntries } from './source-capabilities.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sourceFailureCategory } from './source-failure.mjs';
const entryAudit = JSON.parse(readFileSync(new URL('./source-entry-audit.json', import.meta.url), 'utf8'));
const seeds = JSON.parse(readFileSync(new URL('./monitoring-seeds.json', import.meta.url), 'utf8')).items;
const initial = [
  { id: 'boc-social', name: '中国银行', monitoringObjectIds: ['seed-01'] },
  { id: 'ccb-social', name: '建设银行', monitoringObjectIds: ['seed-04'] },
  { id: 'icbc-social', name: '工商银行', monitoringObjectIds: ['seed-02'] },
  { id: 'cmri-social', name: '中国移动研究院', monitoringObjectIds: ['seed-23'] },
  { id: 'beijing-sasac', name: '北京国资委发现入口', monitoringObjectIds: [], kind: 'discovery' },
  { id: 'efunds-social', name: '易方达官方社招平台（主体分别核验）', monitoringObjectIds: ['seed-39'], implemented: true, expansion: true, scope: '完整公开社招列表；持久选中ID详情及申请页；关联主体不等于基金本体；附件未检索' },
].map(item => ({ kind: 'recruitment', implemented: false, initial: !item.expansion, scope: '待来源接入与真实覆盖验证', ...item }));
export function createSourceHealthOperations({ db, now, application, verificationMode = false, readSnapshot, ValidationError }) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_registry (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_health_checks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_health_state (source_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_health_events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_settings (source_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_objects (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS discovery_monitoring (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  const parse = row => row ? JSON.parse(row.body) : null;
  const memo=(name,work)=>readSnapshot?readSnapshot.memoize(name,work,{copyResult:false}):work;
  const source = memo('monitoringSource',id => parse(db.prepare('SELECT body FROM source_registry WHERE id=?').get(id)));
  const getSources = memo('monitoringSources',() => db.prepare('SELECT body FROM source_registry ORDER BY rowid').all().map(parse));
  const events = () => db.prepare('SELECT body FROM source_health_events ORDER BY rowid').all().map(parse);
  const date = (value, field) => { if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ValidationError(`${field}需含时区的有效时刻`); return new Date(value).toISOString(); };
  for (const item of initial) db.prepare('INSERT OR IGNORE INTO source_registry VALUES(?,?)').run(item.id, JSON.stringify(item));
  for (const seed of seeds) db.prepare('INSERT OR IGNORE INTO monitoring_objects VALUES(?,?)').run(seed.id, JSON.stringify({...seed, monitoringStatus:'active', originalName:seed.name, officialUrl:null, updatedAt:null}));
  const objects = memo('monitoringObjects',() => db.prepare('SELECT body FROM monitoring_objects ORDER BY rowid').all().map(parse));
  const projectObject = item => { const links=getSources().filter(source=>source.monitoringObjectIds.includes(item.id));return {...item,entryAudit:entryAudit[item.id]??null,sourceIds:links.map(source=>source.id),integrationStatus:links.some(source=>source.implemented&&sourceCapabilities[source.id])?'implemented':'pending',recruitmentEntries:links.flatMap(source=>(recruitmentEntries[source.id]??[]).map(entry=>({...entry,sourceId:source.id}))),coverage:links.map(source=>({sourceId:source.id,name:source.name,scope:source.scope,shared:true}))}; };
  const validateObject = input => {
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['name','officialUrl','note','monitoringStatus'].includes(key))) throw new ValidationError('目标机构字段无效，不允许以名称或入口自行关联适配器');
    if (Object.hasOwn(input,'name') && (typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>200)) throw new ValidationError('目标机构名称需1—200字符');
    if (Object.hasOwn(input,'note') && input.note!=null && (typeof input.note!=='string'||input.note.length>2000)) throw new ValidationError('目标机构备注无效');
    if (Object.hasOwn(input,'monitoringStatus') && !['active','paused','removed'].includes(input.monitoringStatus)) throw new ValidationError('监控状态无效');
    if (input.officialUrl) { let url;try{url=new URL(input.officialUrl);}catch{throw new ValidationError('官方入口需完整链接');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new ValidationError('官方入口需无凭据的http或https链接'); }
    if (Object.hasOwn(input,'officialUrl') && input.officialUrl!=null && typeof input.officialUrl!=='string') throw new ValidationError('官方入口需文本链接');
    return {...input,...(input.name?{name:input.name.trim()}:{}),...(Object.hasOwn(input,'officialUrl')?{officialUrl:input.officialUrl||null}:{})};
  };
  const history = id => db.prepare('SELECT body FROM source_health_checks WHERE source_id=? ORDER BY rowid DESC').all(id).map(parse).sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));
  const settings = id => {
    const capability = sourceCapabilities[id];
    if (!capability) throw new ValidationError('该来源尚无详情选择配置入口');
    return parse(db.prepare('SELECT body FROM source_settings WHERE source_id=?').get(id)) ?? {sourceId:id,[capability.field]:[...capability.defaults],...(capability.urls?{[capability.urls]:[],announcementScopes:{}}:{}),selectionOrigin:'initial_public_sample',updatedAt:null};
  };
  const monitoringSnapshot=()=>Object.fromEntries(application.listJobs().map(job=>[job.id,operations.isJobMonitoringEnabled(job.id)]));
  const applyMonitoringChange=before=>{
    const after=monitoringSnapshot(),jobIds=Object.keys(after).filter(id=>before[id]!==after[id]);
    application.suppressPausedActions?.({baseline:jobIds.length>0,jobIds});application.cancelPausedNotificationRetries?.();
  };
  const operations = {
    listMonitoringObjects() { return objects().map(projectObject); },
    createMonitoringObject(input) {
      const fields=validateObject(input);if(!fields.name)throw new ValidationError('目标机构名称不能为空');
      const item={id:randomUUID(),name:fields.name,originalName:fields.name,tier:'本人新增',note:null,officialUrl:null,monitoringStatus:'active',...fields,createdAt:now().toISOString(),updatedAt:now().toISOString()};
      db.prepare('INSERT INTO monitoring_objects VALUES(?,?)').run(item.id,JSON.stringify(item));return projectObject(item);
    },
    updateMonitoringObject(id,input) {
      const previous=parse(db.prepare('SELECT body FROM monitoring_objects WHERE id=?').get(id));if(!previous)throw new ValidationError('目标机构不存在');
      const item={...previous,...validateObject(input),updatedAt:now().toISOString()},before=monitoringSnapshot();
      db.exec('SAVEPOINT monitoring_update');
      try {db.prepare('UPDATE monitoring_objects SET body=? WHERE id=?').run(JSON.stringify(item),id);applyMonitoringChange(before);db.exec('RELEASE monitoring_update');}
      catch(error){db.exec('ROLLBACK TO monitoring_update; RELEASE monitoring_update');throw error;}return projectObject(item);
    },
    getSourceMonitoringStatus(id) {
      const item=source(id);if(!item)throw new ValidationError('来源不存在');
      const linked=objects().filter(object=>item.kind==='discovery'||item.monitoringObjectIds.includes(object.id));
      const active=linked.filter(object=>object.monitoringStatus==='active');
      const enabled=item.kind==='discovery'?(parse(db.prepare('SELECT body FROM discovery_monitoring WHERE id=?').get(id))?.enabled??true):active.length>0;
      const discovery=item.kind==='discovery'?parse(db.prepare('SELECT body FROM discovery_monitoring WHERE id=?').get(id)):null;
      return {sourceId:id,enabled,newOnlySince:discovery?.newOnlySince??null,scopeRestricted:item.kind==='discovery'?objects().some(object=>object.monitoringStatus!=='active'):linked.some(object=>object.monitoringStatus!=='active')&&active.length>0,activeObjectIds:active.map(object=>object.id),inactiveObjectIds:linked.filter(object=>object.monitoringStatus!=='active').map(object=>object.id),reason:enabled?null:'关联目标已暂停或移出监控，已有资料与历史保留'};
    },
    setDiscoveryNewOnly(id) {
      if(source(id)?.kind!=='discovery')throw new ValidationError('发现入口不存在');
      const previous=parse(db.prepare('SELECT body FROM discovery_monitoring WHERE id=?').get(id))??{enabled:true};
      const value={...previous,newOnlySince:previous.newOnlySince??now().toISOString(),updatedAt:now().toISOString()};
      db.prepare('INSERT INTO discovery_monitoring VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(value));return value;
    },
    setDiscoveryMonitoring(id,enabled) {
      if(source(id)?.kind!=='discovery'||typeof enabled!=='boolean')throw new ValidationError('发现入口开关无效');
      const before=monitoringSnapshot();db.exec('SAVEPOINT discovery_update');try {
        const previous=parse(db.prepare('SELECT body FROM discovery_monitoring WHERE id=?').get(id))??{};
        db.prepare('INSERT INTO discovery_monitoring VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify({...previous,enabled,updatedAt:now().toISOString()}));
        applyMonitoringChange(before);db.exec('RELEASE discovery_update');
      }catch(error){db.exec('ROLLBACK TO discovery_update; RELEASE discovery_update');throw error;}
      return operations.getSourceMonitoringStatus(id);
    },
    assertSourceRequestAllowed(id,selectionId) {
      const monitoring=operations.getSourceMonitoringStatus(id);
      if(!monitoring.enabled)throw new ValidationError('监控已暂停，后续请求停止');
      if(selectionId) {
        const plan=application.listRecruitmentReviewPlan().filter(entry=>entry.sourceId===id&&entry.selectionId===selectionId);
        if(plan.some(entry=>entry.monitoringBlocked)||(monitoring.scopeRestricted&&!plan.some(entry=>entry.jobId&&!entry.monitoringBlocked)))throw new ValidationError('对象已暂停或共享来源归属待确认，后续详情停止');
      }
    },
    isSourceSelectionAllowed(id,selectionId) {try{operations.assertSourceRequestAllowed(id,selectionId);return true;}catch{return false;}},
    getJobMonitoringStatus(jobId,{sourceId}={}) {
      const job=application.getSourceJob(jobId);if(!job)throw new ValidationError('岗位不存在');
      const exact=objects().filter(object=>[object.name,object.originalName].includes(job.recruitmentUnit));
      if(exact.some(object=>object.monitoringStatus!=='active'))return {enabled:false,reason:'岗位明确对应已暂停或移出的目标机构',monitoringObjectIds:exact.map(object=>object.id)};
      const ids=sourceId?[sourceId]:(job.sourceIdentities??[]).map(identity=>identity.sourceId).filter(id=>source(id));
      if(!ids.length)return {enabled:true,reason:null,monitoringObjectIds:exact.map(object=>object.id)};
      const decisions=ids.map(id=>application.getSourceMonitoringStatus(id));
      const eligible=decisions.some(decision=>decision.enabled&&(!decision.scopeRestricted||exact.some(object=>decision.activeObjectIds.includes(object.id))));
      return {enabled:eligible,reason:eligible?null:'监控已暂停，或共享来源的具体机构范围待核验；保留资料且不自动加工',monitoringObjectIds:exact.map(object=>object.id)};
    },
    isJobMonitoringEnabled(jobId) { return operations.getJobMonitoringStatus(jobId).enabled; },
    registerSource(input) {
      if (!input || !/^[a-z][a-z0-9-]{1,80}$/.test(input.id) || typeof input.name!=='string' || !input.name.trim() || typeof input.scope!=='string' || !input.scope.trim() || !['recruitment','discovery'].includes(input.kind)) throw new ValidationError('来源登记字段无效');
      if(!Array.isArray(input.monitoringObjectIds) || input.monitoringObjectIds.some(id=>!objects().some(item=>item.id===id))) throw new ValidationError('来源关联监控对象无效');
      if(input.kind==='discovery' && input.monitoringObjectIds.length) throw new ValidationError('发现入口不计为招聘监控对象');
      const item={...source(input.id),...structuredClone(input),implemented:true};
      db.prepare('INSERT INTO source_registry VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id,JSON.stringify(item));return structuredClone(item);
    },
    getSourceSettings(id) { return settings(id); },
    setSourceSettings(id,input) {
      const previous = settings(id), capability = sourceCapabilities[id];
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('来源选择需对象');
      const fields = [capability.field, ...(capability.urls ? [capability.urls] : [])];
      const value = {...previous, selectionOrigin:'user_selected', updatedAt:now().toISOString()};
      for (const field of fields) if (Object.hasOwn(input, field)) {
        const values = input[field], limit = field === capability.urls ? capability.urlLimit : capability.limit, valid = field === capability.urls ? capability.validUrl : capability.valid;
        if (!Array.isArray(values) || values.length > limit || values.some(item => typeof item !== 'string' || !valid(item)) || (id === 'efunds-social' && !values.length)) throw new ValidationError('选中岗位ID或公告URL超出来源许可范围');
        value[field] = [...new Set(values)];
      }
      if (id === 'boc-social' && Object.hasOwn(input, 'announcementScopes')) {
        const scopes = input.announcementScopes;
        if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes) || Object.keys(scopes).some(url => !value.announcementUrls.includes(url))) throw new ValidationError('公告选中范围需对应已选URL');
        for (const scope of Object.values(scopes)) if (!scope || typeof scope !== 'object' || !scope.targetJob || typeof scope.targetJob.title !== 'string' || !scope.targetJob.title.trim() || Object.keys(scope).some(key => !['targetJob','documentScopes'].includes(key)) || Object.keys(scope.targetJob).some(key => !['title','recruitmentUnit','department','batch'].includes(key)) || ['recruitmentUnit','department','batch'].some(key => scope.targetJob[key]!=null && (typeof scope.targetJob[key]!=='string'||!scope.targetJob[key].trim())) || (scope.documentScopes!=null&&!Array.isArray(scope.documentScopes))) throw new ValidationError('公告选中范围必须含唯一岗位与附件段落');
        value.announcementScopes = structuredClone(scopes);
      }
      if (id === 'boc-social') value.announcementScopes = Object.fromEntries(Object.entries(value.announcementScopes ?? {}).filter(([url]) => value.announcementUrls.includes(url)));
      db.prepare('INSERT INTO source_settings VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(value));return value;
    },
    async runSourceCheck(id,{scheduledFor,trigger='scheduled'}={}) {
      if (!sourceCapabilities[id]) throw new ValidationError('该来源尚无计划检查适配入口');
      return application.checkDueRecruitmentDetails({sourceId:id,trigger,scheduledFor:trigger==='scheduled'?date(scheduledFor,'计划时刻'):null});
    },
    recordSourceReviewMetadata(checkId, metadata) {
      const fields = ['reviewPendingCount','reviewSelected','reviewDeferred','reviewDeferredPostIds','listOnly','monitoringGaps','processingScopeLimited'];
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(key => !fields.includes(key))) throw new ValidationError('复查元数据字段无效');
      const run = parse(db.prepare('SELECT body FROM source_health_checks WHERE id=?').get(checkId));
      if (!run) return null;
      const updated = {...run, ...structuredClone(metadata)};
      db.prepare('UPDATE source_health_checks SET body=? WHERE id=?').run(JSON.stringify(updated), checkId);
      return updated;
    },
    recordSourceCheck(input) {
      if (!input || !source(input.sourceId) || typeof input.id !== 'string' || !input.id || !['success','partial','failed'].includes(input.status)) throw new ValidationError('来源检查身份或完成状态无效');
      const trigger=input.trigger ?? 'manual';
      if (!['manual','scheduled'].includes(trigger)) throw new ValidationError('来源检查触发方式无效');
      const run={...structuredClone(input),trigger,checkedAt:date(input.checkedAt,'检查时刻'),scheduledFor:trigger==='scheduled'?date(input.scheduledFor,'计划时刻'):null};
      if (run.status==='success' && run.gaps?.length) run.status='partial';
      run.failureCategory=sourceFailureCategory(run);
      const existing=parse(db.prepare('SELECT body FROM source_health_checks WHERE id=?').get(run.id));
      if (existing) { if (JSON.stringify(existing)!==JSON.stringify(run)) throw new ValidationError('检查ID已对应另一份完成证据'); return existing; }
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO source_health_checks VALUES(?,?,?)').run(run.id,run.sourceId,JSON.stringify(run));
        const reasons=[run.error,...(run.gaps??[])].filter(Boolean);
        const budgetOnly=reasons.length>0&&reasons.every(reason=>/今日自动模型调用已达\d+次/.test(reason));
        const processingOnly=run.failureCategory==='processing'&&(run.listComplete===true||run.platformListComplete===true||run.catalogComplete===true);
        if(trigger==='scheduled'&&!budgetOnly&& (run.failureCategory!=='processing'||processingOnly)) {
          const state=parse(db.prepare('SELECT body FROM source_health_state WHERE source_id=?').get(run.sourceId)) ?? {consecutiveScheduledFailures:0,lastScheduledFor:null,activeEventId:null};
          if(!state.lastScheduledFor || run.scheduledFor>state.lastScheduledFor) {
            state.lastScheduledFor=run.scheduledFor;
            if(run.status==='success'||processingOnly) {
              if(state.activeEventId) { const event=parse(db.prepare('SELECT body FROM source_health_events WHERE id=?').get(state.activeEventId));event.status='recovered';if(event.notificationStatus==='pending') event.notificationStatus='cancelled_on_recovery';event.recoveredAt=run.checkedAt;event.recoveryCheckId=run.id;db.prepare('UPDATE source_health_events SET body=? WHERE id=?').run(JSON.stringify(event),event.id); }
              state.consecutiveScheduledFailures=0;state.activeEventId=null;
            } else {
              state.consecutiveScheduledFailures++;
              if(state.consecutiveScheduledFailures>=2) {
                const event=state.activeEventId?parse(db.prepare('SELECT body FROM source_health_events WHERE id=?').get(state.activeEventId)):{id:randomUUID(),sourceId:run.sourceId,type:'source_persistent_failure',status:'active',notificationStatus:'pending',createdAt:run.checkedAt,recoveredAt:null};
                event.failureCategory=run.failureCategory;event.stage=run.stage??null;event.checkStatus=run.status;event.failureCount=state.consecutiveScheduledFailures;event.latestCheckId=run.id;event.latestFailureAt=run.checkedAt;event.error=run.error ?? null;event.gaps=run.gaps ?? [];
                db.prepare('INSERT INTO source_health_events VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(event.id,JSON.stringify(event));state.activeEventId=event.id;
              }
            }
            db.prepare('INSERT INTO source_health_state VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET body=excluded.body').run(run.sourceId,JSON.stringify(state));
          }
        }
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK');throw error; }
      application.recordRecruitmentSourceCheck?.(run);
      application.recordSourceCandidates?.(run);
      return structuredClone(run);
    },
    listSourceHealthEvents() { return events(); },
    reconcileProcessingHealthEvents() {
      let corrected=0;
      for(const event of events().filter(x=>x.status==='active'&&x.failureCategory==='processing')) {
        const current=parse(db.prepare('SELECT body FROM source_health_state WHERE source_id=?').get(event.sourceId));
        const value={...event,status:'reclassified',reclassifiedAt:now().toISOString(),resolution:'模型加工问题改由同一原文的processing_issues跟踪；不属于招聘网站持续故障',...(event.notificationStatus==='pending'?{notificationStatus:'cancelled_on_reclassification'}:{})};
        db.prepare('UPDATE source_health_events SET body=? WHERE id=?').run(JSON.stringify(value),event.id);
        if(current?.activeEventId===event.id)db.prepare('UPDATE source_health_state SET body=? WHERE source_id=?').run(JSON.stringify({...current,activeEventId:null,consecutiveScheduledFailures:0}),event.sourceId);
        corrected++;
      }
      return {corrected};
    },
    getSourcesOverview({historyLimit=20}={}) {
      const sources=getSources().map(item=>({...item,recruitmentEntries:recruitmentEntries[item.id]??[],monitoring:operations.getSourceMonitoringStatus(item.id),...application.getSourceCheckSummary(item.id,{limit:historyLimit}),health:parse(db.prepare('SELECT body FROM source_health_state WHERE source_id=?').get(item.id))??{consecutiveScheduledFailures:0,lastScheduledFor:null,activeEventId:null}}));
      return {monitoringObjects:objects().map(projectObject),sources:sources.map(source=>({...source,...application.getSourceRecruitmentSupport(source.id)})),events:events(),counts:{included:objects().filter(object=>object.monitoringStatus!=='removed').length,implemented:sources.filter(x=>x.implemented).length,successful:sources.filter(x=>x.latest?.status==='success').length,initialMonitoringObjects:4,discoveryEntrypoints:1}};
    },
  };
  return operations;
}
