import {createDirtyQueue} from './change-tracking.mjs';
import {createHash} from 'node:crypto';
import {expandedSources,validExpandedSelection} from './expanded-source-catalog.mjs';

// Stable official role IDs do not require inventing a missing employer name.
// Broad notices remain subject to their existing employer/role identity rules.
export function officialRoleIdentity(context) {
 const source=expandedSources.find(x=>x.id===context?.sourceId);
 if(!source||!['classic-beisen','spdb'].includes(source.type))return null;
 try {
  const url=new URL(context.externalId),origin=new URL(source.url).origin;
  if(url.origin!==origin||url.username||url.password||url.hash||url.pathname!==(source.type==='classic-beisen'?'/szzwxq':'/jobDetail'))return null;
  const id=url.searchParams.get('jobId');return validExpandedSelection(source,id)?{sourceId:source.id,externalId:id}:null;
 }catch{return null;}
}

export function createProcessingHandoff({db,application,ValidationError}) {
 const queue=createDirtyQueue(db,{name:'announcement_handoff',table:'announcements',version:'v1'});
 // An imported/corrected source job can change after its announcement completed.
 for(const action of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_job_${action} AFTER ${action}${action==='UPDATE'?' OF body':''} ON jobs WHEN ${action==='UPDATE'?'NEW.body IS NOT OLD.body AND ':''}json_extract(NEW.body,'$.announcementId') IS NOT NULL BEGIN ${queue.enqueueSql("json_extract(NEW.body,'$.announcementId')")}; END`);
 const operations={
  reconcilePendingAnnouncements({sourceIds}={}) {
   const where=sourceIds?" AND (json_extract(a.body,'$.sourceIdentityContext.sourceId') IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(a.body,'$.jobIdentities') i WHERE json_extract(i.value,'$.sourceIdentity.sourceId') IN (SELECT value FROM json_each(?))))":'';
   const rows=db.prepare(`SELECT q.id,q.token FROM ${queue.table} q JOIN announcements a ON a.id=q.id WHERE 1=1${where} ORDER BY q.rowid`).all(...(sourceIds?[JSON.stringify(sourceIds),JSON.stringify(sourceIds)]:[]));
   return rows.map(item=>{const result=application.reconcileAnnouncementJobs(item.id);queue.acknowledge(item);return result;});
  },
  reconcileAnnouncementJobs(id) {
   const a=application.getAnnouncement(id);if(!a)throw new ValidationError('公告不存在');
   if(!['processed','partial'].includes(a.status))return {id,status:'not_processed',jobs:[]};
   const results=[];
   for(const jobId of a.jobIds){
    let job=application.getSourceJob(jobId);
    if(!job||job.announcementId!==id)continue;
    const native=a.jobIds.length===1&&job.title===a.title?officialRoleIdentity(a.sourceIdentityContext):null;
    if(native&&!job.sourceIdentities?.some(x=>x.sourceId===native.sourceId&&x.externalId===native.externalId)){
     job=application.importJob({...job,sourceIdentity:native,observedAt:a.sourceIdentityContext.observedAt,associationEvidence:{jobId:job.id,kind:'official_link',url:a.sourceUrl,quote:job.title}}).job;
    }
    const identity=a.jobIdentities?.find(x=>job.sourceIdentities?.some(y=>y.sourceId===x.sourceIdentity.sourceId&&y.externalId===x.sourceIdentity.externalId));
    const source=identity?.sourceIdentity??native,stored=identity?.sourceEvidence??job.sourceEvidence;
    if(!source){results.push({jobId,status:'identity_pending'});continue;}
    const latest=a.processingObservation;
    if(latest?.recruitmentUnitEvidence)application.recordJobRecruitmentUnitEvidence(jobId,{...source,evidence:latest.recruitmentUnitEvidence});
    const observedAt=latest?.checkedAt??stored?.checkedAt??identity?.observedAt??a.sourceIdentityContext?.observedAt;
    const applicationOpen=latest?latest.applicationOpen:stored?.applicationOpen;
    // This heading is part of the verified single-role page, not an article's
    // publication date or an invented lifetime for an evergreen listing.
    const deadlineLine=native&&a.originalText.match(/^(?:报名截止时间|截止时间)\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/m);
    const deadline=deadlineLine?{raw:deadlineLine[1],evidence:{url:a.sourceUrl,text:a.originalText,quote:deadlineLine[0],locator:'官方单岗详情截止时间'}}:undefined;
    if(typeof applicationOpen!=='boolean'||!observedAt){results.push({jobId,status:'open_pending'});continue;}
    const input={...source,observedAt,acquisition:'success',listComplete:false,listed:true,detailAccessible:true,applicationOpen,evidence:{url:a.sourceUrl,text:a.originalText,quote:job.title},...(deadline?{deadline}:{})};
    input.id='handoff:'+id+':'+jobId+':'+createHash('sha256').update(JSON.stringify(input)).digest('hex');
    application.recordRecruitmentObservation(jobId,input);
    results.push({jobId,status:application.getRecruitmentState(jobId).status});
   }
   return {id,status:results.some(x=>/_pending$/.test(x.status))?'pending':'completed',jobs:results};
  },
 };
 const reconcile=operations.reconcileAnnouncementJobs;
 operations.reconcileAnnouncementJobs=id=>{const item=queue.get(id);const result=reconcile(id);queue.acknowledge(item);return result;};
 return operations;
}
