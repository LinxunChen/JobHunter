import {targetScopeKey,matchesTargetScope} from './local-settings.mjs';
import {sourceCapabilities} from './source-capabilities.mjs';
import {discoveryDeadline,discoveryEvidenceText} from './discovery-scope.mjs';
import {jobRelevance,targetLocation} from './job-relevance.mjs';
export function createSourceCandidateOperations({db,application,now,ValidationError}) {
  db.exec('CREATE TABLE IF NOT EXISTS source_candidates (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,body TEXT NOT NULL)');
  const parse=row=>row?JSON.parse(row.body):null;
  const list=sourceId=>db.prepare('SELECT body FROM source_candidates ORDER BY rowid').all().map(parse).filter(item=>!sourceId||item.sourceId===sourceId);
  const save=item=>db.prepare('INSERT INTO source_candidates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id,item.sourceId,JSON.stringify(item));
  return {
    listSourceCandidates(sourceId) {if(sourceId&&!sourceCapabilities[sourceId])throw new ValidationError('来源不存在');return list(sourceId).map(item=>{const changed=!matchesTargetScope(item.targetScopeKey);return changed?{...item,scopeChanged:true,status:'pending',excludedReason:null,screeningDecision:null,lastScreenedAt:null,lastAttemptAt:null}:item;}).map(item=>item.status==='pending'&&jobRelevance(item).status==='out_of_scope'?{...item,status:'excluded',excludedReason:'岗位名称不属于目标方向；保留线索，不自动加工'}:item);},
    recordSourceCandidates(run) {
      const capability=sourceCapabilities[run.sourceId];if(!capability)return [];
      const candidates=[],add=(externalId,selectionField,title,raw)=>{const valid=selectionField===capability.urls?capability.validUrl:capability.valid;if(typeof externalId==='string'&&valid(externalId))candidates.push({externalId,selectionField,title:title??null,raw});};
      if(run.sourceId==='efunds-social'&&run.listComplete)for(const item of (run.pages??[]).flatMap(page=>page.raw?.data?.pageForm?.pageData??[]))add(item.postId,'postIds',item.postName,item);
      if(run.sourceId==='boc-social'){
        if(run.platformListComplete)for(const item of run.platformJobs??[])add(item.id,'postIds',item.name,item);
        if(run.catalogComplete)for(const item of run.catalog??[])add(item.url,'announcementUrls',item.title,item);
      }
      if(run.sourceId==='ccb-social'&&run.listComplete)for(const item of run.listings??[])add(`${item.planId}:${item.planPost}:${item.secondOrgId}`,'postIds',item.planPostName,item);
      if(run.sourceId==='icbc-social'&&run.listComplete)for(const item of (run.pages??[]).flatMap(page=>page.data?.dataList??[]))add(item.postId,'postIds',item.postName,item);
      if((run.sourceId==='cmri-social'||run.cmriSource)&&run.listComplete)for(const item of (run.pages??[]).flatMap(page=>page.data?.jobList??[]))add(item.id,'postIds',item.name,item);
      if(run.sourceId==='beijing-sasac'&&run.listComplete)for(const item of run.listings??[])add(item.url,'articleUrls',item.title,item);
      if(run.expandedSource && (run.listComplete||run.listingWindowVerified||run.paginationRecovery?.unique>0))for(const item of run.listings??[])if(!['excluded','excluded_scope','scope_pending'].includes(item.category))add(item.externalId,capability.field,item.title,item);
      const jobs=application.listJobs(),expiredUrls=new Set(run.sourceId==='beijing-sasac'?application.listAnnouncements().filter(ann=>ann.sourceIdentityContext?.sourceId===run.sourceId&&discoveryDeadline(discoveryEvidenceText(ann),now()).status==='expired').map(ann=>ann.sourceUrl):[]);
      for(const item of candidates){
        const id=run.sourceId+':'+item.selectionField+':'+item.externalId,previous=parse(db.prepare('SELECT body FROM source_candidates WHERE id=?').get(id));
        let jobIds=jobs.filter(job=>job.sourceIdentities?.some(identity=>identity.sourceId===run.sourceId&&(identity.externalId===item.externalId||identity.externalId.startsWith(item.externalId+'#')||capability.selectionFromIdentity?.(identity.externalId)===item.externalId))).map(job=>job.id);
        const detail=[...(run.details??[]),...(run.platformDetails??[]),...(run.announcements??[]),...(run.skippedSelections??[])].find(entry=>(entry.externalId??entry.postId??entry.url)===item.externalId);
        const announcement=detail?.announcementId?application.getAnnouncement(detail.announcementId):null;
        if(announcement)jobIds=announcement.jobIds;
        const screening=announcement?.sourceProcessingDecision??detail?.processingDecision;
        const bodyExcluded=announcement?.status==='scope_excluded'?announcement.processingSkipped:screening?.status==='needs_material'?null:detail?.processingSkipped;
        if(typeof item.raw?.Duty==='string')item.duties=item.raw.Duty.replace(/<[^>]*>/g,'');
        const sameScope=matchesTargetScope(previous?.targetScopeKey);
        const sameListing=sameScope&&previous?.title===item.title&&JSON.stringify(previous.raw)===JSON.stringify(item.raw);
        const expired=expiredUrls.has(item.externalId)&&(!previous||sameListing);
        const direction=jobRelevance(item),location=run.expandedSource&&Array.isArray(item.raw?.locations)?targetLocation({location:{options:item.raw.locations}}):null,excludedReason=location?.status==='excluded'?location.reason:expired?'已保存正文明确截止日期已过，不再排入自动加工':bodyExcluded??(item.raw?.kind==='campus'||item.raw?.titleTypeHint==='campus'?'官方栏目明确校园招聘，不进入社招自动加工':direction.status==='out_of_scope'?'岗位名称不属于目标方向；保留列表线索，不自动加工':!jobIds.length&&sameListing?previous?.excludedReason:null);
        save({...previous,...item,id,targetScopeKey:previous&&!sameScope&&!detail?previous.targetScopeKey:targetScopeKey(),sourceId:run.sourceId,firstDiscoveredAt:previous?.firstDiscoveredAt??run.checkedAt,lastListedAt:run.checkedAt,sourceCheckId:run.id,status:excludedReason?'excluded':jobIds.length?'processed':'pending',excludedReason:excludedReason??null,jobIds,screeningDecision:screening??(sameListing?previous?.screeningDecision:null),lastScreenedAt:screening?run.checkedAt:sameListing?previous?.lastScreenedAt:null,statement:'完整列表中的发现线索；尚未证明相关、本人符合或当前开放。processed仅指已保存具体岗位，公告覆盖按实际scope。'});
      }
      return list(run.sourceId);
    },
    recordCandidateAttempts(sourceId,entries,run) {
      const actual=new Set([...(run.details??[]),...(run.platformDetails??[]),...(run.announcements??[]),...(run.skippedSelections??[]),...(run.detailAttempts??[])].map(x=>x.externalId??x.postId??x.url).filter(Boolean));
      for(const entry of entries){if(!actual.has(entry.selectionId))continue;const id=sourceId+':'+entry.selectionField+':'+entry.selectionId,previous=parse(db.prepare('SELECT body FROM source_candidates WHERE id=?').get(id));if(!previous||previous.status==='processed')continue;
        save({...previous,lastAttemptAt:run.checkedAt,lastAttemptRunId:run.id,lastAttemptStatus:run.status,lastAttemptError:run.error??null,lastAttemptGaps:[...(run.gaps??[]),...(run.businessGaps??[])],attemptCount:(previous.attemptCount??0)+1});
      }
      return list(sourceId);
    },
    reconcileCandidateAttempts() {
      let corrected=0;
      for(const candidate of list()){
        if(!candidate.lastAttemptRunId)continue;
        const row=db.prepare('SELECT body FROM source_checks WHERE id=?').get(candidate.lastAttemptRunId);if(!row)continue;const run=parse(row);
        if(!run.error||!['processing','attachment_scoping'].includes(run.stage))continue;
        const details=[...(run.details??[]),...(run.platformDetails??[]),...(run.announcements??[])];
        if(details.some(x=>(x.externalId??x.postId??x.url)===candidate.externalId||x.data?.id===candidate.externalId||x.raw?.data?.postId===candidate.externalId||x.requestParameters?.postId===candidate.externalId))continue;
        const previous={at:candidate.lastAttemptAt,runId:candidate.lastAttemptRunId,status:candidate.lastAttemptStatus};
        save({...candidate,lastAttemptAt:null,lastAttemptRunId:null,lastAttemptStatus:null,lastAttemptError:null,lastAttemptGaps:[],attemptCount:Math.max(0,(candidate.attemptCount??1)-1),attemptCorrections:[...(candidate.attemptCorrections??[]),{at:now().toISOString(),previous,reason:'首项失败退出，选中条目未实际读取详情；恢复排队'}]});corrected++;
      }
      return {corrected};
    },
  };
}
