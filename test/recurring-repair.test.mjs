import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
import {processingScope,processingDocuments} from '../src/processing-scope.mjs';
const at=()=>new Date('2026-10-12T02:00:00Z');
const seed=(title,text,extra={})=>({title,originalText:text,sourceUrl:'https://job.spdb.com.cn/jobDetail?jobId=123&type=1',sourceIdentityContext:{sourceId:'spdb-social',externalId:'https://job.spdb.com.cn/jobDetail?jobId=123&type=1',observedAt:at().toISOString()},...extra});
test('全部来源共用加工范围：无身份旧页面、未知职责、非北京和博士后均零模型调用',async t=>{
 let calls=0;const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,matchingProcessor:null,announcementProcessor:{process:async()=>{calls++;throw Error('不得执行');}}});t.after(()=>app.close());
 for(const input of [
  seed('安全技术岗','安全技术岗\n 工作地点：上海\n岗位职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31'),
  seed('资产证券化业务岗','岗位：资产证券化业务岗\n地点：北京\n工作职责：辅助项目执行与监管报告\n任职条件：本科\n报名截止时间：2026-12-31'),
  seed('研究院博士后','研究院博士后\n工作地点：北京\n工作职责：研发算法模型\n任职条件：博士\n报名截止时间：2026-12-31'),
  seed('数据仓库架构师','数据仓库架构师\n岗位职责：研发数据仓库系统\n任职条件：本科')
 ]){
  const a=await app.createAnnouncement(input),r=await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});
  assert.notEqual(r.status,'failed');assert.ok(['scope_excluded','scope_pending'].includes(r.status));assert.equal(calls,0);assert.ok(r.sourceProcessingDecision.reason);
 }
});
test('模型暂停独立排队，来源另一次成功不能清除同一原文的真实失败',async t=>{
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,matchingProcessor:null,announcementProcessor:{process:async()=>{const e=Error('模型连接中断');e.receipt={completed:false,failureCategory:'connection'};throw e;}}});t.after(()=>app.close());
 const text='岗位：软件开发岗\n工作地点：北京\n工作职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31';
 await app.withModelBatch(async()=>{
  for(let i=0;i<4;i++){const a=await app.createAnnouncement(seed('软件开发岗'+i,text,{sourceUrl:'https://job.spdb.com.cn/jobDetail?jobId='+i+'&type=1',sourceIdentityContext:{sourceId:'spdb-social',externalId:'https://job.spdb.com.cn/jobDetail?jobId='+i+'&type=1',observedAt:at().toISOString()}}));const r=await app.processAnnouncement(a.id);assert.equal(r.status,i<3?'failed':'deferred');}
 },{automatic:true});
 app.recordSourceCheck({id:'unrelated-success',sourceId:'spdb-social',checkedAt:at().toISOString(),status:'success',listComplete:true,details:[],jobIds:[],gaps:[]});
 const o=app.getOperationsOverview();assert.equal(o.processingQueue.deferred,1);assert.equal(o.processingIssues.filter(x=>x.status==='failed').length,3);assert.equal(o.exceptionSummary.deferred,0);
});
test('今日额度例外到期恢复每日50，超额已用数不重置',async t=>{
 let clock='2026-10-12T15:59:00Z';const app=createApplication({databasePath:':memory:',now:()=>new Date(clock),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 app.setModelBudgetException({date:'2026-10-12',limit:null,reason:'本轮修复临时授权'});
 for(let i=0;i<60;i++)app.reserveAutomaticModelCall();assert.equal(app.getModelBudgetStatus().used,60);assert.equal(app.getModelBudgetStatus().limit,null);
 clock='2026-10-12T16:00:00Z';assert.equal(app.getModelBudgetStatus().limit,50);assert.equal(app.getModelBudgetStatus().used,0);
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();assert.throws(()=>app.reserveAutomaticModelCall(),/50次/);
});
test('单岗混合方向仅提供明确技术分支，资格与原件完整保留',()=>{
 const text='岗位：量化研究岗\n工作地点：北京\n工作职责：\n（一）产品设计方向\n负责客户谈判与合同签订。\n（二）量化开发方向\n负责设计、开发算法交易系统。\n任职条件：\n硕士以上，五年相关工作经验。\n报名截止时间：2026-12-31';
 const input=seed('量化研究岗',text),decision=processingScope(input,at());assert.equal(decision.status,'eligible');assert.deepEqual(decision.selectedDutySections,['量化开发方向']);
 const documents=processingDocuments([{id:'announcement',text,segments:[{locator:'正文',text}]}],decision);
 assert.match(documents[0].text,/开发算法交易系统/);assert.doesNotMatch(documents[0].text,/客户谈判/);assert.match(documents[0].text,/硕士以上，五年相关工作经验/);assert.equal(input.originalText,text);
});
test('最新官方关闭事实覆盖旧开放窗口和旧合格决策，零模型调用',async t=>{
 let calls=0;const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,announcementProcessor:{process:async()=>{calls++;throw Error('不得执行');}},matchingProcessor:null});t.after(()=>app.close());
 const a=await app.createAnnouncement(seed('软件开发岗','岗位：软件开发岗\n工作地点：北京\n工作职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31'));
 app.recordAnnouncementProcessingObservation(a.id,{sourceUrl:a.sourceUrl,title:a.title,checkedAt:at().toISOString(),applicationOpen:false,locations:['北京']});
 const r=await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});assert.equal(r.status,'scope_excluded');assert.equal(calls,0);assert.match(r.sourceProcessingDecision.reason,/申请关闭/);
 const previous={...a,sourceProcessingDecision:{status:'eligible',selectedTitles:[a.title],deadline:{day:'2026-12-31'}},processingObservation:{applicationOpen:false,locations:['北京']}};
 assert.equal(processingScope(previous,at()).status,'excluded');
});
test('诊断保留错误类别和签名，不存第三方回显的秘密或未知代码',async()=>{
 const {inspectCodexResult}=await import('../src/codex-diagnostics.mjs');
 const d=inspectCodexResult({stdout:JSON.stringify({type:'error',code:'secret-token-abcd',message:'Internal server error for secret-token-abcd source customer account 1234'}),stderr:''}).diagnostics;
 const encoded=JSON.stringify(d);assert.doesNotMatch(encoded,/secret|customer|account|1234/);assert.equal(d.errorEvents[0].code,'unknown');assert.equal(d.errorEvents[0].signature.length,64);assert.ok(d.errorEvents[0].terms.includes('server'));
});
test('混合资格分支只裁剪明确对应项，公共资格和截止原文保留',()=>{
 const text='岗位：量化研究岗\n工作地点：北京\n岗位职责：\n（一）产品设计方向\n负责客户谈判。\n（二）量化开发方向\n负责开发算法交易系统。\n任职条件：\n（一）产品设计方向\n五年客户管理。\n（二）量化开发方向\n五年算法开发。\n通用条件：\n硕士学历，无不良记录。\n报名截止时间：2026-12-31';
 const decision=processingScope(seed('量化研究岗',text),at()),r=processingDocuments([{id:'announcement',text}],decision)[0];
 assert.doesNotMatch(r.text,/客户管理/);assert.match(r.text,/五年算法开发/);assert.match(r.text,/硕士学历，无不良记录/);assert.match(r.text,/2026-12-31/);
});
test('详情请求中途失败只记实际请求项，不把其余选中条目写成已尝试',t=>{
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
 const run={id:'actual-attempt',sourceId:'bob-social',checkedAt:at().toISOString(),status:'failed',expandedSource:true,listComplete:true,listings:ids.map(externalId=>({externalId,title:'算法开发岗'})),detailAttempts:[{externalId:ids[0]}],details:[],error:'详情HTTP 500'};
 app.recordSourceCheck(run);app.recordCandidateAttempts('bob-social',ids.map(selectionId=>({selectionId,selectionField:'postIds'})),run);
 const candidates=app.listSourceCandidates('bob-social');assert.equal(candidates[0].attemptCount,1);assert.equal(candidates[1].lastAttemptAt,undefined);
});
test('页面后台立即检查也使用自动预算和范围，达到50后保留排队不外呼',async t=>{
 let calls=0;const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,announcementProcessor:{process:async()=>{calls++;return {output:{commonConditions:[],inputGaps:[],jobs:[]},receipt:{completed:true}};}},matchingProcessor:null,careerSource:null});t.after(()=>app.close());
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();
 const a=await app.createAnnouncement(seed('软件开发岗','岗位：软件开发岗\n工作地点：北京\n工作职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31'));
 app.runSourceCheck=async sourceId=>{await app.processAnnouncement(a.id);return {id:'background-result',sourceId,status:'success',gaps:[]};};
 const task=app.startSourceCheck({sourceIds:['spdb-social']});await app.waitForSourceCheck(task.id);
 assert.equal(app.getAnnouncement(a.id).status,'deferred');assert.equal(calls,0);assert.equal(app.getModelBudgetStatus().used,50);assert.equal(app.listNotificationAttempts().length,0);
});
test('历史缺材料线索保持内容变化才复查，不因统一门禁重置成每周重试',()=>{
 const item=seed('历史机构2023春招','历史机构2023春招',{sourceIdentityContext:{sourceId:'beijing-sasac',externalId:'https://mp.weixin.qq.com/s/example',dateEvidence:[{field:'listDate',raw:'2023-02-24'}]},attachments:[{status:'unread'}]});
 const d=processingScope(item,at());assert.equal(d.status,'needs_material');assert.equal(d.reviewPolicy,'on_change');assert.match(d.reason,/历史线索/);
});
test('旧详情页的检查入口也遵守自动预算，不能绕开每天50次',async t=>{
 const {startServer}=await import('../src/server.mjs');let calls=0;
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,announcementProcessor:{process:async()=>{calls++;throw Error('不得执行');}},matchingProcessor:null});t.after(()=>app.close());
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();const a=await app.createAnnouncement(seed('软件开发岗','岗位：软件开发岗\n工作地点：北京\n工作职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31'));
 app.checkEfundsSource=async()=>app.processAnnouncement(a.id);
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sources/efunds/check`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,200);assert.equal((await response.json()).status,'deferred');assert.equal(calls,0);
});
test('混合公告首岗非技术且非北京，仍按各岗字段保留后续北京技术机会',()=>{
 const text='招聘多个岗位\n岗位名称：财务会计岗\n工作地点：上海\n岗位职责：会计核算。\n任职要求：财会专业。\n报名截止时间：2026-12-31\n岗位名称：算法开发岗\n工作地点：北京\n岗位职责：研发算法系统。\n任职要求：计算机硕士。\n报名截止时间：2026-12-31';
 const item=seed('财务团队公开招聘',text),d=processingScope(item,at());assert.equal(d.status,'eligible');assert.deepEqual(d.selectedTitles,['算法开发岗']);assert.equal(d.roles[0].status,'excluded');
});
test('匹配达到自动预算也只排队，次日可以继续且不伪造一次失败调用',async t=>{
 let calls=0,clock='2026-10-12T02:00:00Z';const app=createApplication({databasePath:':memory:',now:()=>new Date(clock),announcementProcessor:null,matchingProcessor:{match:async()=>{calls++;throw Error('模拟实际匹配失败');}}});t.after(()=>app.close());
 const profile=app.saveCareerProfile({text:'模拟职业资料',version:'v1',sourceId:'manual'}),job=app.createJob({title:'模拟岗位',originalText:'模拟职责'});
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();const result=await app.withModelBatch(()=>app.matchJob(job.id,{profileId:profile.id}),{automatic:true});
 assert.equal(result.status,'deferred');assert.equal(calls,0);assert.equal(app.getModelUsageSummary().calls,0);
 clock='2026-10-12T16:00:00Z';const next=await app.withModelBatch(()=>app.matchJob(job.id,{profileId:profile.id}),{automatic:true});assert.equal(next.status,'failed');assert.equal(calls,1);
});

test('模型终止失败有回执时显示明确恢复动作，不退回笼统待核验或来源故障',async t=>{
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:at,careerSource:null,matchingProcessor:null,announcementProcessor:{process:async()=>{const error=Error('Codex进程失败（exit=1）');error.receipt={completed:false,failureCategory:'unknown',diagnostics:{terminalEvent:'failed',eventCounts:{turnFailed:1,turnCompleted:0}}};throw error;}}});t.after(()=>app.close());
 const a=await app.createAnnouncement(seed('软件开发岗','岗位：软件开发岗\n工作地点：北京\n工作职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31'));
 await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});
 const overview=app.getOperationsOverview();
 assert.equal(overview.exceptionSummary.categories.source,0);
 assert.equal(overview.exceptionSummary.categories.review,0);
 assert.equal(overview.exceptionSummary.categories.project,1);
});

test('额度延期原文在次日优先续办，不被较早待补材料线索长期阻塞',async t=>{
 let clock='2026-10-16T02:00:00Z';const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date(clock),announcementProcessor:{process:async()=>{throw Error('额度已满不应外呼');}},matchingProcessor:null});t.after(()=>app.close());
 const materials=Array.from({length:20},(_,i)=>String(100+i));
 app.recordSourceCheck({id:'older-material',sourceId:'spdb-social',checkedAt:'2026-10-10T01:00:00Z',status:'success',expandedSource:true,listComplete:true,listings:materials.map(externalId=>({externalId,title:'算法开发岗'})),details:materials.map(externalId=>({externalId,processingDecision:{status:'needs_material',reason:'缺公开条件'}})),jobIds:[]});
 const text='岗位：软件开发岗\n工作地点：北京\n工作职责：研发软件平台\n任职条件：本科\n报名截止时间：2026-12-31';
 app.recordSourceCheck({id:'new-eligible',sourceId:'spdb-social',checkedAt:clock,status:'success',expandedSource:true,listComplete:true,listings:[{externalId:'999',title:'软件开发岗'}],jobIds:[]});
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();
 const a=await app.createAnnouncement(seed('软件开发岗',text,{sourceUrl:'https://job.spdb.com.cn/jobDetail?jobId=999&type=1',sourceIdentityContext:{sourceId:'spdb-social',externalId:'https://job.spdb.com.cn/jobDetail?jobId=999&type=1',observedAt:clock}}));
 assert.equal((await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true})).status,'deferred');
 app.recordCandidateAttempts('spdb-social',[{selectionId:'999',selectionField:'postIds'}],{id:'attempt',checkedAt:clock,status:'success',details:[{externalId:'999'}]});
 clock='2026-10-17T02:01:00Z';
 const due=app.listRecruitmentReviewPlan().filter(x=>x.sourceId==='spdb-social'&&x.due);
 assert.equal(due[0].selectionId,'999');assert.equal(app.getModelBudgetStatus().limit,50);
});

test('次日09点预算已恢复时按加工退避到期续办，不等待上次详情满24小时',async t=>{
 let clock='2026-10-16T06:00:00Z';const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date(clock),announcementProcessor:{process:async()=>{throw Error('额度已满');}},matchingProcessor:null});t.after(()=>app.close());
 app.recordSourceCheck({id:'afternoon',sourceId:'spdb-social',checkedAt:clock,status:'success',expandedSource:true,listComplete:true,listings:[{externalId:'998',title:'算法开发岗'}],jobIds:[]});
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();
 const a=await app.createAnnouncement(seed('算法开发岗','岗位：算法开发岗\n工作地点：北京\n工作职责：研发算法平台\n报名截止时间：2026-12-31',{sourceUrl:'https://job.spdb.com.cn/jobDetail?jobId=998&type=1',sourceIdentityContext:{sourceId:'spdb-social',externalId:'https://job.spdb.com.cn/jobDetail?jobId=998&type=1',observedAt:clock}}));
 await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});app.recordCandidateAttempts('spdb-social',[{selectionId:'998',selectionField:'postIds'}],{id:'attempt',checkedAt:clock,status:'success',details:[{externalId:'998'}]});
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='spdb-social'&&x.selectionId==='998').due,false);
 clock='2026-10-17T01:00:00Z';assert.equal(app.getModelBudgetStatus().remaining,50);assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='spdb-social'&&x.selectionId==='998').due,true);
});
