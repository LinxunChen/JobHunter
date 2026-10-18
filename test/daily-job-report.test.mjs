import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';

const quote='负责推荐排序研发与业务系统设计';
const dimension={level:'high',shortReason:'推荐排序研发经历直接相关',explanation:'匹配直接职责',directExperiences:[{profileQuote:quote,jobQuote:quote,explanation:'直接研发经历'}],transferableAbilities:[],gaps:[],jobQuotes:[quote]};
function setup(t,notificationTransport=null){
 let at='2026-10-14T01:00:00Z';
 const app=createApplication({databasePath:':memory:',notificationTransport,now:()=>new Date(at),matchingProcessor:{match:async()=>({technical:dimension,business:dimension,scope:dimension,route:'expert',routeExplanation:'研发专家',routeEvidence:[quote],recommendation:{level:'priority',reason:'推荐研发经历匹配'},uncertainties:[]})}});t.after(()=>app.close());
 app.saveCareerProfile({sourceId:'manual',version:'v1',text:quote});app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟',quote:'硕士'}}});
 return {app,setTime(value){at=value;},async seed(title,{deadline,followed=false,pending=false,observedAt=at}={}){
  const url='https://example.invalid/'+encodeURIComponent(title),job=app.importJob({title,originalText:quote+'硕士及以上'+(pending?'计算机专业':''),duties:quote,knownConditions:['硕士及以上',...(pending?['计算机专业']:[])],recruitmentUnit:'模拟研究院',location:{options:['北京']},applicationPath:{kind:'direct',url},evidenceUse:'current',sourceIdentity:{sourceId:'demo',externalId:title},observedAt}).job;
  app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:title,observedAt:at,acquisition:'success',listComplete:true,listed:true,applicationOpen:true,evidence:{url,text:'公开开放',quote:'公开开放'},...(deadline?{deadline:{raw:deadline,evidence:{url,text:deadline,quote:deadline}}}:{})});
  app.evaluateEligibility(job.id);await app.matchJob(job.id);if(followed)app.setPersonalState(job.id,{followed:true});return job;
 }};
}

test('没有新机会也每天生成一份日报，空事件可发送；同日冻结，跨日只汇总当前',async t=>{
 let at='2026-10-14T01:00:00Z';const requests=[];
 const app=createApplication({databasePath:':memory:',now:()=>new Date(at),notificationTransport:{enabled:true,simulated:true,send:async request=>{requests.push(request);return {code:200,shortCode:'controlled'};}}});t.after(()=>app.close());
 const preview=app.getNotificationPreview();assert.match(preview.title,/求职日报/);assert.match(preview.content,/今日无新增可考虑岗位/);
 assert.equal(app.listNotificationDrafts().length,0);assert.equal(app.getActionEvents().length,0);
 const draft=app.prepareDailyActions().dailyDigest;assert.ok(draft);assert.deepEqual(draft.eventIds,[]);
 assert.equal((await app.sendNotification(draft.id)).status,'accepted');
 assert.equal(app.prepareDailyActions().dailyDigest,null);assert.equal(app.prepareDailyActions().importantDraft,null);
 await app.sendNotification(draft.id);assert.equal(requests.length,1);
 at='2026-10-15T01:00:00Z';const next=app.prepareDailyActions().dailyDigest;assert.ok(next);assert.notEqual(next.id,draft.id);
 assert.equal((await app.sendNotification(next.id)).status,'accepted');assert.equal(requests.length,2);
});

test('今日转为可考虑与首次发现分开，重算和恢复排除不制造次日新增；关注结束只展示变化一次',async t=>{
 const s=setup(t),{app}=s;
 const job=await s.seed('存量今日可考虑',{followed:true,observedAt:'2026-10-12T01:00:00Z'});
 const first=app.prepareDailyActions().dailyDigest;assert.match(first.content,/今日转为可考虑/);app.handoffNotificationDraft(first.id,{attemptId:'controlled-first'});
 s.setTime('2026-10-15T01:00:00Z');await app.matchJob(job.id);app.setPersonalState(job.id,{notInterested:true});app.setPersonalState(job.id,{notInterested:false});
 const next=app.prepareDailyActions().dailyDigest;assert.equal(next.report.counts.newConsiderable,0);assert.equal(next.report.counts.followed,1);
 app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:job.title,observedAt:'2026-10-15T01:00:00Z',acquisition:'success',listComplete:true,listed:false,evidence:{url:'https://example.invalid/end',text:'招聘已结束',quote:'招聘已结束'},explicitEnd:{url:'https://example.invalid/end',text:'招聘已结束',quote:'招聘已结束'}});
 const ended=app.prepareDailyActions().dailyDigest;assert.match(ended.content,/已结束/);app.handoffNotificationDraft(ended.id,{attemptId:'controlled-ended'});
 s.setTime('2026-10-16T01:00:00Z');assert.equal(app.prepareDailyActions().dailyDigest.report.counts.followed,0);assert.equal(app.getPersonalState(job.id).followed,true);
});

test('已投递不进临期清单，暂停与排除不展示，未披露截止不造倒计时',async t=>{
 const s=setup(t),{app}=s;
 const applied=await s.seed('已投递',{deadline:'2026-10-15',followed:true});app.setApplied(applied.id,true);
 const paused=await s.seed('暂停',{deadline:'2026-10-15',followed:true});app.setPersonalState(paused.id,{remindersPaused:true});
 const excluded=await s.seed('排除',{followed:true});app.setPersonalState(excluded.id,{notInterested:true});
 await s.seed('日期未披露',{followed:true});
 const report=app.prepareDailyActions().dailyDigest;assert.equal(report.report.counts.followed,2);assert.equal(report.report.counts.closing,0);assert.match(report.content,/已投递/);assert.doesNotMatch(report.content,/临期提醒|剩余1天|暂停｜|排除｜/);assert.match(report.content,/截止：未披露/);
});

test('简短关注清单也冻结并在有限重试前复核个人状态',async t=>{
 let sends=0;const s=setup(t,{enabled:true,simulated:true,send:async()=>{sends++;return {outcome:'not_accepted',category:'connection_pre_submission',retryable:true};}}),{app}=s,job=await s.seed('关注重试',{followed:true});
 app.handoffNotificationDraft(app.prepareDailyActions().dailyDigest.id,{attemptId:'controlled-yesterday'});s.setTime('2026-10-15T01:00:00Z');
 const report=app.prepareDailyActions().dailyDigest;assert.equal(report.featuredJobs.length,0);assert.match(report.content,/关注重试/);
 assert.equal((await app.sendNotification(report.id)).status,'retry_wait');const held=app.getNotificationDraft(report.id);app.setPersonalState(job.id,{remindersPaused:true});
 assert.deepEqual(app.getNotificationDraft(report.id),held);assert.equal(app.prepareDailyActions().dailyDigest,null);
 s.setTime('2026-10-15T01:01:00Z');assert.equal((await app.sendNotification(report.id)).status,'cancelled');assert.equal(sends,1);
});

test('四区块按岗位去重，关注与30天内截止用清单，详细卡片最多5且余项不丢',async t=>{
 const s=setup(t),{app}=s;
 const watched=await s.seed('关注兼新增',{deadline:'2026-10-15',followed:true});
 const near=await s.seed('三十天边界',{deadline:'2026-11-13',pending:true});
 const beyond=await s.seed('三十一天',{deadline:'2026-11-14'});
 for(let n=0;n<7;n++)await s.seed('新机会'+n);
 const before=[app.listNotificationDrafts(),app.getActionEvents(),app.listNotificationAttempts()];
 const preview=app.getNotificationPreview();assert.deepEqual([app.listNotificationDrafts(),app.getActionEvents(),app.listNotificationAttempts()],before);
 const report=app.prepareDailyActions().dailyDigest;
 assert.deepEqual(report.report.counts,{followed:1,closing:2,newConsiderable:10,uniqueJobs:10});
 assert.equal(report.report.sections.followed[0].jobId,watched.id);assert.equal(report.report.sections.closing[0].jobId,near.id);
 assert.ok(!report.report.sections.closing.some(x=>x.jobId===beyond.id));
 assert.equal(report.report.sections.newConsiderable.filter(x=>x.detailed).length,5);
 assert.equal((report.htmlContent.match(/data-notification-job=/g)??[]).length,10);
 assert.equal((report.htmlContent.match(/data-notification-card=/g)??[]).length,5);
 assert.match(report.content,/资格待核验/);assert.match(report.content,/剩余30天/);assert.match(report.content,/今日新增可考虑/);
 assert.deepEqual(report.omittedEventIds,[]);assert.equal(report.featuredJobs.length,5);
 assert.deepEqual(preview.report,report.report);
});

test('日报发出后新增不额外发送，次日带上待看机会且不冒充今天发现',async t=>{
 const s=setup(t),{app}=s;
 app.handoffNotificationDraft(app.prepareDailyActions().dailyDigest.id,{attemptId:'controlled-morning'});
 s.setTime('2026-10-14T10:00:00Z');const late=await s.seed('晚间新机会');
 assert.equal(app.prepareDailyActions().dailyDigest,null);assert.equal(app.prepareDailyActions().importantDraft,null);
 s.setTime('2026-10-15T01:00:00Z');const next=app.prepareDailyActions().dailyDigest;
 assert.equal(next.report.counts.newConsiderable,0);assert.match(next.content,/晚间新机会/);assert.match(next.content,/上次日报后新增/);
 assert.ok(next.eventIds.some(id=>app.getActionEvents().find(event=>event.id===id)?.jobId===late.id));
});

test('跨日待看机会交接后仍可通过发送复核，有限重试正文冻结且次日不重放',async t=>{
 const requests=[];const s=setup(t,{enabled:true,simulated:true,send:async request=>{requests.push(request);return requests.length===1?{outcome:'not_accepted',category:'connection_pre_submission',retryable:true}:{code:200,shortCode:'carry-forward'};}}),{app}=s;
 app.handoffNotificationDraft(app.prepareDailyActions().dailyDigest.id,{attemptId:'earlier-report'});
 s.setTime('2026-10-14T10:00:00Z');await s.seed('此前待看');assert.equal(app.prepareDailyActions().dailyDigest,null);
 s.setTime('2026-10-15T01:00:00Z');const draft=app.prepareDailyActions().dailyDigest;
 assert.match(draft.content,/此前待看/);assert.match(draft.content,/上次日报后新增/);
 assert.equal((await app.sendNotification(draft.id)).status,'retry_wait');
 const held=app.getNotificationDraft(draft.id);
 s.setTime('2026-10-15T01:01:00Z');assert.equal((await app.sendNotification(draft.id)).status,'accepted');
 assert.equal(requests.length,2);assert.equal(requests[0].content,requests[1].content);assert.deepEqual(app.getNotificationDraft(draft.id),held);
 assert.equal(app.prepareDailyActions().dailyDigest,null);
 s.setTime('2026-10-16T01:00:00Z');assert.doesNotMatch(app.prepareDailyActions().dailyDigest.content,/此前待看/);
});

test('清单冻结后的官方入口变化取消旧正文有限重试，保留已有记录',async t=>{
 let sends=0;const s=setup(t,{enabled:true,simulated:true,send:async()=>{sends++;return {outcome:'not_accepted',category:'connection_pre_submission',retryable:true};}}),{app}=s;
 const job=await s.seed('入口变化',{followed:true});app.handoffNotificationDraft(app.prepareDailyActions().dailyDigest.id,{attemptId:'controlled-before'});
 s.setTime('2026-10-15T01:00:00Z');const draft=app.prepareDailyActions().dailyDigest;assert.equal((await app.sendNotification(draft.id)).status,'retry_wait');const held=app.getNotificationDraft(draft.id);
 app.importJob({...app.getSourceJob(job.id),sourceIdentity:job.sourceIdentities[0],applicationPath:{kind:'direct',url:'https://example.invalid/new-entry'}});
 s.setTime('2026-10-15T01:01:00Z');assert.equal((await app.sendNotification(draft.id)).status,'cancelled');assert.equal(sends,1);assert.deepEqual(app.getNotificationDraft(draft.id),held);
});

test('交接后外发前个人暂停仍取消，不能恢复当前已失效的正文',async t=>{
 const requests=[];const s=setup(t,{enabled:true,simulated:true,send:async x=>{requests.push(x);return {code:200,shortCode:'must-not-send'};}}),{app}=s;
 const job=await s.seed('即时暂停',{followed:true});const draft=app.prepareDailyActions().dailyDigest;
 const sending=app.sendNotification(draft.id);app.setPersonalState(job.id,{remindersPaused:true});
 assert.equal((await sending).status,'cancelled');assert.equal(requests.length,0);
 assert.equal(app.listNotificationAttempts()[0].category,'pre_dispatch_cancelled');
 assert.equal(app.listNotificationAttempts()[0].transportStartedAt,undefined);
 assert.throws(()=>app.resumeUnsubmittedNotification(draft.id),/当前岗位或个人状态已变化/);
});


test('变更驱动准备在日报交接后仍登记新机会，次日继续展示且不重复发送',async t=>{
 const s=setup(t),{app}=s;const first=app.prepareDailyActions().dailyDigest;
 app.handoffNotificationDraft(first.id,{attemptId:'controlled-no-send'});assert.equal(app.prepareDailyActionsIfNeeded().unchanged,true);
 s.setTime('2026-10-14T06:00:00Z');const job=await s.seed('日报后新增可考虑');
 const update=app.prepareDailyActionsIfNeeded();assert.equal(update.dailyDigest,null);assert.notEqual(update.unchanged,true);
 assert.equal(app.getActionEvents().find(x=>x.jobId===job.id&&x.type==='opportunity').status,'pending');assert.equal(app.prepareDailyActionsIfNeeded().unchanged,true);
 s.setTime('2026-10-15T01:00:00Z');const next=app.prepareDailyActionsIfNeeded().dailyDigest;
 assert.ok(next.report.sections.newConsiderable.some(x=>x.jobId===job.id));assert.equal(app.listNotificationAttempts().length,0);
});
