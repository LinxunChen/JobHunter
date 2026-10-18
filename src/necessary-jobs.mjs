// Shared bounded qualification and matching work for scheduled and manual checks.
import {jobRelevance,targetLocation} from './job-relevance.mjs';
export function pendingAutomaticMatches(application,{sourceIds}={}) {
 return application.listJobs().filter(job=>job.evidenceUse!=='historical'&&application.isJobMonitoringEnabled(job.id)&&(!sourceIds||job.sourceIdentities?.some(x=>sourceIds.includes(x.sourceId)))).filter(job=>{
  const qualification=application.getEligibility(job.id),state=job.recruitment??application.getRecruitmentState(job.id,{includeHistory:false}),match=application.getMatch(job.id);
  return jobRelevance(job).status==='relevant'&&targetLocation(job).status==='included'&&state.status==='publicly_listed_open'&&!state.dates.deadlinePassed&&!(qualification?.status==='ineligible'&&!qualification.stale)&&!application.getPersonalState(job.id)?.notInterested&&(!match||match.status!=='completed'||match.stale||match.profileStale||!match.output?.recommendation);
 });
}
export async function updateNecessaryJobs(application,{sourceIds}={}) {
  await application.runPendingProfileAnalyses();
  application.reconcilePendingAnnouncements({sourceIds});
  const metadata = application.listCareerProfiles()[0];
  if (!metadata) {
    for(const job of application.listJobs().filter(x=>x.evidenceUse!=='historical'&&application.isJobMonitoringEnabled(x.id)&&(!sourceIds||x.sourceIdentities?.some(identity=>sourceIds.includes(identity.sourceId))))) {
      const qualification=application.getEligibility(job.id);
      if(application.getQualificationProfile()&&(!qualification||qualification.stale||qualification.profileSource?.kind!=='qualification'))application.evaluateEligibility(job.id);
    }
    return { status:'pending',considered:0,gaps:['尚无完整职业资料，匹配待核验'] };
  }
  const profile = application.getCareerProfile(metadata.id), results = [], skipped = [];
  for (const job of application.listJobs().filter(x => x.evidenceUse !== 'historical' && application.isJobMonitoringEnabled(x.id) && (!sourceIds || x.sourceIdentities?.some(identity=>sourceIds.includes(identity.sourceId))))) {
    const relevance=jobRelevance(job);
    const qualification = application.getEligibility(job.id);
    const independentFacts = qualification?.profileSource?.kind === 'manual' && Object.keys(qualification.profileSnapshot).some(key => !['version','source'].includes(key));
    if (application.getQualificationProfile() && (!qualification || qualification.stale || qualification.profileSource?.kind !== 'qualification')) application.evaluateEligibility(job.id);
    else if (!application.getQualificationProfile() && (!qualification || qualification.stale || (!independentFacts && profile.qualificationFacts && qualification.profileVersion !== profile.version))) {
      if (independentFacts || (qualification && !profile.qualificationFacts)) application.evaluateEligibility(job.id, {profile:qualification.profileSnapshot,careerProfileId:qualification.profileSource?.kind === 'career' ? qualification.profileSource.careerProfileId : undefined});
      else application.evaluateEligibility(job.id, {profile:{...(profile.qualificationFacts ?? {}),version:profile.version},...(profile.qualificationFacts ? {careerProfileId:profile.id} : {})});
    }
    const currentQualification=application.getEligibility(job.id), recruitment=application.getRecruitmentState(job.id);
    if(relevance.status!=='relevant'){skipped.push({jobId:job.id,reason:relevance.reason});continue;}
    if(targetLocation(job).status!=='included'){skipped.push({jobId:job.id,reason:targetLocation(job).reason});continue;}
    if(recruitment.status!=='publicly_listed_open'||recruitment.dates.deadlinePassed){skipped.push({jobId:job.id,reason:'当前报名开放尚未确认，不自动匹配'});continue;}
    if(currentQualification?.status==='ineligible'&&!currentQualification.stale||['ended','suspected_offline'].includes(recruitment.status)||application.getPersonalState(job.id)?.notInterested){skipped.push({jobId:job.id,reason:'当前资格、招聘状态或个人排除不支持自动匹配'});continue;}
    const match = application.getMatch(job.id);
    if (!match || match.stale || match.profileStale || match.status==='completed'&&!match.output?.recommendation || ['failed','deferred'].includes(match.status)) {
      if (results.length >= 20) continue;
      try { const result = await application.matchJob(job.id, { profileId: profile.id }); results.push({ jobId: job.id, matchId: result.id, status: result.status }); }
      catch { results.push({ jobId: job.id, status: 'deferred' }); }
    }
  }
  const pendingJobIds=application.listJobs().filter(x=>x.evidenceUse!=='historical' && application.isJobMonitoringEnabled(x.id) && !skipped.some(item=>item.jobId===x.id) && (!sourceIds || x.sourceIdentities?.some(identity=>sourceIds.includes(identity.sourceId)))).filter(job=>{const match=application.getMatch(job.id);return !match||match.status!=='completed'||match.stale||match.profileStale||!match.output?.recommendation;}).map(x=>x.id);
  return { status: pendingJobIds.length ? 'partial' : 'completed', considered: results.length, pendingJobIds, results, skipped, limit: 20 };
}
