import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';
import{createApplication}from'../src/application.mjs';
import{createPushplusTransport}from'../src/pushplus.mjs';
import{startServer}from'../src/server.mjs';

test('推送两块简洁呈现，中文来源按原因合并，保留具体缺口且不显示空岗位计数和模板尾注',t=>{
 const app=createApplication({databasePath:':memory:',now:()=>new Date('2026-10-10T02:00:00Z'),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 for(const [id,name,category,gap] of [['fault-a','中金公司','pagination','招聘列表分页数量不符'],['fault-b','中信建投证券','pagination','招聘列表分页数量不符'],['fault-c','工商银行','attachment','工行附件岗位名称及地点无法唯一对应'],['fault-d','国资委发现入口','detail','公众号访问验证，未取得正文/附件，不绕过验证码']]){
  app.registerSource({id,name,kind:'recruitment',scope:'模拟',monitoringObjectIds:['seed-01']});
  for(const day of ['09','10'])app.recordSourceCheck({id:id+day,sourceId:id,status:'partial',stage:'completed',failureCategory:category,checkedAt:'2026-10-'+day+'T01:00:00Z',trigger:'scheduled',scheduledFor:'2026-10-'+day+'T01:00:00Z',listComplete:true,gaps:[gap]});
 }
 const draft=app.prepareDailyActions().dailyDigest;
 assert.match(draft.title,/求职日报/);assert.match(draft.content,/今日新增可考虑/);assert.match(draft.content,/系统运行状态/);assert.match(draft.content,/中金公司.*中信建投证券/);assert.match(draft.content,/招聘列表未完整取得/);assert.match(draft.content,/工商银行.*岗位与附件未能唯一对应/);
 assert.equal((draft.content.match(/招聘列表未完整取得/g)??[]).length,1);assert.doesNotMatch(draft.content+draft.htmlContent,/fault-[abc]|0 个岗位|具体缺口在电脑查看|完整职责、条件|需要处理的来源异常|另.*来源故障未展示/);assert.match(draft.htmlContent,/data-notification-section="newConsiderable"/);assert.match(draft.htmlContent,/data-notification-section="system"/);
 assert.match(draft.content,/国资委发现入口.*公众号正文需访问验证/);
 const before=app.getActionEvents().length;const preview=app.getNotificationPreview();assert.match(preview.content,/招聘列表未完整取得/);assert.equal(app.getActionEvents().length,before);assert.equal(app.listNotificationAttempts().length,0);
});

test('同岗新机会和临期合并成HTML卡片，纯文本兼容且传输模板完整冻结，不因预览重发',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jh-html-notification-'));let payload;
 const transport=createPushplusTransport({enabled:true,token:'simulation-token',simulated:true,request:async(url,request)=>{payload=JSON.parse(request.body);return{status:200,json:async()=>({code:200,data:'simulationShortCode'})};}});
 const quote='负责推荐排序研发与业务系统设计';const dimension={level:'high',shortReason:'推荐排序研发经历直接相关',explanation:'匹配直接职责',directExperiences:[{profileQuote:quote,jobQuote:quote,explanation:'直接研发经历'}],transferableAbilities:[],gaps:[],jobQuotes:[quote]};
 const app=createApplication({databasePath:join(dir,'jobs.sqlite'),now:()=>new Date('2026-10-08T01:00:00Z'),announcementProcessor:null,matchingProcessor:{match:async()=>({technical:dimension,business:dimension,scope:dimension,route:'expert',routeExplanation:'研发专家',routeEvidence:[quote],recommendation:{level:'priority',reason:'推荐研发经历匹配'},uncertainties:[]})},notificationTransport:transport});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});});
 app.saveCareerProfile({sourceId:'manual',version:'v1',text:quote});app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟',quote:'硕士'}}});
 const job=app.importJob({title:'模拟岗位<script>',originalText:quote+'硕士及以上',duties:quote,knownConditions:['硕士及以上'],recruitmentUnit:'模拟研究院',location:{options:['北京']},applicationPath:{kind:'direct',url:'https://example.invalid/one'},evidenceUse:'current',sourceIdentity:{sourceId:'demo',externalId:'one'},observedAt:'2026-10-08T00:00:00Z'}).job;
 const raw='2026-10-10';app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:'one',observedAt:'2026-10-08T00:00:00Z',acquisition:'success',listComplete:true,listed:true,applicationOpen:true,evidence:{url:'https://example.invalid/one',text:'公开开放',quote:'公开开放'},deadline:{raw,evidence:{url:'https://example.invalid/one',text:raw,quote:raw}}});app.evaluateEligibility(job.id);await app.matchJob(job.id);
 const draft=app.prepareDailyActions().dailyDigest;assert.equal(draft.template,'html');assert.equal((draft.htmlContent.match(/data-notification-job=/g)??[]).length,1);assert.match(draft.htmlContent,/模拟岗位&lt;script&gt;/);assert.doesNotMatch(draft.htmlContent,/<script>/);assert.equal(draft.report.sections.closing.length,1);assert.equal((draft.htmlContent.match(/data-notification-card=/g)??[]).length,0);assert.match(draft.htmlContent,/截止：2026-10-10/);
 const before=app.getActionEvents().length;const base=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(base+'/notification-preview?id='+draft.id)).status,200);assert.equal(app.getActionEvents().length,before);assert.equal(app.listNotificationAttempts().length,0);
 const preview=await(await fetch(base+'/api/notification-preview')).json();assert.match(preview.content,/求职日报/);assert.equal(preview.runSummary.counts.newJobs,1);
 await app.sendNotification(draft.id);assert.equal(payload.template,'html');assert.equal(payload.content,draft.htmlContent);assert.equal(app.getNotificationDelivery(draft.id).htmlContent,draft.htmlContent);const n=app.listNotificationAttempts().length;app.prepareDailyActions();await app.sendNotification(draft.id);assert.equal(app.listNotificationAttempts().length,n);
});
