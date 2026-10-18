import {createProfileAnalysis} from './profile-analysis.mjs';
import {recruitmentTypeSupport} from './source-capabilities.mjs';
import {createLocalSettingsOperations,withLocalSettings} from './local-settings.mjs';
import {createChangeRevision} from './change-tracking.mjs';
import {withRunResources} from './run-resources.mjs';
import {createReadSnapshot} from './read-snapshot.mjs';
import {expandedSources as expandedDefinitions} from './expanded-source-catalog.mjs';
import {createExpandedSourceOperations} from './expanded-sources.mjs';
import {createSourceCheckLock} from './source-check-lock.mjs';
import {createSourceCheckTasks} from './source-check-tasks.mjs';
import {createOperationsOverview} from './operations-overview.mjs';
import {createModelBatch} from './model-batch.mjs';
import {createProcessingIssueOperations} from './processing-issues.mjs';
import {createModelUsageOperations} from './model-usage.mjs';
import {createProcessingHandoff} from './processing-handoff.mjs';
import {pendingAutomaticMatches} from './necessary-jobs.mjs';
import { jobDisplay } from './job-display.mjs';
import { createQualificationProfileOperations } from './qualification-profile.mjs';
import { sourceCapabilities } from './source-capabilities.mjs';
import { createSourceCandidateOperations } from './source-candidates.mjs';
import { filterJobs, sortJobs } from './job-filters.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { createBackupOperations, guardBackupWrites, recoverBackupLock } from './backup.mjs';
import { createPersonalOperations } from './personal.mjs';
import { createEligibilityOperations } from './eligibility.mjs';
import { createLifeCareerSource } from './career-life.mjs';
import { createCareerRefreshOperations } from './career-refresh.mjs';
import { createMatchingOperations } from './matching.mjs';
import { createMatchingProcessor } from './matching-codex.mjs';
import { createAnnouncementOperations } from './announcements.mjs';
import { createCodexProcessor } from './codex.mjs';
import { createIdentityOperations } from './identity.mjs';
import { createCmriOperations } from './cmri-source.mjs';
import { createIcbcOperations } from './icbc-source.mjs';
import { createSasacOperations } from './sasac-source.mjs';
import { createBocOperations } from './boc-source.mjs';
import { createCcbOperations } from './ccb-source.mjs';
import { createEfundsOperations } from './efunds-source.mjs';
import { createSourceHealthOperations } from './source-health.mjs';
import { createProcessingRecovery } from './processing-recovery.mjs';
import { createScheduledRunOperations } from './scheduled-run.mjs';
import { createNotificationOperations } from './notification-delivery.mjs';
import { createDailyActionOperations } from './daily-actions.mjs';
import { createRecruitmentOperations } from './recruitment.mjs';
import { createCorrectionOperations, createApplicationLinkOperations } from './corrections.mjs';
import {createHistoryOperations} from './history-store.mjs';

export class ValidationError extends Error {}

const optionalText = (value, field) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field}必须为文本`);
  return value.trim() || null;
};
const textList = (value, field) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new ValidationError(`${field}必须为文本列表`);
  return value.map(item => item.trim()).filter(Boolean);
};
const webUrl = (value, field) => {
  const text = optionalText(value, field);
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { throw new ValidationError(`${field}需要完整http或https链接`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ValidationError(`${field}需要无凭据的http或https链接`);
  return text;
};

function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('岗位信息必须为对象');
  const title = optionalText(input.title, '岗位标题');
  if (!title) throw new ValidationError('岗位标题不能为空');
  const originalText = optionalText(input.originalText, '原文');
  if (!originalText) throw new ValidationError('原文证据不能为空');
  const evidenceUse = input.evidenceUse ?? 'unverified';
  if (!['historical', 'current', 'unverified'].includes(evidenceUse)) throw new ValidationError('原文时效用途无效');
  const location = input.location ?? {};
  if (typeof location !== 'object' || Array.isArray(location)) throw new ValidationError('地点信息必须为对象');
  let applicationPath = null;
  if (input.applicationPath != null) {
    const path = input.applicationPath;
    if (!['direct', 'steps', 'email', 'announcement'].includes(path.kind)) throw new ValidationError('投递入口类型无效');
    applicationPath = {
      kind: path.kind,
      url: webUrl(path.url, '投递入口'),
      email: optionalText(path.email, '招聘邮箱'),
      steps: optionalText(path.steps, '投递步骤'),
      loginRequired: path.loginRequired === true,
    };
    if (path.kind === 'email' && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(applicationPath.email ?? '')) throw new ValidationError('招聘邮箱无效');
    if (['direct', 'steps'].includes(path.kind) && !applicationPath.url) throw new ValidationError('投递入口链接不能为空');
    if (['steps', 'announcement'].includes(path.kind) && !applicationPath.steps) throw new ValidationError('投递步骤不能为空，首页不能冒充岗位直达');
  }
  return {
    title, originalText, evidenceUse,
    recruitmentUnit: optionalText(input.recruitmentUnit, '招聘单位'),
    contractingEntity: optionalText(input.contractingEntity, '签约主体'),
    department: optionalText(input.department, '部门'),
    batch: optionalText(input.batch, '批次'),
    sourceUrl: webUrl(input.sourceUrl, '原文来源'),
    location: { options: textList(location.options, '公开地点选项'), confirmed: optionalText(location.confirmed, '确认地点'), note: optionalText(location.note, '地点缺口') },
    knownConditions: textList(input.knownConditions, '已知条件'),
    unknownFields: textList(input.unknownFields, '待补信息'),
    applicationPath,
    publishedAt: optionalText(input.publishedAt, '原始发布日期'),
  };
}

/** Web and background work use this application boundary and the same SQLite data. */
export function createApplication({ databasePath, initialSettings, expandedSources = false, now = () => new Date(), announcementProcessor, matchingProcessor, profileProcessor=null, careerSource, sourceFetch = fetch, bocAssociationRules, ccbSourceFetch, icbcFetch, cmriFetch, sasacFetch, sourceTimeoutMs, notificationTransport = null, backupRoot, verificationMode = false, sourceCheckLauncher=null, attachmentPython = process.env.JOBHUNTER_ATTACHMENT_PYTHON } = {}) {
  if (!databasePath) throw new Error('必须指定本机数据库路径');
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  verificationMode = verificationMode || existsSync(join(dirname(databasePath), 'restore-verification.json'));
  const recoveredBackupLock=verificationMode||databasePath===':memory:'?null:recoverBackupLock(databasePath);
  if (verificationMode) { announcementProcessor = null; matchingProcessor = null; profileProcessor=null; careerSource = null; sasacFetch = cmriFetch = ccbSourceFetch = icbcFetch = sourceFetch = async () => { throw new ValidationError('恢复核对模式不允许外部接入'); }; }
  let readOnlyActive = false, initializing=true;
  const nativeDb = new DatabaseSync(databasePath);
  const db = guardBackupWrites(nativeDb, databasePath, ValidationError, () => readOnlyActive,()=>initializing);
  db.exec('CREATE TABLE IF NOT EXISTS runtime_recovery_events(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  if(recoveredBackupLock)db.prepare('INSERT INTO runtime_recovery_events VALUES(?,?)').run(recoveredBackupLock.id,JSON.stringify(recoveredBackupLock));
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-32768; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  const changes=nativeDb.prepare('SELECT total_changes() AS value'),version=nativeDb.prepare('PRAGMA data_version');
  const readSnapshot=createReadSnapshot({revision:()=>version.get().data_version+':'+changes.get().value,clock:now});
  now=readSnapshot.now;
  const localSettings=createLocalSettingsOperations({db,databasePath,initialSettings,ValidationError});
  const getJob = readSnapshot.memoize('storedJob',id => {
    const row = db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    return row ? JSON.parse(row.body) : null;
  });
  const buildJob = (input, metadata = {}) => ({ ...normalizeJob(input), ...metadata, id: randomUUID(), recruitmentStatus: 'unverified', firstDiscoveredAt: now().toISOString() });
  const saveJob = job => db.prepare('INSERT INTO jobs (id, body, created_at) VALUES (?, ?, ?)').run(job.id, JSON.stringify(job), job.firstDiscoveredAt);
  const identityOperations = createIdentityOperations({ db, getJob, buildJob, now, ValidationError });
  const saveDerivedJob = (job, identity) => identity ? identityOperations.importJob({ ...job, ...identity }).job : (saveJob(job), job);
  const corrections = createCorrectionOperations({ db, getSourceJob: getJob, normalizeJob, now, ValidationError });
  const effectiveJob = corrections.getEffectiveJob;
  const qualificationProfiles = createQualificationProfileOperations({db,now,ValidationError});
  const currentQualificationProfile=()=>{
    const current=qualificationProfiles.getQualificationProfile();if(!current)return null;
    const profileId=matching.listCareerProfiles()[0]?.id;
    const obsolete=Object.keys(current.sources).filter(key=>current.sources[key].kind==='career'&&current.sources[key].reference!==profileId);
    if(!obsolete.length)return current;
    return {...current,stale:true,facts:Object.fromEntries(Object.entries(current.facts).filter(([key])=>!obsolete.includes(key))),sources:Object.fromEntries(Object.entries(current.sources).filter(([key])=>!obsolete.includes(key)))};
  };
  const eligibility = createEligibilityOperations({ db, getJob: effectiveJob, now, ValidationError, getQualificationProfile: currentQualificationProfile, getProfileContext: (profile, savedSource, careerProfileId) => {
    if (savedSource?.kind === 'qualification') return {profileSource: savedSource, profileStale: currentQualificationProfile()?.id !== savedSource.id||currentQualificationProfile()?.stale===true};
    return matching.getQualificationProfileContext(profile,savedSource,careerProfileId);
  } });
  const personalOperations = createPersonalOperations({ db, getJob: effectiveJob, now, ValidationError });
  const modelUsage=createModelUsageOperations({db,now,ValidationError});
  const processingIssues=createProcessingIssueOperations({db,now});
  const modelBatch=createModelBatch({recordAttempt:modelUsage.recordModelAttempt,reserveAutomatic:({method})=>modelUsage.reserveAutomaticModelCall({reservedForMatching:method==='process'&&matchingProcessor!==null&&application.listCareerProfiles().length?pendingAutomaticMatches(application).length:0})});
  const applicationLinks = createApplicationLinkOperations({ db, getApplication: personalOperations.getApplication, now, ValidationError });
  const matching = createMatchingOperations({ db, getJob: effectiveJob, eligibility, now, assertEnabled:jobId=>{if(!application.isJobMonitoringEnabled(jobId))throw new ValidationError("监控暂停，匹配加工停止");if((effectiveJob(jobId)?.sourceIdentities??[]).some(x=>sourceCapabilities[x.sourceId]&&!application.getSourceRecruitmentSupport(x.sourceId).supported))throw new ValidationError("该来源尚未支持所选招聘类型");}, processor: modelBatch.guard(matchingProcessor === undefined ? createMatchingProcessor({ workingRoot: dirname(databasePath) }) : matchingProcessor,'match'), ValidationError });
  const listJobs = (view='all') => {
    const scope=view==='followed'?" WHERE j.id IN (SELECT job_id FROM personal_states WHERE json_extract(body,'$.followed')=1)":view==='applied'?" WHERE j.id IN (SELECT job_id FROM applications WHERE NOT coalesce(json_extract(body,'$.corrected'),0))":'';
    return db.prepare('SELECT j.id FROM jobs j'+scope+' ORDER BY j.created_at DESC,j.rowid DESC').all().map(row=>effectiveJob(row.id));
  };
  const application = {
    ...localSettings,
    getSourceRecruitmentSupport:sourceId=>recruitmentTypeSupport(sourceId,localSettings.getLocalSettings()),
    unsupportedRecruitmentResult:sourceId=>({sourceId,status:'unsupported_type',reason:'该来源暂不支持所选招聘类型，校招尚未接通',gaps:[],businessGaps:['该来源暂不支持所选招聘类型，校招尚未接通'],jobIds:[]}),
    ...modelUsage,
    ...processingIssues,
    withModelBatch:(work,options)=>modelBatch.run(work,options),
    historyPython:attachmentPython??'python3',
    ...identityOperations,
    ...corrections,
    importJob(input) { const result = identityOperations.importJob(input); return { ...result, job: effectiveJob(result.job.id) }; },
    getSourceJob: getJob,
    createJob(input) { const job = buildJob(input); saveJob(job); return getJob(job.id); },
    ...createAnnouncementOperations({ db, now, buildJob, saveJob, saveDerivedJob, assertEnabled:item=>application.assertAnnouncementMonitoring(item), isAutomatic:modelBatch.isAutomatic, recordProcessing:processingIssues.recordAnnouncementProcessing, processor: modelBatch.guard(announcementProcessor === undefined ? createCodexProcessor({ workingRoot: dirname(databasePath) }) : announcementProcessor,'process'), attachmentPython, ValidationError }),
    ...personalOperations,
    ...applicationLinks,
    ...qualificationProfiles,
    getQualificationProfile:currentQualificationProfile,
    ...eligibility,
    ...matching,
    ...createCareerRefreshOperations({ db, matching:{...matching,saveCareerProfile:input=>application.saveCareerProfile(input)}, qualificationProfiles, listJobs, isJobMonitoringEnabled:jobId=>application.isJobMonitoringEnabled(jobId), shouldMatchJob:job=>{
      if(application.getPersonalState(job.id).notInterested||['ended','suspected_offline'].includes(application.getRecruitmentState(job.id).status))return false;
      let result=application.getEligibility(job.id);
      if(application.getQualificationProfile()&&(!result||result.stale))result=application.evaluateEligibility(job.id);
      return !(result?.status==='ineligible'&&!result.stale);
    }, now, source: careerSource === undefined ? createLifeCareerSource({getSettings:localSettings.getLocalSettings}) : careerSource, getSettings:localSettings.getLocalSettings, ValidationError }),
    getJob: effectiveJob,
    listJobs,
    close() { application.closeProfileAnalysis();db.close(); },
  };
  const guardedProfile=modelBatch.guard(profileProcessor?{profile:input=>profileProcessor.analyze(input)}:null,'profile');
  Object.assign(application,createProfileAnalysis({db,matching,qualificationProfiles,processor:guardedProfile?{analyze:input=>modelBatch.run(()=>guardedProfile.profile(input),{automatic:true})}:null,now,ValidationError,verificationMode}));
  const saveProfile=matching.saveCareerProfile;
  application.saveCareerProfile=input=>{
    const profile=saveProfile(input);application.enqueueProfileAnalysis(profile);application.scheduleProfileAnalysis(profile.id);return profile;
  };
  application.saveSettings=input=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('设置必须为对象');
    const {profileText,...patch}=input;
    const settings=localSettings.validateLocalSettings(patch);
    if(profileText!=null&&(typeof profileText!=='string'||!profileText.trim()||profileText.length>200000))throw new ValidationError('个人资料需要有效正文');
    let profile;
    db.exec('SAVEPOINT settings_save');
    try{
      localSettings.saveLocalSettings(settings);
      if(profileText!=null){profile=saveProfile({text:profileText,version:'manual-'+createHash('sha256').update(profileText.trim()).digest('hex').slice(0,16),sourceId:'manual'});application.enqueueProfileAnalysis(profile);}
      db.exec('RELEASE settings_save');
    }catch(error){db.exec('ROLLBACK TO settings_save; RELEASE settings_save');throw error;}
    if(profile)application.scheduleProfileAnalysis(profile.id);
    return {settings:localSettings.getLocalSettings(),profileId:profile?.id??null};
  };
  Object.assign(application, createRecruitmentOperations({ db, application, now, verificationMode, ValidationError }));
  Object.assign(application, createSourceCandidateOperations({db,application,now,ValidationError}));
  Object.assign(application, createSourceHealthOperations({ db, now, application, verificationMode, readSnapshot, ValidationError }));
  Object.assign(application, createSasacOperations({db,now,application,sasacFetch,sourceTimeoutMs,ValidationError}));
  Object.assign(application, createBocOperations({ db, now, application, sourceFetch, sourceTimeoutMs, associationRules: bocAssociationRules }));
  Object.assign(application, createCcbOperations({ db, now, application, sourceFetch: ccbSourceFetch, sourceTimeoutMs }));
  Object.assign(application, createEfundsOperations({ db, now, application, sourceFetch, sourceTimeoutMs }));
  Object.assign(application, createIcbcOperations({ db, now, application, icbcFetch, sourceTimeoutMs, attachmentPython, isAutomatic:modelBatch.isAutomatic, ValidationError }));
  Object.assign(application, createCmriOperations({ db, now, application, cmriFetch, sourceTimeoutMs, ValidationError }));
  if(expandedSources||expandedDefinitions.some(source=>db.prepare('SELECT id FROM source_registry WHERE id=?').get(source.id))){ Object.assign(application,createExpandedSourceOperations({db,now,application,sourceFetch,sourceTimeoutMs,ValidationError})); Object.assign(application,createCmriOperations({db,now,application,cmriFetch,sourceTimeoutMs,ValidationError,definition:expandedDefinitions.find(source=>source.type==='cmri')})); }
  application.assertAnnouncementMonitoring=item=>{
    for(const sourceId of [...(item.jobIdentities??[]).map(x=>x.sourceIdentity?.sourceId),item.sourceIdentityContext?.sourceId].filter(id=>sourceCapabilities[id]))if(!application.getSourceRecruitmentSupport(sourceId).supported)throw new ValidationError('该来源尚未支持所选招聘类型');
    const identities=item.jobIdentities??[],context=item.sourceIdentityContext;
    for(const identity of identities)if(sourceCapabilities[identity.sourceIdentity?.sourceId])application.assertSourceRequestAllowed(identity.sourceIdentity.sourceId,identity.sourceIdentity.externalId);
    if(context&&sourceCapabilities[context.sourceId])application.assertSourceRequestAllowed(context.sourceId,context.externalId);
  };
  // Every adapter entry uses the same monitoring gate, including manual HTTP checks.
  for (const [sourceId, capability] of Object.entries(sourceCapabilities)) {
    const check=application[capability.method];
    if(typeof check!=='function')continue;
    application[capability.method]=async (...args) => {
      if(!application.getSourceRecruitmentSupport(sourceId).supported)return application.unsupportedRecruitmentResult(sourceId);
      const monitoring=application.getSourceMonitoringStatus(sourceId);
      if(!monitoring.enabled)return {sourceId,status:'paused',monitoring,gaps:[],businessGaps:[monitoring.reason],jobIds:[]};
      const lease=application.acquireSourceCheckLock();
      try {
      const input=args[0]??{};
      if(typeof input!=='object'||Array.isArray(input))return await check(...args);
      const plan=application.listRecruitmentReviewPlan().filter(entry=>entry.sourceId===sourceId), fields=[capability.field,...(capability.urls?[capability.urls]:[])];
      const filtered={...input},blocked=[];
      for(const field of fields) {
        const selected=input[field]??application.getSourceSettings(sourceId)[field];
        if(!Array.isArray(selected))continue;
        const kept=selected.filter(selectionId=>{
          const entries=plan.filter(entry=>entry.selectionField===field&&entry.selectionId===selectionId);
          const allowed=!entries.some(entry=>entry.monitoringBlocked)&&(!monitoring.scopeRestricted||entries.some(entry=>entry.jobId&&!entry.monitoringBlocked));
          if(!allowed)blocked.push(selectionId);return allowed;
        });
        if(monitoring.scopeRestricted||kept.length!==selected.length)filtered[field]=kept;
      }
      if(monitoring.scopeRestricted||blocked.length){
        filtered.listOnly=fields.every(field=>!(filtered[field]??[]).length);
        if(filtered.listOnly)for(const field of fields)filtered[field]=[];
      }
      if(sourceId==='beijing-sasac'&&monitoring.scopeRestricted)filtered.processAnnouncements=false;
      const result=await modelBatch.run(()=>withRunResources(()=>check(filtered)),{automatic:input.trigger==='scheduled'});
      if(sourceId==='beijing-sasac'&&monitoring.scopeRestricted&&filtered.articleUrls?.length){
        const gap='已明确活跃机构的公告仅保存原文复查；整篇公告缺少逐岗位范围，不自动模型加工其他主体';
        application.recordSourceReviewMetadata(result.id,{monitoringGaps:[gap],processingScopeLimited:true});
        result.monitoringGaps=[gap];result.processingScopeLimited=true;
      }
      if(blocked.length)return {...result,monitoringDeferred:blocked,businessGaps:[...(result.businessGaps??[]),'目标暂停或具体机构范围待核验：保留候选，不自动读取相关详情或加工']};
      return result;
      }finally{application.releaseSourceCheckLock(lease);}
    };
  }
  const correctedJob = application.getJob;
  const sourceJobs = application.listJobs;
  const withRecruitment=(job,includeHistory)=>{if(!job)return null;const recruitment=application.getRecruitmentState(job.id,{includeHistory});return {...job,recruitmentStatus:recruitment.status,recruitment};};
  application.getJob = id => withRecruitment(correctedJob(id),true);
  application.getJobView=(id,{includeHistory=true}={})=>{const job=withRecruitment(correctedJob(id),includeHistory);if(!job)return null;const view={...job,personal:application.getPersonalState(id),eligibility:application.getEligibility(id),matching:application.getMatch(id)};return {...view,display:jobDisplay(view)};};
  application.listJobs = (filters = {}) => filterJobs(sourceJobs().map(job => withRecruitment(job,false)), filters, {getEligibility: application.getEligibility,getMatch: application.getMatch,getPersonalState: application.getPersonalState, ValidationError});
  application.listJobView = (view = 'all', filters = {}) => {
    if (!['all', 'followed', 'applied'].includes(view)) throw new ValidationError('岗位视图无效');
    const scoped=view==='all'?application.listJobs(filters):filterJobs(sourceJobs(view).map(job=>withRecruitment(job,false)),filters,{getEligibility:application.getEligibility,getMatch:application.getMatch,getPersonalState:application.getPersonalState,ValidationError});
    return sortJobs(scoped.map(job => ({ ...job,
      personal: application.getPersonalState(job.id),
      eligibility: application.getEligibility(job.id),
      matching: application.getMatch(job.id),
    })).map(job => ({...job,display:jobDisplay(job)})).filter(job => view === 'all' || job.personal[view] === true), filters.sort ?? 'recommendation');
  };
  Object.assign(application, createDailyActionOperations({db,application,now,ValidationError}));
  Object.assign(application, createNotificationOperations({db,application,now,transport:notificationTransport,verificationMode,ValidationError}));
  Object.assign(application, createBackupOperations({ db,backupDb:nativeDb, databasePath, now, verificationMode, backupRoot, attachmentPython, ValidationError }));
  Object.assign(application, createProcessingRecovery({db,application,now,verificationMode,ValidationError}));
  Object.assign(application, createScheduledRunOperations({db,application,now,verificationMode,ValidationError}));
  Object.assign(application, createOperationsOverview({db,application,now,verificationMode,ValidationError}));
  Object.assign(application,createProcessingHandoff({db,application,ValidationError}));
  // State transitions are recorded only on explicit work, never on page reads.
  for(const name of ['createJob','importJob','correctJob','saveQualificationProfile','evaluateEligibility','saveCareerProfile','recordRecruitmentObservation','recordSourceCheck']) {
    const operation=application[name];application[name]=(...args)=>{if(name==='recordRecruitmentObservation'&&sourceCapabilities[args[1]?.sourceId]&&!application.getJobMonitoringStatus(args[0],{sourceId:args[1].sourceId}).enabled)return application.getRecruitmentState(args[0]);const result=operation(...args);const id=['correctJob','evaluateEligibility','recordRecruitmentObservation'].includes(name)?args[0]:name==='createJob'?result.id:name==='importJob'?result.job.id:null;const sourceId=name==='recordSourceCheck'?args[0]?.sourceId:null;const jobIds=id?[id]:sourceId?db.prepare("SELECT j.id FROM jobs j WHERE EXISTS(SELECT 1 FROM json_each(j.body,'$.sourceIdentities') i WHERE json_extract(i.value,'$.sourceId')=?)").all(sourceId).map(row=>row.id):undefined;application.recordOperationalChanges({jobIds});return result;};
  }
  for(const name of ['matchJob','refreshCareerProfile','processAnnouncement']) {
    const operation=application[name];application[name]=async(...args)=>{const scope=()=>name==='matchJob'?{jobIds:[args[0]]}:name==='processAnnouncement'?{jobIds:application.getAnnouncement(args[0])?.jobIds??[]}:{};if(!verificationMode)application.recordOperationalChanges(scope());try{const result=await operation(...args);if(name==='processAnnouncement'&&!verificationMode)application.reconcileAnnouncementJobs(args[0]);return result;}finally{if(!verificationMode)application.recordOperationalChanges(scope());}};
  }
  const scheduled=application.runScheduledCycle;
  application.runScheduledCycle=(...args)=>modelBatch.run(()=>scheduled(...args),{automatic:(args[0]?.trigger??'scheduled')==='scheduled'});
  Object.assign(application,createSourceCheckLock({db,ValidationError}));
  Object.assign(application,createSourceCheckTasks({db,application,now,verificationMode,sourceCheckLauncher,ValidationError}));
  Object.assign(application,createHistoryOperations({db,ValidationError,readSnapshot}));
  application.getBusinessRevision=createChangeRevision(db,'actions_v1',[
    'jobs','job_corrections','recruitment_observations','recruitment_personal_dates',
    'personal_states','applications','eligibility_results','matching_results','career_profiles','qualification_profiles',
    'source_registry','monitoring_objects','discovery_monitoring','source_settings',
    'profile_analyses','local_settings','source_health_checks','source_health_state','source_health_events','processing_issues',
  ]);
  const operationsRevision=createChangeRevision(db,'operations_v1',[
    'source_candidates','announcements','run_checkpoints','source_check_tasks','model_usage',
    'notification_drafts','notification_deliveries','notification_attempts','backup_runs','career_refreshes',
  ]);
  application.getOperationsRevision=()=>application.getBusinessRevision()+':'+operationsRevision();
  application.databasePath=databasePath;
  application.verificationMode = verificationMode;
  application.syncProcessingIssues({incremental:true});
  const roots=new Set(['getJob','getJobView','listJobs','listJobView','getRecruitmentState','listRecruitmentReviewPlan','getSourcesOverview','getOperationsOverview','getOperationalChanges','getNotificationPreview','getScheduledStatus']);
  const reads=[...roots,'getSourceJob','getEligibility','getMatch','getPersonalState','getSourceMonitoringStatus','isJobMonitoringEnabled','getJobMonitoringStatus','getRecruitmentObservations','getStoredCheckSummary','getSourceCheckSummary','listSourceCandidates','listProcessingIssues','listCareerProfiles','getCareerProfile','getQualificationProfile','getSourceSettings','getCompletedSourceChecks','listRunSummaries'];
  for(const name of reads)if(typeof application[name]==='function'){
    const read=readSnapshot.memoize(name,application[name]);
    application[name]=roots.has(name)?(...args)=>readSnapshot.run(()=>read(...args)):read;
  }
  application.withReadSnapshot=readSnapshot.run;
  initializing=false;
  readOnlyActive = verificationMode;
  for(const [name,operation] of Object.entries(application))if(typeof operation==='function')application[name]=(...args)=>withLocalSettings(localSettings.getLocalSettings,()=>operation(...args),localSettings.getCompatibleTargetScopes);
  return application;
}
