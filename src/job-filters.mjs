const titleOrder=new Intl.Collator('zh-CN');
import {jobDisplay,recommendationLabels} from './job-display.mjs';
export const responsibilityLevels = {expert:'专家路线',leader:'负责人／管理',dual:'专家与负责人双路线',unknown:'未判断'};
export const qualificationFilters = {verified:'符合已核验条件',ineligible:'明确不符合',pending:'关键条件待核验',unassessed:'尚未核验',needs_review:'证据变化需重新核验'};
export const recruitmentFilters = {publicly_listed_open:'当前公开列示开放',suspected_offline:'疑似下线',ended:'明确结束',unverified:'待核验',long_posted:'长期挂网',long_term_unverified:'长期待确认'};
export function responsibilityLevel(job,matching=job.matching) {
  if(matching?.status==='completed'&&!matching.stale&&!matching.profileStale&&matching.output?.route!=='uncertain')return {expert:'expert',leader:'leader',both:'dual'}[matching.output.route]??'unknown';
  // Without a current explanation, keep the route unknown; titles and negative duties cannot prove rank.
  return 'unknown';
}
export const qualificationStatus=result=>result?.stale?'needs_review':result?.status??'unassessed';
export function filterJobs(jobs,filters,{getEligibility,getMatch,getPersonalState,ValidationError}) {
  if(!filters||typeof filters!=='object'||Array.isArray(filters))throw new ValidationError('岗位筛选须为对象');
  for(const [field,value] of Object.entries(filters))if(!['unit','direction','level','eligibility','status','location','recommendation','startFrom','deadlineBefore','sort'].includes(field)||typeof value!=='string'||value.length>200)throw new ValidationError('岗位筛选字段无效');
  for(const [field,choices] of [['level',responsibilityLevels],['eligibility',qualificationFilters],['status',{...recruitmentFilters,open:'在招',limited:'限时招聘',not_started:'未开始'}],['recommendation',recommendationLabels],['sort',{recommendation:'推荐',deadline:'截止'}]])if(filters[field]&&!Object.hasOwn(choices,filters[field]))throw new ValidationError('岗位筛选值无效');
  for (const field of ['startFrom','deadlineBefore']) if (filters[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(filters[field]) || !Number.isFinite(Date.parse(filters[field])) || new Date(filters[field]).toISOString().slice(0,10)!==filters[field])) throw new ValidationError('日期筛选需有效YYYY-MM-DD');
  const displays=new Map();
  const display = job => {if(!displays.has(job.id))displays.set(job.id,jobDisplay({...job,eligibility:getEligibility(job.id),matching:getMatch(job.id),personal:getPersonalState?.(job.id)}));return displays.get(job.id);};
  const includes=(text,query)=>!query||String(text??'').toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const selected = jobs.filter(job=>(!filters.unit||includes(display(job).unit.label,filters.unit))&&(!filters.location||includes(display(job).location,filters.location.replace(/市$/,'')))&&(!filters.recommendation||display(job).recommendation.level===filters.recommendation)&&(!filters.startFrom||display(job).registration.start && display(job).registration.startLabel.slice(0,10)>=filters.startFrom)&&(!filters.deadlineBefore||display(job).registration.deadline && display(job).registration.deadlineLabel.slice(0,10)<=filters.deadlineBefore)&&includes([job.title,job.duties,...(job.conditions??[]).map(x=>x.text),...(job.knownConditions??[])].filter(Boolean).join('\n'),filters.direction)&&(!filters.level||responsibilityLevel(job,getMatch(job.id))===filters.level)&&(!filters.eligibility||qualificationStatus(getEligibility(job.id))===filters.eligibility||filters.eligibility==='pending'&&display(job).eligibility.status==='pending')&&(!filters.status||(filters.status.startsWith('long_')?job.recruitment.longevity.label===filters.status:job.recruitmentStatus===filters.status||display(job).recruitment.status===filters.status)));
  return filters.sort ? sortJobs(selected,filters.sort,display) : selected;
}

export function sortJobs(jobs, sort = 'recommendation', getDisplay = job => job.display ?? jobDisplay(job)) {
  const ranks = {priority:0,consider:1,uncertain:2,avoid:3,excluded:4};
  const dateKey = job => getDisplay(job).registration.deadline?.value ?? '9999';
  return [...jobs].sort((a,b) => {
    const ad=getDisplay(a),bd=getDisplay(b);
    const blocked=Number(ad.eligibility.status==='ineligible')-Number(bd.eligibility.status==='ineligible');
    if(blocked)return blocked;
    if(sort==='deadline')return dateKey(a).localeCompare(dateKey(b)) || ranks[ad.recommendation.level]-ranks[bd.recommendation.level];
    return ranks[ad.recommendation.level]-ranks[bd.recommendation.level] || dateKey(a).localeCompare(dateKey(b)) || titleOrder.compare(a.title,b.title);
  });
}
