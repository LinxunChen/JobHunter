import test from 'node:test';import assert from 'node:assert/strict';import{createApplication}from'../src/application.mjs';
import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
test('公共加工入口逐次记录真实回执用量，缓存与推理不重复相加，批次暂停不算模型调用',async()=>{
 let fail=false;const app=createApplication({databasePath:':memory:',announcementProcessor:{process:async()=>{if(fail){const e=Error('额度不足');e.receipt={completed:false,failureCategory:'quota',durationMs:12};throw e;}return {output:{commonConditions:[],inputGaps:[],jobs:[]},receipt:{completed:true,model:'simulated',durationMs:10,usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20,reasoning_output_tokens:7}}};}},matchingProcessor:null});
 try{const a=await app.createAnnouncement({title:'模拟公告',originalText:'模拟公告无具体岗位'});await app.processAnnouncement(a.id);await app.processAnnouncement(a.id);let usage=app.getModelUsageSummary();assert.equal(usage.calls,1);assert.equal(usage.inputTokens,100);assert.equal(usage.cachedInputTokens,60);assert.equal(usage.outputTokens,20);assert.equal(usage.totalTokens,120);
 fail=true;await app.withModelBatch(async()=>{for(let i=0;i<2;i++){const a=await app.createAnnouncement({title:'失败'+i,originalText:'模拟失败'});await app.processAnnouncement(a.id);}});usage=app.getModelUsageSummary();assert.equal(usage.calls,2);assert.equal(usage.unknownUsageCalls,1);assert.equal(usage.failedCalls,1);assert.equal(usage.totalTokens,120);assert.equal(app.getOperationsOverview().modelUsage.calls,2);assert.equal(app.listNotificationAttempts().length,0);
 }finally{app.close();}
});

test('自动加工与匹配共享北京时间每天50次上限，失败也计数；缓存不占用，跨应用重启及跨日保持正确',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jh-model-budget-'));let clock='2026-10-11T15:59:00Z',calls=0,fail=true;
 const options={databasePath:join(root,'data.sqlite'),now:()=>new Date(clock),announcementProcessor:{process:async()=>{calls++;if(fail){fail=false;const e=Error('模拟超时');e.receipt={completed:false,failureCategory:'timeout'};throw e;}return {output:{commonConditions:[],inputGaps:[],jobs:[]},receipt:{completed:true,usage:{input_tokens:10,output_tokens:2}}};}},matchingProcessor:{match:async()=>{calls++;throw Error('模拟匹配失败');}},careerSource:null};
 let app=createApplication(options),other; t.after(()=>{app.close();other?.close();rmSync(root,{recursive:true,force:true});});
 const announcements=[];for(let i=0;i<52;i++)announcements.push(await app.createAnnouncement({title:'受控预算'+i,originalText:'受控原文'+i}));
 await app.withModelBatch(async()=>{for(const a of announcements.slice(0,49))await app.processAnnouncement(a.id);},{automatic:true});
 assert.equal(calls,49);const cached=announcements[1];await app.withModelBatch(()=>app.processAnnouncement(cached.id),{automatic:true});assert.equal(calls,49);
 const profile=app.saveCareerProfile({text:'模拟职业资料',version:'v1',sourceId:'manual'}),job=app.createJob({title:'模拟匹配',originalText:'模拟职责'});
 await app.withModelBatch(()=>app.matchJob(job.id,{profileId:profile.id}),{automatic:true});assert.equal(calls,50);assert.equal(app.getModelBudgetStatus().used,50);
 app.close();app=createApplication(options);other=createApplication(options);
 const deferred=await Promise.all([app.withModelBatch(()=>app.processAnnouncement(announcements[49].id),{automatic:true}),other.withModelBatch(()=>other.processAnnouncement(announcements[50].id),{automatic:true})]);
 assert.ok(deferred.every(x=>x.processingReceipt.failureCategory==='budget_deferred'&&x.originalText));assert.equal(calls,50);assert.equal(app.getModelUsageSummary().calls,50);
 await app.processAnnouncement(announcements[49].id);assert.equal(calls,51);assert.equal(app.getModelBudgetStatus().used,50);
 clock='2026-10-11T16:00:00Z';assert.equal(app.getModelBudgetStatus().date,'2026-10-12');assert.equal(app.getModelBudgetStatus().used,0);await app.withModelBatch(()=>app.processAnnouncement(announcements[50].id),{automatic:true});assert.equal(calls,52);assert.equal(app.getModelBudgetStatus().used,1);assert.equal(app.getModelBudgetStatus().resetAt,'2026-10-12T16:00:00.000Z');
 assert.equal(app.listNotificationAttempts().length,0);
});

test('来源计划检查启用全项目预算，达到上限仍保存原文与列表，页面作为次日待续显示',async()=>{
 const id='11111111-1111-4111-8111-111111111111',home='<script>var BSGlobal = {"PortalId":"portal","Pages":[{"Name":"社会招聘列表页","Code":"SocialList","BusinessType":"1"}]};</script>';let calls=0;
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date('2026-10-11T09:00:00Z'),announcementProcessor:{process:async()=>{calls++;return {output:{commonConditions:[],inputGaps:[],jobs:[]},receipt:{completed:true}};}},matchingProcessor:null,careerSource:null,sourceFetch:async url=>new Response(String(url).includes('/api/')?JSON.stringify({Code:200,Count:1,Data:String(url).includes('GetJobAdInfo')?{Id:id,CategoryId:'1',JobAdName:'模拟算法岗位',Duty:'负责算法开发\n报名截止时间：2026-12-31',Require:'模拟条件',LocNames:['北京'],EndTime:'2026-12-31'}:[{Id:id,CategoryId:'1',JobAdName:'模拟算法岗位'}]}):home)});
 try{await app.withModelBatch(async()=>{for(let i=0;i<50;i++){const a=await app.createAnnouncement({title:'受控预算'+i,originalText:'受控原文'});await app.processAnnouncement(a.id);}},{automatic:true});const result=await app.withModelBatch(()=>app.checkExpanded_bob_social({postIds:[id],trigger:'scheduled',scheduledFor:'2026-10-11T01:00:00Z'}));assert.equal(calls,50);assert.equal(result.listComplete,true);assert.equal(result.details.length,1);assert.equal(app.listAnnouncements().find(x=>x.title==='模拟算法岗位').status,'deferred');const overview=app.getOperationsOverview();assert.equal(overview.exceptionSummary.total,0);assert.equal(overview.processingQueue.deferred,1);assert.equal(overview.modelUsage.budget.used,50);assert.equal(app.listAnnouncements().length,51);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='bob-social').health.consecutiveScheduledFailures,0);assert.equal(app.listSourceHealthEvents().length,0);
 }finally{app.close();}
});

test('模型成功返回但改写投递步骤时保留完成回执并指出具体字段，归为项目证据错误',async()=>{
 const url='https://example.org/jobs/1',text='模拟岗位。点击申请后按官方步骤登录填写简历。'+url;
 const app=createApplication({databasePath:':memory:',announcementProcessor:{process:async()=>({output:{commonConditions:[],inputGaps:[],jobs:[{title:'模拟岗位',recruitmentUnit:null,contractingEntity:null,department:null,batch:null,locations:[],duties:null,conditions:[],evidence:[{documentId:'announcement',locator:'正文',quote:'模拟岗位'}],applicationPath:{kind:'steps',url,email:null,steps:'先登录再申请',loginRequired:true},unknownFields:[],dateEvidence:[]}]},receipt:{completed:true,model:'simulated',usage:{input_tokens:10,output_tokens:2}}})},matchingProcessor:null,careerSource:null});
 try{const a=await app.createAnnouncement({title:'模拟岗位',originalText:text});const r=await app.processAnnouncement(a.id);assert.equal(r.status,'failed');assert.equal(r.processingReceipt.completed,true);assert.equal(r.processingFailure.stage,'validation');assert.match(r.error,/投递入口 steps 缺少原文证据/);assert.equal(app.listJobs().length,0);const {classifyOperationIssue}=await import('../src/operation-issues.mjs');const issue=classifyOperationIssue(r.error);assert.equal(issue.category,'project');assert.equal(issue.code,'extraction_evidence');assert.equal(app.getModelUsageSummary().calls,1);
 }finally{app.close();}
});

test('有限临时额度100只在当天生效，北京时间跨日恢复50且计数不混用',t=>{
 let clock='2026-10-12T15:59:59Z';const app=createApplication({databasePath:':memory:',now:()=>new Date(clock),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 app.setModelBudgetException({date:'2026-10-12',limit:100,reason:'本人授权本轮修复'});for(let i=0;i<100;i++)app.reserveAutomaticModelCall();assert.equal(app.getModelBudgetStatus().limit,100);assert.equal(app.getModelBudgetStatus().used,100);assert.throws(()=>app.reserveAutomaticModelCall());
 clock='2026-10-12T16:00:00Z';const b=app.getModelBudgetStatus();assert.equal(b.limit,50);assert.equal(b.used,0);assert.equal(b.temporary,false);app.reserveAutomaticModelCall();assert.equal(app.getModelBudgetStatus().used,1);
});

test('自动提取为已加工的合格待匹配岗位保留额度，不让新公告耗尽全部预算',async t=>{
 const {currentJob}=await import('./helpers/current-job.mjs');
 const {updateNecessaryJobs}=await import('../src/necessary-jobs.mjs');
 let extractions=0,matches=0;
 const app=createApplication({databasePath:':memory:',now:()=>new Date('2026-10-13T03:00:00Z'),careerSource:null,
  announcementProcessor:{process:async()=>{extractions++;return {jobs:[],commonConditions:[],inputGaps:[]};}},
  matchingProcessor:{match:async({job})=>{matches++;const dim={level:'unknown',shortReason:'受控证据不足',explanation:'受控证据不足',directExperiences:[],transferableAbilities:[],gaps:['受控缺口'],jobQuotes:[job.originalText]};return {technical:dim,business:dim,scope:dim,route:'uncertain',routeExplanation:'受控未知',routeEvidence:[],recommendation:{level:'uncertain',reason:'受控缺口'},uncertainties:['受控']};}}
 });t.after(()=>app.close());app.saveCareerProfile({text:'模拟算法研发',version:'v1',sourceId:'manual'});
 const job=currentJob(app,{title:'算法工程师',originalText:'负责算法研发'},'2026-10-13T03:00:00Z');
 for(let i=0;i<49;i++)app.reserveAutomaticModelCall();
 const a=await app.createAnnouncement({title:'另一份公告',originalText:'受控新公告'});
 await app.withModelBatch(async()=>{
  const r=await app.processAnnouncement(a.id);
  assert.equal(extractions,0,'最后一次额度应留给已加工岗位的匹配');
  assert.equal(r.status,'deferred');assert.match(r.error,/匹配/);
  assert.equal(app.getModelBudgetStatus().used,49);
  await updateNecessaryJobs(app);
 },{automatic:true});
 assert.equal(matches,1);assert.equal(app.getMatch(job.id).status,'completed');assert.equal(app.getModelBudgetStatus().used,50);
 assert.equal(app.getOperationsOverview().exceptionSummary.actualFailures,0);
});

test('匹配预留覆盖当天首次调用，不突破额度；无待匹配时可继续提取，跨日只保留日限额',t=>{
 let clock='2026-10-13T03:00:00Z';const app=createApplication({databasePath:':memory:',now:()=>new Date(clock),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 assert.throws(()=>app.reserveAutomaticModelCall({reservedForMatching:50}),/匹配/);assert.equal(app.getModelBudgetStatus().used,0);
 app.reserveAutomaticModelCall({reservedForMatching:49});assert.equal(app.getModelBudgetStatus().used,1);
 assert.throws(()=>app.reserveAutomaticModelCall({reservedForMatching:49}),/匹配/);assert.equal(app.getModelBudgetStatus().used,1);
 app.reserveAutomaticModelCall();assert.equal(app.getModelBudgetStatus().used,2);
 clock='2026-10-13T16:00:00Z';assert.equal(app.getModelBudgetStatus().used,0);assert.equal(app.getModelBudgetStatus().limit,50);app.reserveAutomaticModelCall();assert.equal(app.getModelBudgetStatus().used,1);
});
