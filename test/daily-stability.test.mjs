import test from 'node:test';import assert from 'node:assert/strict';import{createApplication}from'../src/application.mjs';import{startServer}from'../src/server.mjs';import{updateNecessaryJobs}from'../src/necessary-jobs.mjs';
test('已关注且匹配完成的岗位开放证据待核验时解释原因，保留匹配且不重复调用',async t=>{
 const duties='负责算法研发和模型优化';const dim={level:'medium',shortReason:'有模型研发经历',explanation:'有模型研发经历',directExperiences:[{profileQuote:duties,jobQuote:duties,explanation:'同类研发职责'}],transferableAbilities:[],gaps:['具体业务待核验'],jobQuotes:[duties]};let calls=0;
 const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date('2026-10-13T02:00:00Z'),announcementProcessor:null,careerSource:null,matchingProcessor:{match:async()=>{calls++;return {technical:dim,business:dim,scope:dim,route:'expert',routeExplanation:'负责研发',routeEvidence:[duties],recommendation:{level:'consider',reason:'算法经历可迁移'},uncertainties:[]};}}});
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(r=>server.close(r));app.close();});app.saveCareerProfile({text:duties,version:'模拟v1',sourceId:'manual'});
 const j=app.importJob({title:'算法工程师',originalText:duties,duties,location:{options:['北京']},sourceIdentity:{sourceId:'cicc-social',externalId:'test-job'}}).job;
 const observe=(at,open)=>app.recordRecruitmentObservation(j.id,{sourceId:'cicc-social',externalId:'test-job',observedAt:at,acquisition:'success',listComplete:true,listed:true,detailAccessible:true,applicationOpen:open,evidence:{url:'https://example.invalid/job',text:'模拟当前详情',quote:'模拟当前详情'}});
 observe('2026-10-12T02:00:00Z',null);assert.equal((await app.matchJob(j.id)).status,'completed');app.setPersonalState(j.id,{followed:true});assert.equal(app.listJobView()[0].display.group,'pending');
 observe('2026-10-13T01:00:00Z',null);const view=app.listJobView()[0];assert.equal(view.display.group,'pending');assert.match(view.display.pendingReason,/匹配已完成；招聘.*待核验/);assert.equal(view.matching.status,'completed');assert.equal(view.personal.followed,true);await updateNecessaryJobs(app);assert.equal(calls,1);
 const html=await(await fetch(`http://127.0.0.1:${server.address().port}/followed`)).text();assert.match(html,/待核验岗位/);assert.match(html,/匹配已完成；招聘是否仍在招待核验/);assert.doesNotMatch(html,/尚无有效正向匹配/);
 observe('2026-10-13T01:30:00Z',true);assert.equal(app.listJobView()[0].display.group,'active');observe('2026-10-13T01:45:00Z',null);assert.equal(app.listJobView()[0].display.group,'active');assert.equal(app.listJobView()[0].personal.followed,true);await updateNecessaryJobs(app);assert.equal(calls,1);
});
test('具体门户的下架规则和申请表单共同证明在招，不把其他平台Status或单独按钮当开放',async t=>{
 const id='11111111-1111-4111-8111-111111111111';let status=1,verified=true;const templateUrl='https://portal-oss.zhiye.com/108394/resource/11111111-1111-4111-8111-111111111111.html';const home='<script>var BSGlobal = '+JSON.stringify({PortalId:'portal',CustomRouteRule:'function routes(){return {"/social/detail":"/custom/socialxq?jobAdId=${jobAdId}&jc=1"}}',Pages:[{Name:'社会招聘列表页',Code:'SocialList',BusinessType:'1'},{Name:'socialxq',Code:'custom',PageType:3,HtmlAddress:templateUrl}]})+';</script>';
 const row={Id:id,CategoryId:'1',JobAdName:'算法工程师',Duty:'开发算法',Require:'硕士以上',Status:1,LocNames:['北京'],EndTime:'2099-01-01'};
 const page=`<a href="#this" id="apply">立即申请</a><script>if(detail.Status != 1){alert('职位已下架');window.location.href='/custom/index';return;}$('#apply').on('click',function(){ $.ajax({url:'/api/Login/GetUserInfo',success:function(result){location.href = '/form?fromPage=job&jobAdId='+jobAdId;}});});</script>`;
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,sourceFetch:async url=>String(url).includes('/api/')?Response.json(String(url).includes('GetJobAdInfo')?{Code:200,Data:{...row,Status:status}}:{Code:200,Count:1,Data:[row]}):new Response((String(url)===templateUrl||String(url).includes('/social/detail'))?verified?page:'<a id="apply">立即申请</a>':home)});t.after(()=>app.close());
 let r=await app.checkExpanded_cicc_social({postIds:[id],processJobs:false});assert.equal(r.status,'success',r.error);assert.equal(r.details[0].applicationOpen,true);assert.ok(r.details[0].applicationEvidence.text.includes('职位已下架'));
 verified=false;r=await app.checkExpanded_cicc_social({postIds:[id],processJobs:false});assert.equal(r.details[0].applicationOpen,null);
 verified=true;status=2;r=await app.checkExpanded_cicc_social({postIds:[id],processJobs:false});assert.equal(r.details[0].applicationOpen,false);
 r=await app.checkExpanded_bob_social({postIds:[id],processJobs:false});assert.equal(r.details[0].applicationOpen,null);
});

test('与研发团队协作不等于本人技术职责，亲自开发仍保留',async()=>{
 const {jobRelevance}=await import('../src/job-relevance.mjs');
 assert.notEqual(jobRelevance({title:'业务管理岗',duties:'开展研发项目周期管理，与系统开发团队、运维团队协作，拟定项目周期，跟踪交付质量。'}).status,'relevant');
 assert.equal(jobRelevance({title:'业务管理岗',duties:'与系统开发团队协作，负责设计数据平台架构、开发软件核心模块。'}).status,'relevant');
});

test('设施电气系统架构不是软件岗位，自动入口零模型；实际控制软件开发仍保留',async t=>{
 let calls=0;const app=createApplication({databasePath:':memory:',expandedSources:true,now:()=>new Date('2026-10-13T02:00:00Z'),careerSource:null,matchingProcessor:null,announcementProcessor:{process:async()=>{calls++;throw Error('范围外不得调用');}}});t.after(()=>app.close());
 const title='研发专家（IDC设施电气设计）',duties='规划新建数据中心电气系统架构；进行配电系统设计，审核工程设计图纸。';
 const url='https://job.spdb.com.cn/jobDetail?jobId=987&type=1';const a=await app.createAnnouncement({title,originalText:`岗位：${title}\n工作地点：北京\n工作职责：${duties}\n任职要求：电气工程专业\n报名截止时间：2026-12-31`,sourceUrl:url,sourceIdentityContext:{sourceId:'spdb-social',externalId:url,observedAt:'2026-10-13T02:00:00Z'}});
 const r=await app.withModelBatch(()=>app.processAnnouncement(a.id),{automatic:true});assert.equal(r.status,'scope_excluded');assert.equal(calls,0);
 const{jobRelevance}=await import('../src/job-relevance.mjs');assert.equal(jobRelevance({title:'电气设计研发专家',duties:'负责开发控制软件和算法系统，设计嵌入式软件。'}).status,'relevant');
});
