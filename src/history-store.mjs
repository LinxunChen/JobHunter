import {indexLegacyRecruitmentCheck} from './recruitment.mjs';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate} from 'node:timers/promises';

const checkFields=['id','sourceId','status','trigger','checkedAt','finishedAt','scheduledFor','error','gaps','failureCategory','stage','listOnly','listCount','listComplete','catalogCount','catalogComplete','platformListComplete','attachmentsChecked','verification','jobIds','businessGaps','monitoringGaps','reviewPendingCount','reviewSelected','reviewDeferred','reviewDeferredPostIds','processingScopeLimited'];
const resultFields=['id','status','gaps','error','considered','pendingJobIds','results','limit','sourceId','profileId','profileVersion','change','nextCheckAt','nextSundayCheck'];
const fields=(value,keys)=>keys.flatMap(key=>[`'${key}'`,`json_extract(${value},'$.${key}')`]).join(',');
const compactResult=value=>`json_object(${fields(value,resultFields)})`;
const efundsProjection=value=>`CASE WHEN json_extract(${value},'$.sourceId')='efunds-social' THEN json_object('pages',json((SELECT json_group_array(json_object('url',json_extract(p.value,'$.url'),'raw',json_object('data',json_object('pageForm',json_object('dataCount',json_extract(p.value,'$.raw.data.pageForm.dataCount'),'pageData',json_extract(p.value,'$.raw.data.pageForm.pageData')))))) FROM json_each(${value},'$.pages') p)),'details',json((SELECT json_group_array(json_object('status',json_extract(d.value,'$.status'),'raw',json_object('data',json_object('postId',json_extract(d.value,'$.raw.data.postId'),'canDelivery',json_extract(d.value,'$.raw.data.canDelivery'),'showDeliverButton',json_extract(d.value,'$.raw.data.showDeliverButton'))),'applicationPage',json_object('status',json_extract(d.value,'$.applicationPage.status'),'raw',CASE WHEN instr(json_extract(d.value,'$.applicationPage.raw'),'/pb/js/posDetail.js')>0 THEN '/pb/js/posDetail.js' ELSE '' END))) FROM json_each(${value},'$.details') d))) ELSE NULL END`;
const registrationStarts=value=>`CASE WHEN json_extract(${value},'$.sourceId')='icbc-social' THEN json((SELECT json_group_array(json_object('externalId',json_extract(d.value,'$.data.postId'),'url',json_extract(d.value,'$.url'),'raw',json_extract(d.value,'$.data.enterBeginTime'))) FROM json_each(${value},'$.details') d WHERE json_extract(d.value,'$.decodedHtml') IS NOT NULL AND json_type(d.value,'$.raw')='text' AND instr(json_extract(d.value,'$.raw'),json_extract(d.value,'$.data.enterBeginTime'))>0)) ELSE NULL END`;
const checkSummary=value=>`json_object(${fields(value,checkFields)},'recruitmentProjection',${efundsProjection(value)},'registrationStarts',${registrationStarts(value)},'coverage',json_object(${['details','platformDetails','pages','catalogPages','platformPages','platformJobs','announcements'].flatMap(key=>[`'${key}'`,`json_array_length(${value},'$.${key}')`]).join(',')},'attachments',(SELECT count(*) FROM json_each(${value},'$.announcements') a,json_each(a.value,'$.attachments')),'attachmentsObtained',(SELECT count(*) FROM json_each(${value},'$.announcements') a,json_each(a.value,'$.attachments') f WHERE json_extract(f.value,'$.status')=200)))`;
const runSummary=value=>`json_object(${fields(value,['id','date','scheduledFor','trigger','status','startedAt','finishedAt','resumedAt','resumeCount','cycleAttempts','retryAt','owner','sources','gaps','recovery'])},'legacySnapshot',1,'steps',json((SELECT json_group_array(json_object(${fields('s.value',['key','status','startedAt','finishedAt','attempts'])},'result',${compactResult("json_extract(s.value,'$.result')")},'history',json((SELECT json_group_array(json_object(${fields('h.value',['status','startedAt','finishedAt'])},'result',${compactResult("json_extract(h.value,'$.result')")})) FROM json_each(s.value,'$.history') h)))) FROM json_each(${value},'$.steps') s)),'jobs',${compactResult(`json_extract(${value},'$.jobs')`)},'coverage',json_object('counts',json_extract(${value},'$.coverage.counts')),'today',json_object('checkedAt',json_extract(${value},'$.today.checkedAt'),'dailyDigest',json_extract(${value},'$.today.dailyDigest.id'),'importantDraft',json_extract(${value},'$.today.importantDraft.id')),'notifications',json_object('capability',json_extract(${value},'$.notifications.capability')))`;

// Original evidence tables stay intact. Small projections are maintained atomically by SQLite.
const definitions=[
 ['source_checks','source_checks',checkSummary],['source_health_checks','source_health_checks',checkSummary],
 ['scheduled_runs','scheduled_runs',runSummary],['run_checkpoints','scheduled_runs',value=>value],
 ['recruitment_observations','recruitment_observations',value=>`json_remove(${value},'$.evidence.text','$.published.evidence.text','$.start.evidence.text','$.deadline.evidence.text','$.explicitEnd.text')`],
 ...['career_refreshes','matching_results','announcements','source_check_tasks','notification_attempts','notification_deliveries','job_transitions'].map(kind=>[kind,kind,value=>`json_object(${fields(value,['id','jobId','sourceId','status','owner','date','at','observedAt','startedAt','finishedAt','createdAt','checkedAt','recordedAt','sendDeadlineAt','kind','recomputed'])})`]),
];
const parse=row=>row?JSON.parse(row.body):null;

export function installHistoryIndexes(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS history_records(kind TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,source_id TEXT,subject_id TEXT,date TEXT,status TEXT,started_at TEXT,completed_at TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE INDEX IF NOT EXISTS history_by_source ON history_records(kind,source_id,started_at DESC,ordinal DESC);
 CREATE INDEX IF NOT EXISTS history_checks_latest ON history_records(source_id,started_at DESC,ordinal DESC) WHERE kind IN ('source_checks','source_health_checks') AND status IN ('success','partial','failed');
 CREATE INDEX IF NOT EXISTS history_source_counts ON history_records(kind,source_id,status,id);
 CREATE INDEX IF NOT EXISTS history_legacy_proven ON history_records(source_id,ordinal) WHERE kind='source_checks' AND status IN ('success','partial','failed') AND json_type(body,'$.listComplete')='true';
 CREATE INDEX IF NOT EXISTS history_recruitment_current ON history_records(subject_id,ordinal) WHERE kind='recruitment_observations' AND json_extract(body,'$.acquisition')='success' AND coalesce(json_extract(body,'$.historical'),0)=0;
 CREATE INDEX IF NOT EXISTS history_checks_completed ON history_records(completed_at DESC,ordinal DESC) WHERE kind IN ('source_checks','source_health_checks') AND status IN ('success','partial','failed');
 CREATE INDEX IF NOT EXISTS history_by_completion ON history_records(source_id,completed_at DESC,kind);
 CREATE INDEX IF NOT EXISTS history_by_date ON history_records(kind,date,ordinal DESC);
 CREATE INDEX IF NOT EXISTS history_by_status ON history_records(kind,status,ordinal DESC);
 CREATE INDEX IF NOT EXISTS history_by_subject ON history_records(kind,subject_id,ordinal DESC);
 CREATE INDEX IF NOT EXISTS history_by_ordinal ON history_records(kind,ordinal DESC);
 CREATE TABLE IF NOT EXISTS history_migrations(kind TEXT PRIMARY KEY,position INTEGER NOT NULL,complete INTEGER NOT NULL);`);
 const available=definitions.filter(([table])=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
 for(const [table,kind,project] of available) {
  const sql=projectionInsert(table,kind,project,'NEW.');
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_${table}_insert AFTER INSERT ON ${table} BEGIN ${sql}; END;
   CREATE TRIGGER IF NOT EXISTS history_${table}_update AFTER UPDATE OF body ON ${table} BEGIN ${sql}; END;
   CREATE TRIGGER IF NOT EXISTS history_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM history_records WHERE kind='${kind}' AND id=OLD.id; END;`);
  if(!db.prepare('SELECT kind FROM history_migrations WHERE kind=?').get(table))db.prepare('INSERT INTO history_migrations VALUES(?,0,?)').run(table,db.prepare(`SELECT id FROM ${table} LIMIT 1`).get()?0:1);
 }
 return available;
}
function projectionInsert(table,kind,project,prefix='',condition='') {
 const value=prefix+'body',started=`coalesce(json_extract(${value},'$.checkedAt'),json_extract(${value},'$.startedAt'),json_extract(${value},'$.recordedAt'),json_extract(${value},'$.observedAt'),json_extract(${value},'$.at'),json_extract(${value},'$.createdAt'))`;
 const ordinal=table==='run_checkpoints'?`(SELECT r.rowid FROM scheduled_runs r WHERE r.id=${prefix||'run_checkpoints.'}id)`:`${prefix}rowid`;
 return `INSERT INTO history_records SELECT '${kind}',${prefix}id,${ordinal},json_extract(${value},'$.sourceId'),json_extract(${value},'$.jobId'),coalesce(json_extract(${value},'$.date'),strftime('%Y-%m-%d',${started},'+8 hours')),json_extract(${value},'$.status'),strftime('%Y-%m-%dT%H:%M:%fZ',${started}),strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(${value},'$.finishedAt'),${started})),${project(value)} ${prefix?'':`FROM ${table}`} ${condition} ON CONFLICT(kind,id) DO UPDATE SET ordinal=excluded.ordinal,source_id=excluded.source_id,subject_id=excluded.subject_id,date=excluded.date,status=excluded.status,started_at=excluded.started_at,completed_at=excluded.completed_at,body=excluded.body`;
}
export async function migrateHistoryIndexes({databasePath,batchSize=10,onProgress=()=>{},rebuild=false}) {
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS run_checkpoints(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 try {
  if(rebuild) {
   db.exec('BEGIN IMMEDIATE');
   try {
    for(const [table] of definitions)for(const action of ['insert','update','delete'])db.exec(`DROP TRIGGER IF EXISTS history_${table}_${action}`);
    if(db.prepare("SELECT name FROM sqlite_master WHERE name='history_records'").get())db.exec('DELETE FROM history_records; DELETE FROM history_migrations');
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
  }
  for(const [table,kind,project] of installHistoryIndexes(db)) {
   let state=db.prepare('SELECT * FROM history_migrations WHERE kind=?').get(table);
   while(!state.complete) {
    const rows=db.prepare(`SELECT rowid AS ordinal FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(state.position,batchSize);
    db.exec('BEGIN IMMEDIATE');
    try {
     for(const row of rows)db.exec(projectionInsert(table,kind,project,'',`WHERE rowid=${row.ordinal}`));
     state={position:rows.at(-1)?.ordinal??state.position,complete:rows.length<batchSize?1:0};
     db.prepare('UPDATE history_migrations SET position=?,complete=? WHERE kind=?').run(state.position,state.complete,table);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    onProgress({table,...state});await setImmediate();
   }
  }
  return {status:'completed',tables:db.prepare('SELECT * FROM history_migrations').all()};
 }finally{db.close();}
}

export function createHistoryOperations({db,ValidationError,readSnapshot}) {
 installHistoryIndexes(db);
 const requireReady=()=>{if(db.prepare('SELECT kind FROM history_migrations WHERE complete=0 LIMIT 1').get())throw new ValidationError('历史摘要尚未迁移，请先执行显式历史迁移；页面不会自行扫描历史');};
 const limitValue=limit=>{if(!Number.isInteger(limit)||limit<1||limit>100)throw new ValidationError('历史每页需1—100条');return limit;};
 const validKind=kind=>{if(!definitions.some(([,key])=>key===kind))throw new ValidationError('历史类型无效');};
 const sourceWhere=`kind IN ('source_checks','source_health_checks') AND status IN ('success','partial','failed') AND (kind='source_health_checks' OR NOT EXISTS(SELECT 1 FROM history_records h WHERE h.kind='source_health_checks' AND h.id=history_records.id))`;
 const hydrate=record=>{
  if(!record)return null;
  // Compatibility counts only; original page/detail bodies require an explicit record read.
  for(const key of ['pages','details','platformDetails'])if(Number.isInteger(record.coverage?.[key]))record[key]=Array.from({length:record.coverage[key]},()=>({}));
  for(const key of checkFields)if(!['error','failureCategory'].includes(key)&&record[key]===null)delete record[key];
  for(const key of ['listOnly','listComplete','catalogComplete','platformListComplete','processingScopeLimited'])if(typeof record[key]==='number')record[key]=Boolean(record[key]);
  for(const key of Object.keys(record.coverage??{}))if(record.coverage[key]===null)delete record.coverage[key];
  record.summary=true;return record;
 };
 const checkRow=row=>{const value=hydrate(parse(row));return value&&row.kind==='source_checks'?{...value,trigger:value.trigger??'manual',verification:value.verification??'read_only_projection'}:value;};
 const legacyIndex=id=>indexLegacyRecruitmentCheck(parse(db.prepare("SELECT body FROM history_records WHERE kind='source_checks' AND id=?").get(id)));
 const indexedLegacy=readSnapshot?readSnapshot.memoize('legacyCheckIndex',legacyIndex,{copyResult:false}):legacyIndex;
 const operations={
  assertHistoryReady:requireReady,
  getHistoryStatus(){return {ready:!db.prepare('SELECT kind FROM history_migrations WHERE complete=0 LIMIT 1').get()};},
  listHistoryPage({kind,sourceId,limit=20,cursor}={}) {
   requireReady();validKind(kind);limitValue(limit);
   if(cursor!=null&&(!/^\d+$/.test(String(cursor))||!Number.isSafeInteger(Number(cursor))))throw new ValidationError('历史游标无效');
   const clauses=['kind=?'],params=[kind];if(sourceId){clauses.push('source_id=?');params.push(sourceId);}if(cursor!=null){clauses.push('ordinal<?');params.push(Number(cursor));}
   const rows=db.prepare(`SELECT ordinal,body FROM history_records WHERE ${clauses.join(' AND ')} ORDER BY ordinal DESC LIMIT ?`).all(...params,limit+1);
   return {items:rows.slice(0,limit).map(row=>hydrate(parse(row))),nextCursor:rows.length>limit?String(rows[limit-1].ordinal):null,limit};
  },
  getHistoryRecord(kind,id){validKind(kind);return parse(db.prepare(`SELECT body FROM ${kind} WHERE id=?`).get(id));},
  hasHistoryRecord(kind,id){validKind(kind);return Boolean(db.prepare(`SELECT id FROM ${kind} WHERE id=?`).get(id));},
  listActiveOperationIds(kind,statuses){requireReady();validKind(kind);return db.prepare(`SELECT id FROM history_records WHERE kind=? AND status IN (${statuses.map(()=>'?').join(',')}) ORDER BY ordinal`).all(kind,...statuses).map(row=>row.id);},
  getRunCheckpoint(id){requireReady();return parse(db.prepare("SELECT body FROM history_records WHERE kind='scheduled_runs' AND id=?").get(id));},
  listRunSummaries({fromDate,toDate,limit=20,cursor}={}) {
   if(!fromDate&&!toDate)return operations.listHistoryPage({kind:'scheduled_runs',limit,cursor}).items;
   requireReady();limitValue(limit);return db.prepare("SELECT body FROM history_records WHERE kind='scheduled_runs' AND date>=? AND date<=? ORDER BY ordinal DESC LIMIT ?").all(fromDate??'0000',toDate??'9999',limit).map(parse);
  },
  hasFutureRun(at){requireReady();return Boolean(db.prepare("SELECT 1 FROM history_records WHERE kind='scheduled_runs' AND (started_at>? OR json_extract(body,'$.finishedAt')>?) LIMIT 1").get(at,at));},
  getSourceCheckSummary(sourceId,{limit=20}={}) {
   requireReady();limitValue(limit);const rows=db.prepare(`SELECT kind,body FROM history_records WHERE ${sourceWhere} AND source_id=? ORDER BY started_at DESC,ordinal DESC LIMIT ?`).all(sourceId,limit);
   const last=db.prepare(`SELECT started_at FROM history_records WHERE ${sourceWhere} AND source_id=? AND status='success' ORDER BY started_at DESC,ordinal DESC LIMIT 1`).get(sourceId);
   return {history:rows.map(checkRow),latest:checkRow(rows[0]),lastSuccessfulAt:last?.started_at??null,historyCount:db.prepare(`SELECT count(*) n FROM history_records WHERE ${sourceWhere} AND source_id=?`).get(sourceId).n};
  },
  getCompletedSourceChecks({from,through}) {
   requireReady();return db.prepare(`SELECT kind,body FROM history_records WHERE ${sourceWhere} AND completed_at>=? AND completed_at<=? ORDER BY completed_at DESC,ordinal DESC`).all(from,through).map(row=>hydrate(parse(row)));
  },
  getStoredCheckSummary(id){requireReady();return hydrate(parse(db.prepare("SELECT body FROM history_records WHERE kind='source_checks' AND id=?").get(id)));},
  getLegacyRecruitmentChecks(jobId,identity,{stateOnly=false}={}) {
   requireReady();const proof=stateOnly?" AND json_type(h.body,'$.listComplete')='true'":'';return db.prepare(`SELECT h.id FROM history_records h WHERE h.kind='source_checks' AND h.source_id=? AND h.status IN ('success','partial','failed') AND NOT EXISTS(SELECT 1 FROM recruitment_observations r WHERE r.id=h.id||':'||?||':'||?)  ${proof} ORDER BY h.ordinal`).all(identity.sourceId,jobId,identity.externalId).map(({id})=>{
    const index=indexedLegacy(id);
    return {id:index.id,sourceId:index.sourceId,status:index.status,checkedAt:index.checkedAt,listCount:index.listCount,listComplete:index.listComplete,error:index.error,legacyJobProjection:{externalId:identity.externalId,acquisition:index.complete?'success':'failed',listComplete:index.complete,listed:index.complete?index.listed.has(identity.externalId):null,detailAccessible:index.details.get(identity.externalId)?.detailAccessible??null,applicationOpen:index.details.get(identity.externalId)?.applicationOpen??null,url:index.url}};
   }).filter(run=>!stateOnly||run.legacyJobProjection.acquisition==='success');
  },
  getRecruitmentObservations(jobId,{stateOnly=false}={}){requireReady();const proof=stateOnly?" AND json_extract(body,'$.acquisition')='success' AND coalesce(json_extract(body,'$.historical'),0)=0":'';return db.prepare(`SELECT body FROM history_records WHERE kind='recruitment_observations' AND subject_id=? ${proof} ORDER BY ordinal`).all(jobId).map(row=>({...parse(row),summary:true}));},
  getSourceCoverageHistory(sourceId) {
   requireReady();const history=operations.listHistoryPage({kind:'source_checks',sourceId}).items;
   const latest=history[0]?operations.getHistoryRecord('source_checks',history[0].id):null;
   const last=db.prepare("SELECT started_at FROM history_records WHERE kind='source_checks' AND source_id=? AND status='success' ORDER BY ordinal DESC LIMIT 1").get(sourceId);
   return {latest,history,lastSuccessfulAt:last?.started_at??null,historyPage:{kind:'source_checks',sourceId}};
  },
 };
 return operations;
}
