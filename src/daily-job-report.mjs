import {beijingDay} from './beijing-time.mjs';
import {summarizeSourceIssues} from './source-failure.mjs';
const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const localTime=value=>value?new Date(Date.parse(value)+28800000).toISOString().slice(0,16).replace('T',' '):'暂无记录';
const eventLabel=event=>({watched_change:'关注岗位有变化',deadline_changed:'截止时间变化',deadline_node:'临期提醒'}[event.type]);
const deadlineOrder=(a,b)=>(a.job.display.registration.deadline?.value??'9999').localeCompare(b.job.display.registration.deadline?.value??'9999')||a.job.title.localeCompare(b.job.title,'zh');

// Each job is placed once: followed, closing, then new/changed opportunities.
export function dailyReportContent({at,jobs,opportunities,firstConsidered,events,lastReportAt,monitoringEnabled,sourceIssues,runSummary,operations}) {
 const date=beijingDay(at),candidateIds=new Set(opportunities.map(item=>item.jobId));
 // Today's handoff changes ledger ownership, not the validity of the jobs.
 // Keep carried opportunities visible during pre-dispatch checks and retries.
 const pending=events.filter(event=>event.status==='pending'||event.status==='held_for_delivery'&&event.heldAt&&beijingDay(event.heldAt)===date),sections={followed:[],closing:[],newConsiderable:[]};
 const entries=jobs.filter(job=>monitoringEnabled(job.id)&&!job.personal.notInterested&&!job.personal.remindersPaused&&job.evidenceUse!=='historical').map(job=>{
  const display=job.display,jobEvents=events.filter(event=>event.jobId===job.id&&event.type!=='opportunity'&&(event.status==='pending'||event.status==='held_for_delivery'&&event.heldAt&&beijingDay(event.heldAt)===date));
  const firstAt=firstConsidered.get(job.id)??(candidateIds.has(job.id)?job.matching?.recordedAt??at:null);
  const isNew=candidateIds.has(job.id)&&firstAt&&Date.parse(firstAt)<=Date.parse(at)&&beijingDay(firstAt)===date;
  const waiting=pending.find(event=>event.jobId===job.id&&event.type==='opportunity'&&beijingDay(event.createdAt)<date);
  const carryLabel=!isNew&&candidateIds.has(job.id)&&waiting?(lastReportAt&&waiting.createdAt>lastReportAt?'上次日报后新增':'此前待看机会'):null;
  const days=display.registration.remainingDays,fact=display.registration.deadline;
  const closing=Boolean(candidateIds.has(job.id)&&display.group==='active'&&!job.personal.applied&&fact&&['day','instant'].includes(fact.precision)&&!job.recruitment.dates.deadlineConflict&&!job.recruitment.dates.deadlinePassed&&days!==null&&days>=0&&days<=30);
  const closed=['ended','suspected_offline'].includes(job.recruitment.status);
  const followed=job.personal.followed&&(!closed||jobEvents.some(event=>event.type==='watched_change'));
  const newLabel=isNew?(beijingDay(job.firstDiscoveredAt)===date?'今日新增':'今日转为可考虑'):null;
  const labels=[...(followed?['已关注']:[]),...(closing?['30天内截止']:[]),...(newLabel?[newLabel]:[]),...(carryLabel?[carryLabel]:[]),...(closing&&days<=7&&job.matching?.qualificationAllowsAction?['临期提醒']:[]),...jobEvents.map(eventLabel)].filter(Boolean);
  const progress={none:'未投递',preparing:'准备投递',applied:'已投递',interview:'面试中',ended:'申请结束'}[job.personal.applicationProgress]??'未投递';
  const qualification=display.eligibility.status==='pending'?`资格待核验 · ${display.eligibility.reason}`:`资格：${display.eligibility.label}${display.eligibility.reason?'（'+display.eligibility.reason+'）':''}`;
  const deadline=fact?`截止：${display.registration.deadlineLabel}${closing?' · '+(days===0?'今日截止':days<=3?'3天内截止 · 剩余'+days+'天':days<=7?'7天内截止 · 剩余'+days+'天':'剩余'+days+'天'):''}${fact.precision==='day'?' · 具体时刻未披露':''}`:'截止：未披露';
  return {job,jobId:job.id,followed,closing,isNew,carryForward:Boolean(carryLabel),labels:[...new Set(labels)],progress,qualification,deadline,recommendation:display.recommendation.label+' · '+display.recommendation.reason,applicationHref:display.application.href,applicationSteps:display.application.steps,recruitmentStatus:display.recruitment.status,detailed:false};
 });
 const followed=entries.filter(item=>item.followed).sort(deadlineOrder),closing=entries.filter(item=>item.closing).sort(deadlineOrder),newEntries=entries.filter(item=>item.isNew);
 const used=new Set(followed.map(item=>item.jobId));sections.followed=followed;
 sections.closing=closing.filter(item=>!used.has(item.jobId));sections.closing.forEach(item=>used.add(item.jobId));
 const remainder=entries.filter(item=>!used.has(item.jobId)&&(item.isNew||item.carryForward||item.labels.some(label=>['关注岗位有变化','截止时间变化','临期提醒'].includes(label)))).sort((a,b)=>Number(!a.labels.includes('临期提醒'))-Number(!b.labels.includes('临期提醒'))||Number(!a.labels.includes('关注岗位有变化'))-Number(!b.labels.includes('关注岗位有变化'))||Number(b.job.display.recommendation.level==='priority')-Number(a.job.display.recommendation.level==='priority')||deadlineOrder(a,b));
 sections.newConsiderable=remainder.map((item,index)=>({...item,detailed:index<5}));
 const counts={followed:followed.length,closing:closing.length,newConsiderable:newEntries.length,uniqueJobs:used.size+remainder.length};
 const sourceSummary=summarizeSourceIssues(sourceIssues),checks=runSummary.counts;
 const targetSources=operations.sources.filter(source=>source.implemented&&source.monitoring?.enabled!==false).length;
 const unchecked=Math.max(0,targetSources-runSummary.checks.filter(check=>operations.sources.some(source=>source.id===check.sourceId&&source.monitoring?.enabled!==false)).length);
 const failures=operations.exceptionSummary.actualFailures,queue=operations.processingQueue;
 const incomplete=checks.failedSources||checks.partialSources||unchecked||failures||queue.matchingPending.length||queue.deferred||queue.needsMaterial;
 const status=!checks.checkedSources?'尚无今日检查记录':incomplete?'今日信息未完整更新':'今日检查已完成';
 const recent=[...runSummary.checks.map(check=>check.completedAt),...operations.sources.map(source=>source.latest?.checkedAt)].filter(value=>value&&Date.parse(value)<=Date.parse(at)).sort().at(-1);
 const systemLines=[status,`今日检查${checks.checkedSources}个源 · 完整解析${checks.parsedSources}个源 · 新增入库${checks.newJobs}个岗位`,...(checks.partialSources||checks.failedSources?[`部分完成${checks.partialSources}个源 · 失败${checks.failedSources}个源`]:[]),...(unchecked?[`${unchecked}个启用来源尚无今日完成记录`]:[]),...(operations.institutions.counts.pending?[`${operations.institutions.counts.pending}个目标机构待接入`]:[]),...(queue.matchingPending.length||queue.deferred||queue.needsMaterial?[`待匹配${queue.matchingPending.length}个岗位 · 延后处理${queue.deferred}项 · 待补材料${queue.needsMaterial}项`]:[]),...(failures?[`当前异常${failures}项`,...operations.exceptionGroups.filter(group=>group.code!=='model_deferred').map(group=>group.label+'：'+group.count+'项')]:[]),`最近检查：${localTime(recent)}`,...sourceSummary.map(group=>group.text)];
 const titles={followed:'我的关注',closing:'未来30天截止',newConsiderable:'今日新增可考虑'};
 const empty={followed:'暂无需要展示的关注岗位',closing:counts.closing?'相关岗位已合并在我的关注':'暂无未来30天截止岗位',newConsiderable:counts.newConsiderable?'今日新机会已合并在上方清单':'今日无新增可考虑岗位'};
 const summary=`关注${counts.followed}个 · 30天内截止${counts.closing}个 · 今日新增可考虑${counts.newConsiderable}个`;
 const title=`[JobHunter]求职日报 · ${date}`;
 const plainItem=item=>{const d=item.job.display;return [`${item.job.title}｜${d.unit.label}`,item.labels.join(' · '),`${item.progress} · ${d.recruitment.label}`,item.deadline,item.qualification,...(item.detailed?[`推荐：${d.recommendation.label} · ${d.recommendation.reason}`,...d.dimensions.map(x=>`${x.label}：${x.levelLabel} · ${x.shortReason}`)]:[]),d.application.href?`${d.application.sourceFallback?'官方原文':'投递入口'}：${d.application.href}`:'投递入口待补充',...(d.application.needsSteps&&d.application.steps?[`申请步骤：${d.application.steps}`]:[])].filter(Boolean).join('\n');};
 const renderItem=item=>{
  const d=item.job.display,urgent=item.closing&&d.registration.remainingDays<=7&&!item.job.personal.applied;
  const link=d.application.href?`<a href="${html(d.application.href)}" style="color:#285a82;text-decoration:none;font-size:12px">${html(d.application.label)} →</a>`:'<span style="color:#8a929c;font-size:12px">投递入口待补充</span>';
  return `<article data-notification-job="${html(item.jobId)}" ${item.detailed?'data-notification-card="true"':''} style="${item.detailed?'border:1px solid #e2e8ee;border-radius:12px;padding:14px;':'border-bottom:1px solid #edf0f3;padding:12px 0;'}margin-bottom:8px"><div style="font-size:10px;color:${urgent?'#bb493b':'#547087'};margin-bottom:5px">${html(item.labels.join(' · '))}</div><div style="font-size:14px;font-weight:600;color:#1d2d3c">${html(item.job.title)}</div><div style="font-size:12px;color:#7a8793;margin:3px 0 7px">${html(d.unit.label)} · ${html(d.location)}</div><div style="font-size:12px;color:${urgent?'#bb493b':'#42576a'};${urgent?'font-weight:700;':''}">${html(item.deadline)}</div><div style="font-size:11px;color:#738292;margin-top:4px">${html(item.progress)} · ${html(d.recruitment.label)} · ${html(item.qualification)}</div>${item.detailed?`<div style="font-size:12px;font-weight:500;color:#285a82;margin:10px 0 5px">${html(d.recommendation.label)} <span style="font-size:12px;font-weight:400;color:#526576">· ${html(d.recommendation.reason)}</span></div>${d.dimensions.map(x=>`<div style="font-size:11px;color:#7a8793;margin:3px 0">${html(x.label)} ${html(x.levelLabel)} · ${html(x.shortReason)}</div>`).join('')}`:''}<div style="margin-top:9px">${link}</div>${d.application.needsSteps&&d.application.steps?`<div style="font-size:11px;color:#738292;margin-top:5px">${html(d.application.steps)}</div>`:''}</article>`;
 };
 const content=[title,summary,...Object.entries(sections).flatMap(([key,items])=>[titles[key],...(items.length?items.map(plainItem):[empty[key]])]),'系统运行状态',...systemLines].join('\n\n');
 const htmlContent=`<div style="box-sizing:border-box;max-width:520px;margin:0 auto;padding:20px 18px;background:#fff;font:14px/1.55 -apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#283c50"><header style="border-bottom:2px solid #294c65;padding-bottom:15px;margin-bottom:20px"><div style="font-size:10px;letter-spacing:2px;color:#81909e">JOBHUNTER · ${html(date)}</div><h1 style="font-size:23px;margin:5px 0 12px;color:#20394d">求职日报</h1><div style="font-size:12px;background:#f2f6f8;border-radius:8px;padding:11px;color:#526a7e">${html(summary)}</div></header>${Object.entries(sections).map(([key,items],index)=>`<section data-notification-section="${key}" style="margin-bottom:24px"><h2 style="font-size:16px;font-weight:600;color:#20394d;margin:0 0 10px"><span style="font-size:11px;color:#96a3ae;margin-right:7px">0${index+1}</span>${titles[key]}</h2>${items.length?items.map(renderItem).join(''):`<p style="font-size:12px;color:#8a96a2;margin:0">${html(empty[key])}</p>`}</section>`).join('')}<section data-notification-section="system" style="border-top:1px solid #e2e8ee;padding-top:15px"><h2 style="font-size:16px;font-weight:600;color:#20394d;margin:0 0 10px"><span style="font-size:11px;color:#96a3ae;margin-right:7px">04</span>系统运行状态</h2><div style="background:#f5f7f9;border-radius:10px;padding:12px">${systemLines.map((line,index)=>`<div style="font-size:${index===0?13:11}px;${index===0?'font-weight:600;':''}color:${index===0&&incomplete?'#a96528':'#66798a'};margin-bottom:5px">${html(line)}</div>`).join('')}</div></section></div>`;
 // Persist only the projection needed for preview/readback; raw jobs stay in the job store.
 const report={date,counts,sections:Object.fromEntries(Object.entries(sections).map(([key,items])=>[key,items.map(({job,...item})=>item)])),system:{status,lines:systemLines,uncheckedSources:unchecked,lastCheckedAt:recent??null}};
 return {title,content,htmlContent,template:'html',report,runSummary,sourceIssues,sourceSummary};
}
