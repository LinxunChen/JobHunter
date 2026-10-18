import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
const contract=JSON.parse(readFileSync(new URL('./fixtures/cmri/public-query-contract.json',import.meta.url)));
const origin='https://job.10086.cn';
const shell='<a href="javascript:type(2);">社会招聘</a> data["companyId"] data["type"] <script src="/js/job-center.js"></script><script src="/js/job-module.js"></script>';
const signing=`prototype.pbkey="${contract.publicKey}";function getSecret(){var gs_str = '${contract.alphabet}';} function getDigest(curtime,secret){$.md5(curtime + secret);}`;
const dictionary='var recruitTypeJson = [{"code":"01","name":"校园招聘"},{"code":"02","name":"社会招聘"}];';
const companies=[{companyId:'97',shortName:'研究院',type:4},{companyId:'91',shortName:'成都研究院',type:3},{companyId:'105',shortName:'九天人工智能研究院',type:1}];
function fixtureFetch(url,input={}){
 const path=new URL(url).pathname;
 if(path==='/personal/job/index.html')return Promise.resolve(new Response(shell));
 if(path==='/js/job-center.js')return Promise.resolve(new Response(signing));
 if(path==='/js/job-module.js')return Promise.resolve(new Response(dictionary));
 const request=JSON.parse(input.body);assert.equal(request.header.version,'1.0');assert.equal(request.header.digest.split(';').length,2);assert.equal(request.header.conversationId.length,23);
 if(path==='/job-app/company/getCompanyList.do')return Promise.resolve(Response.json({code:'0000',data:{companyList:companies}}));
 if(path==='/job-app/job/searchJobs.do'){assert.equal(request.data.companyId,97);assert.equal(request.data.type,2);assert.equal(request.data.key,'');return Promise.resolve(Response.json({code:'0000',data:{total:0,jobList:[]}}));}
 throw Error('未允许的模拟公开路径 '+path);
}
function setup(t,extra={}){const directory=mkdtempSync(join(tmpdir(),'jh-cmri-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return {databasePath:join(directory,'data.sqlite'),cmriFetch:fixtureFetch,...extra};}

test('研究院目录与社招类型公开证据支持完整零结果，SQLite重启保留范围，不混校招或其他研究院',async t=>{
 const options=setup(t,{announcementProcessor:{process(){throw Error('零列表不能调用模型');}}});const app=createApplication(options);const run=await app.checkCmriSource();assert.equal(run.status,'success',run.error);assert.equal(run.company.companyId,'97');assert.equal(run.company.shortName,'研究院');assert.equal(run.recruitType,'2');assert.equal(run.listCount,0);assert.equal(run.listComplete,true);assert.equal(run.pages.length,1);assert.equal(run.details.length,0);assert.equal(app.listJobs().length,0);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').latest.status,'success');assert.deepEqual(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').monitoringObjectIds,['seed-23']);app.close();const restarted=createApplication(options);t.after(()=>restarted.close());assert.equal(restarted.getCmriCoverage().history.length,1);assert.equal(restarted.getCmriCoverage().lastSuccessfulAt,run.checkedAt);assert.equal(restarted.listJobs().length,0);
});

const demoJobs=[{id:'demo-social-1',type:'2',companyId:97,company:'中国移动通信有限公司研究院',companyName:'中国移动',companyShortName:'研究院',name:'模拟社会招聘AI技术专家',department:'智能计算研究所',province:'北京;上海',city:'北京市-西城区;上海市-徐汇区',description:'负责AI核心模型研发与技术路线。',dutyCondition:'5年以上AI应用研发经验。',otherRequirement:'公共报名条件：取得国家承认的本科及以上学历。',degree:'15',workYear:'5',status:1,startTime:'2026-09-01',endTime:'2030-12-31'}, {id:'demo-social-2',type:'2',companyId:97,company:'中国移动通信有限公司研究院',companyName:'中国移动',companyShortName:'研究院',name:'模拟社会招聘数据研究员',department:'数据技术研究所',province:'北京',city:'北京市',description:'负责数据平台技术研究。',dutyCondition:'3年以上数据研发经验。',otherRequirement:'公共报名条件：取得国家承认的本科及以上学历。',degree:'25',workYear:'3',status:1,startTime:'2026-09-01',endTime:'2030-12-31'}];
const detailShell='<script src="/js/job-center.js"></script>if (job.status != 1) {$(".jl_btn").hide();}else{$(".jl_btn").show();}var url = "/job-app/job/viewJob.do";data["id"] = id;$("#descriptionDiv p").html(job.description);$("#introductionDiv p").html(job.dutyCondition);$("#otherRequirementDiv p").html(job.otherRequirement);<li><strong>截止时间：</strong><span></span></li>';
function socialFetch(url,input={}){
 const path=new URL(url).pathname;
 if(path==='/js/job-module.js')return Promise.resolve(new Response(dictionary+'var educationBgJson=[{"code":"15","name":"硕士研究生"},{"code":"25","name":"大学本科"}];var workExpJsons=[{"code":"5","name":"5年及以上"},{"code":"3","name":"3年及以上"}];'));
 if(path==='/personal/job/detail.html')return Promise.resolve(new Response(detailShell));
 if(path==='/job-app/job/searchJobs.do'){const data=JSON.parse(input.body).data;return Promise.resolve(Response.json({code:'0000',data:{total:2,jobList:demoJobs.slice((data.pageNo-1)*data.pageSize,data.pageNo*data.pageSize)}}));}
 if(path==='/job-app/job/viewJob.do'){const data=JSON.parse(input.body).data;return Promise.resolve(Response.json({code:'0000',data:demoJobs.find(j=>j.id===data.id)}));}
 return fixtureFetch(url,input);
}
function simulatedProcessor(){return{process:async input=>{const target=input.targetJobs[0],text=input.documents[0].text,first=target.title===demoJobs[0].name,job=first?demoJobs[0]:demoJobs[1],evidence=quote=>({documentId:'announcement',locator:'正文',quote});assert.ok(text.includes(job.description));assert.ok(text.includes(job.otherRequirement));return{commonConditions:[{text:job.otherRequirement,evidence:[evidence(job.otherRequirement)]}],jobs:[{...target,contractingEntity:null,locations:first?['北京市-西城区','上海市-徐汇区']:['北京市'],duties:job.description,conditions:[{text:job.dutyCondition,evidence:[evidence(job.dutyCondition)]}],evidence:[evidence(target.title),evidence(target.recruitmentUnit),evidence(job.description)],applicationPath:{kind:'steps',url:origin+'/personal/job/detail.html?id='+job.id,email:null,steps:'注册并登录官方平台，在岗位详情完成简历并自行投递。',loginRequired:true},unknownFields:['签约主体未披露'],dateEvidence:[]}],inputGaps:[]};}};}

test('未来社招模拟完整分页与详情条件进入共用岗位库，单位与多地选项独立、缓存重启不丢个人申请',async t=>{
 const options=setup(t,{cmriFetch:socialFetch,announcementProcessor:simulatedProcessor()});const app=createApplication(options);const run=await app.checkCmriSource({pageSize:1});assert.equal(run.status,'success',run.error);assert.equal(run.pages.length,2);assert.equal(run.listCount,2);assert.equal(run.listComplete,true);assert.equal(run.details.length,2);assert.equal(run.jobIds.length,2);const job=app.getJob(run.jobIds[0]);assert.equal(job.recruitmentUnit,'中国移动通信有限公司研究院');assert.equal(job.contractingEntity,null);assert.deepEqual(job.location.options,['北京市-西城区','上海市-徐汇区']);assert.ok(job.knownConditions.includes(demoJobs[0].otherRequirement));assert.ok(job.knownConditions.includes(demoJobs[0].dutyCondition));assert.equal(job.applicationPath.loginRequired,true);assert.equal(job.applicationPath.url,origin+'/personal/job/detail.html?id=demo-social-1');assert.equal(job.recruitment.review.lastDetailCheckedAt,run.checkedAt);assert.equal(job.recruitmentStatus,'publicly_listed_open');assert.equal(job.recruitment.dates.officialDeadline,null);assert.ok(job.dateEvidence.some(e=>e.raw==='2030-12-31'&&e.meaning==='unverified'));app.setApplied(job.id,true);const again=await app.checkCmriSource({pageSize:1});assert.deepEqual(again.jobIds,run.jobIds);assert.equal(app.listJobs().length,2);app.close();const restarted=createApplication(options);t.after(()=>restarted.close());assert.equal(restarted.getPersonalState(job.id).applied,true);assert.equal(restarted.getJob(job.id).conditions.length,2);assert.equal(restarted.getCmriCoverage().history.length,2);
});

test('校招混入或异院身份不算完整社招，异常原文与已投记录保留，scheduled故障仅累计计划检查',async t=>{
 let mode='normal';const options=setup(t,{cmriFetch:(url,input)=>{
  if(mode==='invalid'&&url.endsWith('/job-app/job/searchJobs.do'))return Promise.resolve(new Response('模拟已取得但JSON格式损坏的公开响应'));
  if(['campus','foreign'].includes(mode)&&url.endsWith('/job-app/job/searchJobs.do')){const data=JSON.parse(input.body).data,jobs=demoJobs.map((job,index)=>index?job:{...job,...(mode==='campus'?{type:'1'}:{companyId:105,company:'中移九天人工智能研究院',companyShortName:'九天人工智能研究院'})});return Promise.resolve(Response.json({code:'0000',data:{total:2,jobList:jobs.slice((data.pageNo-1)*data.pageSize,data.pageNo*data.pageSize)}}));}
  return socialFetch(url,input);
 },announcementProcessor:simulatedProcessor()});const app=createApplication(options);t.after(()=>app.close());const first=await app.checkCmriSource({pageSize:1});const id=first.jobIds[0];app.setApplied(id,true);mode='campus';const mixed=await app.checkCmriSource({pageSize:1,trigger:'scheduled',scheduledFor:'2026-10-08T09:00:00+08:00'});assert.equal(mixed.status,'failed');assert.equal(mixed.listComplete,false);assert.match(mixed.error,/社招类型|研究院身份/);mode='foreign';const foreign=await app.checkCmriSource({pageSize:1,trigger:'scheduled',scheduledFor:'2026-10-09T09:00:00+08:00'});assert.equal(foreign.status,'failed');assert.equal(foreign.listComplete,false);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').health.consecutiveScheduledFailures,2);mode='invalid';const invalid=await app.checkCmriSource();assert.equal(invalid.status,'failed');assert.equal(invalid.lastResponse.raw,'模拟已取得但JSON格式损坏的公开响应');assert.equal(app.getPersonalState(id).applied,true);assert.equal(app.listJobs().length,2);assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').health.consecutiveScheduledFailures,2);mode='normal';const recovered=await app.checkCmriSource({pageSize:1,trigger:'scheduled',scheduledFor:'2026-10-10T09:00:00+08:00'});assert.equal(recovered.status,'success');assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').health.consecutiveScheduledFailures,0);assert.equal(app.getPersonalState(id).applied,true);
});

test('Web与JSON入口显示实际覆盖，核对模式与输入越界不访问外源',async t=>{
 const {startServer}=await import('../src/server.mjs');const app=createApplication(setup(t,{announcementProcessor:null}));const server=await startServer({app,port:0});const base=`http://127.0.0.1:${server.address().port}`;t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const checked=await fetch(base+'/api/sources/cmri/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(checked.status,200);const run=await checked.json();assert.equal(run.listCount,0);const page=await(await fetch(base+'/sources/cmri')).text();assert.match(page,/研究院/);assert.match(page,/列表0项/);assert.match(page,/校招/);assert.match(await(await fetch(base+'/sources')).text(),/href="\/sources\/cmri"/);const invalid=await fetch(base+'/api/sources/cmri/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'});assert.equal(invalid.status,400);await assert.rejects(app.checkCmriSource({postIds:[]}),/选中岗位/);await assert.rejects(app.checkCmriSource({trigger:'scheduled',scheduledFor:'2026-10-10'}),/计划时刻/);
 let calls=0;const readonly=createApplication(setup(t,{verificationMode:true,cmriFetch:async()=>{calls++;throw Error('不允许调用');}}));t.after(()=>readonly.close());await assert.rejects(readonly.checkCmriSource(),/核对模式/);assert.equal(calls,0);
});

test('公开响应正文未结束也有请求期限，超时可见且不把未知当完整零结果',{timeout:1000},async t=>{
 const app=createApplication(setup(t,{sourceTimeoutMs:25,cmriFetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('尚未结束的公开响应'));}}))}));t.after(()=>app.close());const run=await app.checkCmriSource();assert.equal(run.status,'failed');assert.equal(run.listComplete,false);assert.match(run.error,/25ms/);assert.equal(app.getCmriCoverage().lastSuccessfulAt,null);
});

test('公开详情中的公共条件附件原件参与加工，读取失败明确缺口且保留旧岗与原件',async t=>{
 let missing=false;const url=origin+'/job-app/commonService/downloadFile.do?fileId=demo-public-condition';const app=createApplication(setup(t,{cmriFetch:(address,input)=>{
  if(address===url)return Promise.resolve(new Response('附件公共条件：须具有计算机相关专业。',{status:missing?404:200}));
  if(address.endsWith('/job-app/job/viewJob.do'))return socialFetch(address,input).then(async response=>{const result=await response.json();result.data.otherRequirement+='\n公共附件：<a href="'+url+'">共享报名条件.txt</a>';return Response.json(result);});return socialFetch(address,input);
 },announcementProcessor:{process:async input=>{const output=await simulatedProcessor().process(input);const doc=input.documents.find(d=>d.id==='attachment-1');if(doc)output.commonConditions.push({text:doc.text,evidence:[{documentId:doc.id,locator:doc.segments[0].locator,quote:doc.text}]});return output;}}}));t.after(()=>app.close());const run=await app.checkCmriSource({pageSize:1,postIds:['demo-social-1']});assert.equal(run.status,'success',run.error);const job=app.getJob(run.jobIds[0]),ann=app.getAnnouncement(job.announcementId);assert.equal(ann.attachments[0].status,'read');assert.equal(app.getAnnouncementAttachment(ann.id,'attachment-1').toString(),'附件公共条件：须具有计算机相关专业。');assert.ok(job.conditions.some(c=>c.text==='附件公共条件：须具有计算机相关专业。'&&c.evidence.some(e=>e.documentId==='attachment-1')));app.setApplied(job.id,true);missing=true;const failed=await app.checkCmriSource({pageSize:1,postIds:['demo-social-1']});assert.equal(failed.status,'partial');assert.match(failed.gaps.join(' '),/附件/);assert.equal(app.getSourcesOverview().sources.find(item=>item.id==='cmri-social').latest.failureCategory,'attachment');assert.equal(app.getPersonalState(job.id).applied,true);assert.equal(app.getAnnouncementAttachment(ann.id,'attachment-1').toString(),'附件公共条件：须具有计算机相关专业。');
});

test('模型失败与越界结果不污染岗位库，原文保存；列表真正缺失仅疑似下线不结束申请',async t=>{
 let mode='normal';const options=setup(t,{cmriFetch:(url,input)=>mode==='missing'&&url.endsWith('/job-app/job/searchJobs.do')?Promise.resolve(Response.json({code:'0000',data:{total:0,jobList:[]}})):socialFetch(url,input),announcementProcessor:{process:async input=>{if(mode==='failed')throw Error('模拟Codex加工故障');const result=await simulatedProcessor().process(input);if(mode==='rogue')result.jobs.push({...result.jobs[0]});return result;}}});const app=createApplication(options);t.after(()=>app.close());const first=await app.checkCmriSource({pageSize:1,postIds:['demo-social-1']});const id=first.jobIds[0];app.setApplied(id,true);mode='rogue';const rogue=await app.checkCmriSource({pageSize:1,postIds:['demo-social-2']});assert.equal(rogue.status,'failed');assert.match(rogue.error,/范围/);assert.equal(app.listJobs().length,1);mode='failed';const failure=await app.checkCmriSource({pageSize:1,postIds:['demo-social-2']});assert.equal(failure.status,'failed');assert.match(failure.error,/模拟Codex加工故障/);assert.ok(app.listAnnouncements().some(ann=>ann.status==='failed'&&ann.originalText.includes('模拟社会招聘数据研究员')));assert.equal(app.getPersonalState(id).applied,true);mode='missing';const missing=await app.checkCmriSource();assert.equal(missing.status,'success');assert.equal(missing.listComplete,true);assert.equal(app.getJob(id).recruitmentStatus,'suspected_offline');assert.equal(app.getPersonalState(id).applied,true);assert.equal(app.getRecruitmentState(id).history.at(-1).explicitEnd,undefined);
});

test('详情招聘单位与完整列表矛盾时拒绝落岗，不能凭companyId或集团品牌跨主体归并',async t=>{
 const app=createApplication(setup(t,{cmriFetch:(url,input)=>url.endsWith('/job-app/job/viewJob.do')?socialFetch(url,input).then(async response=>{const data=await response.json();data.data.company='中移九天人工智能研究院';return Response.json(data);}):socialFetch(url,input),announcementProcessor:simulatedProcessor()}));t.after(()=>app.close());const run=await app.checkCmriSource({postIds:['demo-social-1'],pageSize:1});assert.equal(run.status,'failed');assert.match(run.error,/身份|主体/);assert.equal(app.listJobs().length,0);assert.equal(run.details.length,1);assert.equal(run.details[0].data.company,'中移九天人工智能研究院');
});

test('研究院公共计划入口与已集成调度登记可观察，模拟零结果不算故障或模型成功',async t=>{
 const app=createApplication(setup(t,{announcementProcessor:{process(){throw Error('零列表禁止模型');}}}));t.after(()=>app.close());
 assert.equal(app.getScheduledStatus().sourceContracts.find(x=>x.sourceId==='cmri-social').method,'checkCmriSource');
 const run=await app.runSourceCheck('cmri-social',{scheduledFor:'2026-10-08T09:00:00+08:00'});
 assert.equal(run.status,'success',run.error);assert.equal(run.trigger,'scheduled');assert.equal(run.scheduledFor,'2026-10-08T01:00:00.000Z');assert.equal(run.listCount,0);assert.equal(run.listComplete,true);assert.equal(app.listJobs().length,0);
 const source=app.getSourcesOverview().sources.find(x=>x.id==='cmri-social');assert.equal(source.latest.id,run.id);assert.equal(source.health.consecutiveScheduledFailures,0);assert.equal(app.getCmriCoverage().latest.id,run.id);
});

test('非默认关注岗位每日详情更新，普通岗位每周，持久选择与推迟队列重启可见',async t=>{
 let time='2026-10-08T01:00:00Z';const options=setup(t,{now:()=>new Date(time),cmriFetch:socialFetch,announcementProcessor:simulatedProcessor()});let app=createApplication(options);
 const first=await app.checkCmriSource({pageSize:1});const id=first.jobIds[1];app.setPersonalState(id,{followed:true});app.setApplied(id,true);
 time='2026-10-09T01:00:00Z';const old=demoJobs[1].dutyCondition;demoJobs[1].dutyCondition='计算机专业博士学历';t.after(()=>{demoJobs[1].dutyCondition=old;});
 const run=await app.runSourceCheck('cmri-social',{scheduledFor:time});
 assert.equal(run.details.length,1);assert.equal(run.details[0].data.id,'demo-social-2');assert.equal(app.getJob(id).knownConditions.includes('计算机专业博士学历'),true);assert.equal(app.getPersonalState(id).applied,true);
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.jobId===first.jobIds[0]).due,false);
 app.setSourceSettings('cmri-social',{postIds:['not-yet-saved']});app.close();app=createApplication(options);t.after(()=>app.close());
 assert.equal(app.getSourceSettings('cmri-social').postIds[0],'not-yet-saved');assert.equal(app.listRecruitmentReviewPlan().some(x=>x.externalId==='not-yet-saved'&&x.jobId===null&&x.due),true);
});

test('发现积压有界20详情并显示延后，列表检查不算详情核验，失败候选保存证据',async t=>{
 let time='2026-10-08T01:00:00Z',failed=false;const rows=Array.from({length:21},(_,index)=>({...demoJobs[0],id:'demo-queue-'+index,name:'模拟积压岗位'+index}));
 const options=setup(t,{now:()=>new Date(time),cmriFetch:(url,input)=>{
  if(url.endsWith('/job-app/job/searchJobs.do')){const data=JSON.parse(input.body).data;return Promise.resolve(Response.json({code:'0000',data:{total:rows.length,jobList:rows.slice((data.pageNo-1)*data.pageSize,data.pageNo*data.pageSize)}}));}
  if(url.endsWith('/job-app/job/viewJob.do')){if(failed)return Promise.resolve(new Response('模拟详情不可用',{status:503}));return Promise.resolve(Response.json({code:'0000',data:rows.find(row=>row.id===JSON.parse(input.body).data.id)}));}
  return socialFetch(url,input);
 },announcementProcessor:{process:async({targetJobs,documents})=>{const target=targetJobs[0],text=documents[0].text,ref=quote=>({documentId:'announcement',locator:'正文',quote});return {commonConditions:[],inputGaps:[],jobs:[{...target,contractingEntity:null,locations:['北京市-西城区','上海市-徐汇区'],duties:demoJobs[0].description,conditions:[{text:demoJobs[0].dutyCondition,evidence:[ref(demoJobs[0].dutyCondition)]}],evidence:[ref(target.title),ref(target.recruitmentUnit),ref(demoJobs[0].description)],applicationPath:{kind:'steps',url:text.match(/https:\/\/job\.10086\.cn\/personal\/job\/detail.html\?id=[A-Za-z0-9_-]+/)[0],email:null,steps:'注册并登录官方平台，在岗位详情完成简历并自行投递。',loginRequired:true},unknownFields:[],dateEvidence:[]}]};}}});
 const app=createApplication(options);t.after(()=>app.close());const listOnly=await app.checkCmriSource({postIds:[],listOnly:true});assert.equal(listOnly.details.length,0);assert.equal(app.listSourceCandidates('cmri-social').length,21);assert.equal(app.listJobs().length,0);
 const run=await app.runSourceCheck('cmri-social',{scheduledFor:time});assert.equal(run.status,'success',run.error);assert.equal(run.details.length,20);assert.equal(run.reviewDeferred.length,1);assert.equal(run.discoveryPendingCount,1);assert.equal(app.getCmriCoverage().latest.reviewDeferred.length,1);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').latest.reviewDeferred.length,1);
 time='2026-10-09T01:00:00Z';failed=true;const failedRun=await app.runSourceCheck('cmri-social',{scheduledFor:time});assert.equal(failedRun.status,'failed');const candidate=app.listSourceCandidates('cmri-social').find(item=>item.status==='pending');assert.equal(candidate.attemptCount,1);assert.match(candidate.lastAttemptError,/503/);assert.equal(app.listJobs().length,20);
 time='2026-10-10T01:00:00Z';await app.runSourceCheck('cmri-social',{scheduledFor:time});assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='cmri-social').health.consecutiveScheduledFailures,2);assert.equal(app.listSourceHealthEvents().filter(item=>item.sourceId==='cmri-social').length,1);
});
