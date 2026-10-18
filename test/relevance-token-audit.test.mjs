import {currentJob} from './helpers/current-job.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';
import {updateNecessaryJobs} from '../src/necessary-jobs.mjs';
import {beijingLocation} from '../src/job-relevance.mjs';

test('工作地点明确不含北京覆盖新旧模型推荐，三页和通知一致，多地北京与未披露不误排除',async t=>{
 const duties='负责推荐排序模型研发，主导技术架构设计与算法优化。';
 const dimension=()=>({level:'high',shortReason:'直接推荐模型职责',explanation:'具体模型研发事实对应',directExperiences:[{profileQuote:duties,jobQuote:duties,explanation:'具体项目对应'}],transferableAbilities:[],gaps:[],jobQuotes:[duties]});
 const result=()=>({technical:dimension(),business:dimension(),scope:dimension(),route:'expert',routeExplanation:'负责技术领域',routeEvidence:[duties],recommendation:{level:'priority',reason:'具体职责直接匹配'},uncertainties:[]});
 let legacy=false;
 const app=createApplication({databasePath:':memory:',now:()=>new Date('2026-10-11T02:00:00Z'),careerSource:null,announcementProcessor:null,matchingProcessor:{match:async()=>{const output=result();if(legacy){delete output.recommendation;delete output.routeEvidence;for(const key of['technical','business','scope'])delete output[key].shortReason;}return output;}}});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();});
 app.saveCareerProfile({text:duties,version:'模拟v1',sourceId:'manual'});app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟确认',quote:'硕士'}}});
 const jobs=[];
 for(const [title,options,isLegacy] of [['上海算法专家',['上海'],false],['广州旧版算法专家',['广州'],true],['北京多地算法专家',['广州','北京市'],false]]){
  legacy=isLegacy;const job=app.importJob({title,originalText:duties+'硕士及以上',duties,knownConditions:['硕士及以上'],location:{options,confirmed:null,note:null},sourceIdentity:{sourceId:'efunds-social',externalId:title},evidenceUse:'current',observedAt:'2026-10-11T01:00:00Z'}).job;
  app.recordRecruitmentObservation(job.id,{sourceId:'efunds-social',externalId:title,observedAt:'2026-10-11T01:00:00Z',acquisition:'success',listComplete:true,listed:true,applicationOpen:true,evidence:{url:'https://example.invalid/job',text:'模拟开放',quote:'模拟开放'}});
  app.evaluateEligibility(job.id);assert.equal((await app.matchJob(job.id)).status,'completed');app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);jobs.push(job);
 }
 for(const route of ['/jobs','/followed','/applications']){
  const html=await(await fetch(`http://127.0.0.1:${server.address().port}${route}`)).text();const active=html.match(/<tbody data-job-group="active">([\s\S]*?)<\/tbody>/)[1];
  assert.doesNotMatch(active,/上海算法专家|广州旧版算法专家/);assert.match(active,/北京多地算法专家/);assert.match(html,/工作地点明确不含北京/);
 }
 assert.deepEqual(app.getToday().opportunities,[],'已投递岗位不再列为新机会');for(const job of jobs)app.setApplied(job.id,false);
 assert.deepEqual(app.getToday().opportunities.map(item=>item.jobId),[jobs[2].id]);
 assert.equal(beijingLocation({location:{options:['全国']}}).status,'unknown');assert.equal(beijingLocation({location:{options:[]}}).status,'unknown');assert.equal(beijingLocation({location:{options:['上海','待定']}}).status,'unknown');assert.equal(beijingLocation({location:{options:['全国（不含北京）']}}).status,'excluded');
 let calls=0;const auto=createApplication({databasePath:':memory:',careerSource:null,announcementProcessor:null,matchingProcessor:{match:async()=>{calls++;throw Error('北京候选一次模拟失败');}}});
 try{auto.saveCareerProfile({text:duties,version:'模拟v1',sourceId:'manual'});auto.createJob({title:'算法工程师',originalText:duties,location:{options:['上海'],confirmed:null,note:null}});currentJob(auto,{title:'算法专家',originalText:duties},'2026-10-11T01:00:00Z');const updated=await auto.withModelBatch(()=>updateNecessaryJobs(auto),{automatic:true});assert.equal(calls,1);assert.equal(updated.skipped.length,1);assert.match(updated.skipped[0].reason,/不含北京/);assert.equal(auto.getModelBudgetStatus().used,1);}finally{auto.close();}
});

test('三页未匹配不进入可考虑，非技术有短理由，技术职责不被营销名称误排除',async t=>{
 const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null,careerSource:null});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();});
 const pending=currentJob(app,{title:'算法工程师',originalText:'负责算法开发'},new Date().toISOString());
 const irrelevant=app.createJob({title:'核算会计岗',originalText:'负责会计核算'});
 const ambiguous=app.createJob({title:'综合岗',originalText:'未披露具体职责'});
 const rescued=app.importJob({title:'营销系统建设岗',duties:'负责软件开发和算法设计',originalText:'负责软件开发和算法设计',sourceIdentity:{sourceId:'efunds-social',externalId:'test-technical'}}).job;
 for(const job of[pending,irrelevant,ambiguous,rescued]){app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);}
 assert.equal(app.listJobView().find(j=>j.id===irrelevant.id).display.recommendation.level,'avoid');
 assert.equal(app.listJobView().find(j=>j.id===rescued.id).display.group,'pending');
 for(const route of['/jobs','/followed','/applications']){
  const html=await(await fetch(`http://127.0.0.1:${server.address().port}${route}`)).text();
  const active=html.match(/<tbody data-job-group="active">([\s\S]*?)<\/tbody>/)[1];
  assert.doesNotMatch(active,/算法工程师|核算会计岗|综合岗|营销系统/);
  assert.match(html,/<details class="pending-jobs"><summary>待核验岗位/);
  assert.match(html,/非技术业务/);assert.match(html,/data-job-group="pending"/);
 }
 assert.equal(app.listJobs().length,4);assert.equal(app.listApplications().length,4);
});

test('自动匹配只尝试技术候选，已不符合资格及非技术不消耗调用',async()=>{
 let calls=0;const app=createApplication({databasePath:':memory:',announcementProcessor:null,careerSource:null,matchingProcessor:{match:async()=>{calls++;throw Error('模拟模型不可用');}}});
 try{
  app.saveCareerProfile({text:'模拟职业资料负责算法开发',version:'模拟v1',sourceId:'manual'});
  app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟确认',quote:'硕士'}}});
  app.createJob({title:'核算会计岗',originalText:'负责核算会计'});
  app.createJob({title:'软件工程师',originalText:'博士学历',knownConditions:['博士学历']});
  currentJob(app,{title:'算法工程师',originalText:'负责算法开发'},new Date().toISOString());
  app.createJob({title:'综合岗',originalText:'尚未披露职责'});
  const result=await app.withModelBatch(()=>updateNecessaryJobs(app),{automatic:true});
  assert.equal(calls,1);assert.equal(app.getModelBudgetStatus().used,1);assert.equal(result.skipped.length,3);
  assert.equal(app.listJobs().length,4);assert.equal(app.listNotificationAttempts().length,0);
 }finally{app.close();}
});

test('自动发现保留非技术线索但不排队，模糊标题与技术标题不硬排除',()=>{
 const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null,careerSource:null});
 try{
  const items=[{postId:'111111111111111111111111',postName:'核算会计岗'},{postId:'222222222222222222222222',postName:'综合岗'},{postId:'333333333333333333333333',postName:'算法工程师'}];
  app.recordSourceCandidates({id:'synthetic',sourceId:'efunds-social',checkedAt:new Date().toISOString(),listComplete:true,pages:[{raw:{data:{pageForm:{pageData:items}}}}]});
  const candidates=app.listSourceCandidates('efunds-social');assert.equal(candidates.length,3);
  assert.equal(candidates.find(x=>x.title==='核算会计岗').status,'excluded');
  const plan=app.listRecruitmentReviewPlan();assert.equal(plan.some(x=>x.candidate?.title==='核算会计岗'&&x.due),false);
  assert.equal(plan.some(x=>x.candidate?.title==='算法工程师'&&x.due),true);assert.equal(plan.some(x=>x.candidate?.title==='综合岗'&&x.due),true);
 }finally{app.close();}
});

test('单岗详情取得后才按职责初筛，保留完整原文与人工加工入口，不把混合公告全部排除',async()=>{
 let calls=0;const app=createApplication({databasePath:':memory:',careerSource:null,matchingProcessor:null,announcementProcessor:{process:async()=>{calls++;return {commonConditions:[],inputGaps:[],jobs:[]};}}});
 try{
  const title='综合岗',originalText='综合岗\n岗位职责：\n负责日常行政、办公、财务、后勤保障等事务工作。\n任职要求：\n硕士学历';
  const identity={title,recruitmentUnit:null,department:null,batch:null,sourceIdentity:{sourceId:'efunds-social',externalId:'test-details'}};
  const ann=await app.createAnnouncement({title,originalText,jobIdentities:[identity],targetJobs:[{title,recruitmentUnit:null,department:null,batch:null}]});
  const skipped=await app.withModelBatch(()=>app.processAnnouncement(ann.id),{automatic:true});assert.equal(skipped.status,'scope_excluded');assert.equal(calls,0);assert.equal(app.getModelBudgetStatus().used,0);assert.equal(app.getAnnouncement(ann.id).originalText,originalText);assert.equal(skipped.processingReceipt??null,null);
  await app.processAnnouncement(ann.id);assert.equal(calls,1,'本人明确加工仍可进行');
  const mixed=await app.createAnnouncement({title:'综合招聘公告',originalText:originalText+'\n另招算法工程师，负责算法开发'});
  await app.withModelBatch(()=>app.processAnnouncement(mixed.id),{automatic:true});assert.equal(calls,2,'混合公告不因其中非技术职责漏掉其他岗位');
  assert.equal(app.getModelBudgetStatus().used,1);
  const technical='岗位职责：\n负责算法开发\n任职要求：\n硕士学历\n报名截止时间：2026-12-31';
  const outside=await app.createAnnouncement({title:'算法工程师',originalText:'工作地点：上海\n'+technical,jobIdentities:[{...identity,title:'算法工程师',sourceIdentity:{sourceId:'efunds-social',externalId:'test-shanghai'}}],targetJobs:[{title:'算法工程师',recruitmentUnit:null,department:null,batch:null}]});
  const outsideResult=await app.withModelBatch(()=>app.processAnnouncement(outside.id),{automatic:true});assert.equal(outsideResult.status,'scope_excluded');assert.match(outsideResult.processingSkipped,/不含北京/);assert.equal(calls,2);assert.equal(app.getModelBudgetStatus().used,1);
  const beijing=await app.createAnnouncement({title:'算法工程师',originalText:'工作地点：上海、北京市\n'+technical,jobIdentities:[{...identity,title:'算法工程师',sourceIdentity:{sourceId:'efunds-social',externalId:'test-beijing'}}],targetJobs:[{title:'算法工程师',recruitmentUnit:null,department:null,batch:null}]});
  await app.withModelBatch(()=>app.processAnnouncement(beijing.id),{automatic:true});assert.equal(calls,3);assert.equal(app.getModelBudgetStatus().used,2);
 }finally{app.close();}
});

test('大模型渠道销售不因AI产品关键词进入自动加工，营销软件研发仍保留',async t=>{
 const {processingScope}=await import('../src/processing-scope.mjs');
 for(const title of ['高级渠道经理','渠道专家（MaaS）']){
  const a={title,jobIdentities:[{title,sourceIdentity:{sourceId:'ctyun-social',externalId:title}}],originalText:`工作地点：北京\n工作职责：熟悉主流大模型MaaS产品，负责商务洽谈、渠道拓展与客户关系。\n任职资格：本科`,processingObservation:{locations:['北京'],applicationOpen:true}};
  assert.equal(processingScope(a,new Date()).status,'excluded',title);
 }
 const {jobRelevance}=await import('../src/job-relevance.mjs');
 assert.equal(jobRelevance({title:'营销系统建设岗',duties:'负责软件开发和算法设计'}).status,'relevant');
 assert.equal(jobRelevance({title:'渠道平台后端开发工程师',duties:'负责渠道系统软件研发'}).status,'relevant');
});
