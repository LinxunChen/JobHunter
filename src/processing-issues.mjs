import {createHash} from 'node:crypto';
import {announcementSource,processingScopeVersion} from './processing-scope.mjs';
export function createProcessingIssueOperations({db,now}) {
 db.exec("CREATE TABLE IF NOT EXISTS processing_issues(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS processing_issue_identity ON processing_issues(json_extract(body,'$.sourceId'),json_extract(body,'$.externalId'));");
 let queueReady=false;
 const installQueue=()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS processing_issue_sync_queue(id TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS processing_issue_sync_state(id TEXT PRIMARY KEY);
   CREATE TRIGGER IF NOT EXISTS processing_issue_dirty_insert AFTER INSERT ON announcements BEGIN INSERT INTO processing_issue_sync_queue VALUES(NEW.id) ON CONFLICT(id) DO NOTHING; END;
   CREATE TRIGGER IF NOT EXISTS processing_issue_dirty_update AFTER UPDATE OF body ON announcements BEGIN INSERT INTO processing_issue_sync_queue VALUES(NEW.id) ON CONFLICT(id) DO NOTHING; END;
   CREATE TRIGGER IF NOT EXISTS processing_issue_dirty_delete AFTER DELETE ON announcements BEGIN DELETE FROM processing_issue_sync_queue WHERE id=OLD.id; END;`);
  if(!db.prepare("SELECT id FROM processing_issue_sync_state WHERE id='v1'").get()){
   db.exec('SAVEPOINT processing_issue_sync_init');
   try{db.exec("INSERT OR IGNORE INTO processing_issue_sync_queue SELECT id FROM announcements ORDER BY created_at,rowid; INSERT INTO processing_issue_sync_state VALUES('v1'); RELEASE processing_issue_sync_init");}
   catch(error){db.exec('ROLLBACK TO processing_issue_sync_init; RELEASE processing_issue_sync_init');throw error;}
  }
  queueReady=true;
 };
 const parse=row=>row?JSON.parse(row.body):null;
 const recordCore=item=>{
  const source=announcementSource(item);if(!source.sourceId)return null;
  const outcomes={failed:'failed',deferred:'deferred',scope_pending:'needs_material',scope_excluded:'resolved',processed:'resolved',partial:'resolved'};
  const pendingRoles=item.sourceProcessingDecision?.roles?.filter(x=>x.status==='needs_material')??[];
  const status=item.status==='partial'&&pendingRoles.length?'needs_material':item.status==='failed'&&['batch_deferred','budget_deferred'].includes(item.processingReceipt?.failureCategory)?'deferred':outcomes[item.status];if(!status)return null;
  // Reuse any already-issued ID; titles may change while the strong official
  // identity remains the same. Broad/selected scopes have distinct external IDs.
  const previous=parse(db.prepare("SELECT body FROM processing_issues WHERE json_extract(body,'$.sourceId')=? AND json_extract(body,'$.externalId')=? ORDER BY rowid DESC LIMIT 1").get(source.sourceId,source.externalId));
  const id=previous?.id??createHash('sha256').update(JSON.stringify([source.sourceId,source.externalId])).digest('hex');
  if(!previous&&status==='resolved')return null;
  const reason=status==='needs_material'&&pendingRoles.length?'已加工符合范围岗位；仍需补齐：'+pendingRoles.map(x=>x.title+'（'+x.reason+'）').join('、'):status==='needs_material'||item.status==='scope_excluded'?item.sourceProcessingDecision?.reason:item.error??(status==='resolved'?'同一原文已成功处理':'等待模型执行恢复');
  const lastEvent=item.steps?.at(-1),observedAt=lastEvent?.at??item.sourceProcessingDecision?.checkedAt??item.createdAt??now().toISOString();
  if(previous&&previous.lastSeenAt>observedAt)return previous;
  if(previous?.announcementId===item.id&&previous.status===status&&previous.reason===reason&&previous.lastSeenAt===observedAt)return previous;
  const category=item.processingReceipt?.failureCategory??item.processingFailure?.stage??null;
  const deterministic=status==='failed'&&(['validation','job_build','save'].includes(item.processingFailure?.stage)||['configuration','tools','protocol','output'].includes(category))||status==='needs_material'&&item.sourceProcessingDecision?.reviewPolicy==='on_change';
  const value={...previous,id,...source,title:item.title,announcementId:item.id,contentVersion:item.contentVersion,status,reason:reason??'执行待处理',category,firstSeenAt:previous?.firstSeenAt??observedAt,lastSeenAt:observedAt,attempts:(previous?.attempts??0)+(status==='failed'&&previous?.lastSeenAt!==observedAt?1:0),scopeVersion:processingScopeVersion,targetScopeKey:item.sourceProcessingDecision?.targetScopeKey??null,retryPolicy:deterministic?'on_change':status==='needs_material'?'weekly':status==='resolved'?'none':'backoff',nextReviewAt:status==='resolved'||deterministic?null:new Date(Date.parse(observedAt)+(status==='needs_material'?7*86400000:900000)).toISOString(),diagnostics:item.processingReceipt?.diagnostics??previous?.diagnostics??null,history:[...(previous?.history??[]),{at:observedAt,status,reason,announcementId:item.id,category}].slice(-20),...(status==='resolved'?{resolvedAt:observedAt,resolution:item.status==='scope_excluded'?'明确不符合加工范围':'同一岗位原文加工通过'}:{resolvedAt:null,resolution:null})};
  db.prepare('INSERT INTO processing_issues VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(value));return value;
 };
 const record=(item,{storedBody}={})=>{
  const currentBody=queueReady?(storedBody??db.prepare('SELECT body FROM announcements WHERE id=?').get(item.id)?.body):null;
  const sameBody=currentBody&&JSON.stringify(JSON.parse(currentBody))===JSON.stringify(item);
  const result=recordCore(item);
  // Never clear a newer update committed by another process during reconciliation.
  if(sameBody)db.prepare('DELETE FROM processing_issue_sync_queue WHERE id=? AND EXISTS(SELECT 1 FROM announcements WHERE id=? AND body=?)').run(item.id,item.id,currentBody);
  return result;
 };
 return {
  recordAnnouncementProcessing:record,
  listProcessingIssues({includeResolved=false}={}) {return db.prepare('SELECT body FROM processing_issues ORDER BY rowid').all().map(parse).filter(x=>includeResolved||x.status!=='resolved');},
  syncProcessingIssues({incremental=false}={}) {
   installQueue();
   const ids=incremental?db.prepare('SELECT id FROM processing_issue_sync_queue ORDER BY rowid').all():db.prepare('SELECT id FROM announcements ORDER BY created_at,rowid').all();
   for(const {id} of ids){const row=db.prepare('SELECT body FROM announcements WHERE id=?').get(id);if(row)record(parse(row),{storedBody:row.body});}
   return this.listProcessingIssues();
  }
 };
}
