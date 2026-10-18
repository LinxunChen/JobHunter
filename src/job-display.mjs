import { prioritizedPendingChecks } from './qualification-summary.mjs';
import { jobRelevance, targetLocation,recruitmentFit } from './job-relevance.mjs';
const recommendationLabels = { priority: '优先考虑', consider: '可以考虑', avoid: '不推荐', uncertain: '不确定', excluded: '个人排除' };
const dimensionLabels = { high: '高', medium: '中', low: '低', unknown: '不确定' };
const routeLabels = { expert: '专家', leader: '负责人／管理', both: '双路线', uncertain: '不确定' };
export { recommendationLabels };

export function formatOfficialDate(fact) {
  if (!fact?.value || Number(fact.value.slice(0,4)) >= 2500) return '未披露';
  if (fact.precision === 'day') return fact.value;
  if (fact.precision === 'local_minute') return `${fact.value.slice(0,10)} ${fact.value.slice(11,13)}时（时区未披露）`;
  if (!Number.isFinite(Date.parse(fact.value))) return '未披露';
  const local = new Date(Date.parse(fact.value) + 8 * 3600000).toISOString();
  return `${local.slice(0,10)} ${local.slice(11,13)}时`;
}

export function jobDisplay(job) {
  const match = job.matching, qualification = job.eligibility, state = job.recruitment, dates = state?.dates ?? {};
  const current = match?.status === 'completed' && !match.stale && !match.profileStale;
  const validNew = current && !!match.output?.recommendation;
  const relevance = jobRelevance(job);
  const locationFit=targetLocation(job);
  let recommendation = validNew ? { ...match.output.recommendation, label: recommendationLabels[match.output.recommendation.level], needsUpdate: false } : { level: 'uncertain', label: '不确定', reason: current ? '匹配结论待更新' : '匹配依据待核验', needsUpdate: true };
  const blocked = qualification?.status === 'ineligible' && !qualification.stale;
  const check = qualification?.checks?.find(item => item.status === 'ineligible');
  const shortFailure = check?.facts?.requiredEducation ? `要求${check.facts.requiredEducation}` : /派遣|外包/.test(check?.reason ?? '') ? '外包／派遣' : /年龄|出生|生日/.test(check?.reason ?? '') ? '年龄不匹配' : check?.reason?.slice(0,28) ?? '资格不匹配';
  if (blocked) recommendation = { level: 'avoid', label: '不推荐', reason: shortFailure, needsUpdate: false };
  if (!blocked && !current && relevance.status === 'out_of_scope') recommendation = {level:'avoid',label:'不推荐',reason:relevance.reason,needsUpdate:false};
  if(!blocked&&locationFit.status==='excluded')recommendation={level:'avoid',label:'不推荐',reason:locationFit.reason,needsUpdate:false};
  if(recruitmentFit(job).status==='out_of_scope')recommendation={level:'avoid',label:'不推荐',reason:'不属于所选招聘类型',needsUpdate:false};
  if (job.personal?.notInterested) recommendation = {level:'excluded',label:'个人排除',reason:'本人已排除当前岗位，可取消排除',needsUpdate:false};
  const exclusionReason = job.personal?.notInterested ? '个人排除' : blocked ? `资格不符：${shortFailure}` : recommendation.level === 'avoid' ? `不推荐：${recommendation.reason}` : null;
  const pendingCheck = prioritizedPendingChecks(qualification?.checks ?? [])[0];
  const pendingReason = pendingCheck?.facts?.requiredEducation ? '学历未确认' : /专业/.test(pendingCheck?.originalCondition ?? '') ? '专业未确认' : pendingCheck?.facts?.requiredCertificate ? '证书未确认' : pendingCheck?.facts?.requiredMonths ? '相关经历年月未确认' : pendingCheck?.facts?.maxAge ? '生日未确认' : pendingCheck?.gaps?.[0]?.slice(0,22) ?? (qualification?.checks?.length ? '声明或条件待确认' : '资格条件未取得');
  const eligibility = { status: qualification?.stale ? 'pending' : qualification?.status ?? 'pending', label: blocked ? '不满足' : qualification?.status === 'verified' && !qualification.stale ? '满足' : '不确定', reason: blocked ? shortFailure : qualification?.stale ? '资料或证据需更新' : qualification?.status === 'verified' ? '' : pendingReason };
  const dimensions = ['business','technical','scope'].map(key => ({ key, label: {business:'业务',technical:'专业',scope:'职责层级'}[key], level: current ? match.output[key].level : 'unknown', levelLabel: current ? dimensionLabels[match.output[key].level] : '不确定', shortReason: current ? match.output[key].shortReason ?? '短理由待更新' : '依据待核验' }));
  const route = current ? { key: match.output.route, label: routeLabels[match.output.route], evidence: match.output.routeEvidence ?? match.output.scope.jobQuotes } : { key: 'uncertain', label: '不确定', evidence: [] };
  const status = state?.status ?? job.recruitmentStatus;
  const start = dates.officialStart, deadline = dates.officialDeadline;
  const checkedAt = state?.checkedAt;
  const notStarted = start && checkedAt && (start.precision === 'instant' ? Date.parse(start.value) > Date.parse(checkedAt) : start.precision === 'day' ? start.value > new Date(Date.parse(checkedAt)+8*3600000).toISOString().slice(0,10) : false);
  const statusKey = status === 'publicly_listed_open' ? notStarted ? 'not_started' : deadline && !dates.deadlinePassed ? 'limited' : 'open' : status === 'ended' ? 'ended' : status === 'suspected_offline' ? 'suspected_offline' : 'unverified';
  const recruitment = { status: statusKey, label: {not_started:'未开始',limited:'限时招聘',open:'在招',ended:'已结束',suspected_offline:'疑似下线',unverified:'待确认'}[statusKey], longevityLabel: state?.longevity?.label ? '长期挂网' : null };
  const urgent = status === 'publicly_listed_open' && !notStarted && !dates.deadlinePassed && !dates.deadlineConflict && dates.remainingDays !== null && dates.remainingDays >= 0 && dates.remainingDays <= 7 && deadline?.precision !== 'local_minute';
  const platform = job.originalText?.match(/^平台所属机构（不替代岗位招聘单位）：([^\r\n]+)$/m)?.[1]?.trim();
  const knownPlatform = platform && !['未披露','未知'].includes(platform) ? platform : null;
  const unit = job.recruitmentUnit ? {label:job.recruitmentUnit,kind:'recruitment',reason:'原文明确的招聘单位'} : knownPlatform ? {label:knownPlatform+'（主体待核验）',kind:'platform',reason:'原文明确平台所属机构，岗位具体招聘主体未披露'} : {label:'未披露',kind:'unknown',reason:'招聘单位未披露'};
  const application = job.applicationPath;
  const corrected=job.manualCorrections?.some(item=>item.field==='applicationPath'&&!item.superseded&&!item.needsReview);
  const observedUrl=corrected?null:state?.applicationUrl;
  const applicationHref = application?.kind === 'email' ? `mailto:${application.email}` : application?.url;
  const href = observedUrl ?? applicationHref ?? job.sourceUrl ?? null;
  const sourceFallback = !observedUrl && !applicationHref && !!href;
  const location = [...new Set((job.location?.options ?? (job.location?.confirmed ? [job.location.confirmed] : [])).flatMap(item => item.split(/[、,，/]/)).map(item => { const parts=item.trim().split(/[-－—]/).map(part=>part.trim()).filter(part=>part&&!['中国','中华人民共和国'].includes(part)); return (parts.find(part=>/市$/.test(part)) ?? parts.find(part=>!/省$/.test(part)) ?? parts[0] ?? '').replace(/市$/, ''); }).filter(Boolean))].join('、') || '未披露';
  const reviewReason = status === 'unverified' ? (current ? '匹配已完成；招聘是否仍在招待核验' : '招聘是否仍在招待核验') : notStarted ? '尚未到报名开始时间' : dates.deadlinePassed ? '报名期限已过，等待招聘状态复核' : !current ? (match?.stale || match?.profileStale ? '岗位或个人资料变化，匹配待更新' : match?.status === 'failed' ? '匹配执行失败，待恢复' : '尚未完成匹配') : recommendation.level === 'uncertain' ? '匹配已完成；职业匹配证据不足' : null;
  return { pendingReason: reviewReason, unit, recommendation, dimensions, route, eligibility, recruitment, relevance, locationFit, registration: {start,deadline,startLabel:formatOfficialDate(start),deadlineLabel:formatOfficialDate(deadline),urgent,remainingDays:dates.remainingDays ?? null}, application: {href,sourceFallback,label:sourceFallback?'官方原文':href?{direct:'岗位直达',steps:'申请入口及步骤',email:'招聘邮箱',announcement:'公告规定流程'}[observedUrl?'direct':application?.kind]??'官方入口':'入口未披露',needsSteps:!observedUrl&&application?.kind !== 'direct',steps:observedUrl?'':application?.steps ?? '',loginRequired:observedUrl?true:application?.loginRequired ?? false}, location, exclusionReason, group: exclusionReason || ['ended','suspected_offline'].includes(status) || job.evidenceUse === 'historical' ? 'history' : current && status==='publicly_listed_open' && !dates.deadlinePassed && !notStarted && ['priority','consider'].includes(recommendation.level) ? 'active' : 'pending' };
}
