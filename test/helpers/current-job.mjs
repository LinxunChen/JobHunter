import {randomUUID} from 'node:crypto';
// Explicit current Beijing evidence for tests whose subject is model scheduling.
// Unknown/open/location gates are tested separately with their missing fields.
export function currentJob(app,input,at='2026-10-08T01:00:00Z') {
 const externalId=randomUUID().replaceAll('-','').slice(0,24);
 const job=app.importJob({...input,location:{options:['北京'],confirmed:null,note:null},sourceIdentity:{sourceId:'efunds-social',externalId},observedAt:at,sourceEvidence:{listed:true,checkedAt:at},recruitmentStatus:'publicly_listed_open'}).job;
 app.recordRecruitmentObservation(job.id,{sourceId:'efunds-social',externalId,observedAt:at,acquisition:'success',listComplete:true,listed:true,detailAccessible:true,applicationOpen:true,evidence:{url:'https://example.invalid/synthetic-job',text:'模拟北京当前开放',quote:'模拟北京当前开放'}});
 return job;
}
