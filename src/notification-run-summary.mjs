import {beijingDay} from './beijing-time.mjs';

// A daily funnel counts each source once, using its latest completed check today.
// Source listings and recommendation cards are separate from formal job intake.
export function notificationRunSummary({at,sources,jobs,completedChecks}) {
 const date=beijingDay(at),inToday=value=>Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.parse(at)&&beijingDay(value)===date;
 const completedAt=check=>check.finishedAt??check.checkedAt;
 const checks=sources.filter(source=>source.implemented).flatMap(source=>{
  const check=(completedChecks?completedChecks.filter(check=>check.sourceId===source.id):source.history??[]).filter(check=>['success','partial','failed'].includes(check.status)&&inToday(completedAt(check))).sort((a,b)=>Date.parse(completedAt(b))-Date.parse(completedAt(a)))[0];
  return check?[{sourceId:source.id,checkId:check.id,status:check.status,completedAt:completedAt(check)}]:[];
 });
 const newJobIds=[...new Set(jobs.filter(job=>job.evidenceUse!=='historical'&&inToday(job.firstDiscoveredAt)).map(job=>job.id))];
 return {date,at,scope:'beijing_day',checks,newJobIds,counts:{checkedSources:checks.length,parsedSources:checks.filter(check=>check.status==='success').length,partialSources:checks.filter(check=>check.status==='partial').length,failedSources:checks.filter(check=>check.status==='failed').length,newJobs:newJobIds.length}};
}
