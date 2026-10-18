import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
const target='62fd32a72f9d2421b983ae01';
const detail=JSON.parse(readFileSync(new URL(`./fixtures/efunds-source/detail-${target}.json`,import.meta.url))).data;
const ref=quote=>({documentId:'announcement',locator:'正文',quote});
function processor(calls){return {process:async input=>{calls.count++;const text=input.documents[0].text;assert.ok(text.includes(detail.serviceCondition));return {commonConditions:[],jobs:[{title:detail.postName,recruitmentUnit:detail.company,contractingEntity:null,department:null,batch:null,locations:detail.workPlaceList.map(x=>x.name),duties:detail.workContent,conditions:[{text:detail.serviceCondition,evidence:[ref(detail.serviceCondition)]}],evidence:[ref(detail.postName),ref(detail.company),ref(detail.workContent)],applicationPath:{kind:'direct',url:`https://wecruit.hotjob.cn/SU67ac68866202cc7916aea66e/pb/posDetail.html?postId=${target}&postType=society`,email:null,steps:'点击申请职位，登录后依官方流程填写简历并申请。',loginRequired:true},unknownFields:['签约主体未披露'],dateEvidence:[]}],inputGaps:[]};}}}
function setup(t,extra={}){const dir=mkdtempSync(join(tmpdir(),'jh-efunds-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {databasePath:join(dir,'data.sqlite'),...extra};}
function fixtureFetch(url,options={}){
 const path=new URL(url).pathname;
 if(url==='https://job.efunds.com.cn/')return Promise.resolve(new Response('',{status:302,headers:{location:'https://wecruit.hotjob.cn/SU67ac68866202cc7916aea66e/pb/index.html'}}));
 if(path.endsWith('index.html')||path.endsWith('social.html'))return Promise.resolve(new Response('<script src="/pb/js/social.js"></script>'));
 if(path.includes('listPositionDetail'))return Promise.resolve(Response.json({state:'200',data:detail}));
 if(path.includes('listPosition')){const params=new URLSearchParams(options.body);assert.equal(params.get('postName'),null);assert.equal(params.get('recruitType'),'2');const n=Number(params.get('currentPage'));const items=n===1?[{postId:target,postName:detail.postName,recruitType:2,canDelivery:false}]:[{postId:'other',postName:'其他岗位',recruitType:2}];return Promise.resolve(Response.json({state:'200',data:{pageForm:{currentPage:n,totalPage:2,pageSize:10,dataCount:2,pageData:items}}}));}
 if(path.endsWith('posDetail.html'))return Promise.resolve(new Response('<script src="/pb/js/posDetail.js"></script>'));
 throw Error('unexpected fixture URL '+url);
}
test('自动取得综合岗行政正文后保留原文并跳过模型，来源成功且候选退出加工队列',async t=>{
 let calls=0;
 const sourceFetch=async(url,options={})=>{
  const response=await fixtureFetch(url,options);
  if(url.includes('listPositionDetail'))return Response.json({state:'200',data:{...detail,postName:'综合岗',workContent:'负责日常行政、办公、财务、后勤保障等事务工作。'}});
  if(url.includes('listPosition')){const body=await response.json();for(const item of body.data.pageForm.pageData)if(item.postId===target)item.postName='综合岗';return Response.json(body);}
  return response;
 };
 const app=createApplication(setup(t,{sourceFetch,announcementProcessor:{process:async()=>{calls++;throw Error('行政岗不应调用模型');}},matchingProcessor:null,careerSource:null}));t.after(()=>app.close());
 const run=await app.checkEfundsSource({postIds:[target],trigger:'scheduled',scheduledFor:'2026-10-11T01:00:00Z'});
 assert.equal(run.status,'success',run.error);assert.equal(calls,0);assert.equal(app.getModelBudgetStatus().used,0);assert.equal(run.jobIds.length,0);
 assert.equal(run.details[0].processingStatus,'scope_excluded');assert.match(app.getAnnouncement(run.details[0].announcementId).originalText,/负责日常行政、办公、财务、后勤保障等事务工作/);
 assert.equal(app.listSourceCandidates('efunds-social').find(item=>item.externalId===target).status,'excluded');
 assert.equal(app.listRecruitmentReviewPlan().some(item=>item.selectionId===target&&item.due),false);
 // A later explicit import can establish changed technical duties despite the
 // same generic list title. The prior body exclusion must not stick forever.
 app.importJob({title:'综合岗',originalText:'负责软件开发和算法设计',duties:'负责软件开发和算法设计',sourceIdentity:{sourceId:'efunds-social',externalId:target},observedAt:run.checkedAt});
 app.recordSourceCandidates({...run,id:run.id+'-new',details:[]});
 assert.equal(app.listSourceCandidates('efunds-social').find(item=>item.externalId===target).status,'processed');
});
test('全社招分页与选中详情经共用公告入口导入，平台日期不变截止，原文与覆盖重启可读',async t=>{
 const calls={count:0};const options=setup(t,{sourceFetch:fixtureFetch,announcementProcessor:processor(calls)});const app=createApplication(options);
 const run=await app.checkEfundsSource({postIds:[target]});assert.equal(run.status,'success');assert.equal(run.listCount,2);assert.equal(run.pages.length,2);assert.equal(run.details.length,1);assert.equal(run.attachmentsChecked,0);assert.equal(calls.count,1);
 const job=app.getJob(run.jobIds[0]);assert.equal(job.sourceIdentities[0].externalId,target);assert.equal(job.recruitmentStatus,'publicly_listed_open');assert.equal(job.publishedAt,null);assert.ok(job.dateEvidence.some(x=>x.raw==='2030-12-31 23:59:59'&&x.meaning==='unverified'));assert.equal(job.applicationPath.loginRequired,true);assert.ok(app.getAnnouncement(job.announcementId).originalText.includes(detail.serviceCondition));
 app.setApplied(job.id,true);const again=await app.checkEfundsSource({postIds:[target]});assert.equal(again.jobIds[0],job.id);assert.equal(calls.count,1);assert.equal(app.listJobs().length,1);assert.equal(app.getPersonalState(job.id).applied,true);
 app.close();const restarted=createApplication(options);t.after(()=>restarted.close());assert.equal(restarted.getSourceCoverage('efunds-social').latest.listCount,2);assert.equal(restarted.getSourceCoverage('efunds-social').latest.details[0].raw.data.postId,target);assert.equal(restarted.getJob(job.id).sourceEvidence.listCanDelivery,false);
});

test('Web检查入口展示列表与详情覆盖及真实申请链接，故障可见且旧岗位和投递不丢失',async t=>{
 const {startServer}=await import('../src/server.mjs');let failing=false;const calls={count:0};const app=createApplication(setup(t,{sourceFetch:(url,options)=>failing?Promise.reject(Error('模拟来源网络失败')):fixtureFetch(url,options),announcementProcessor:processor(calls)}));const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+'/api/sources/efunds/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postIds:[target]})});assert.equal(response.status,200);const run=await response.json();const id=run.jobIds[0];app.setApplied(id,true);
 const detailHtml=await(await fetch(base+`/jobs/${id}`)).text();assert.match(detailHtml,/自动取得/);assert.match(detailHtml,/当前公开列示开放/);assert.match(detailHtml,/postId=62fd32a72f9d2421b983ae01/);assert.match(detailHtml,/需要登录/);const evidenceResponse=await fetch(base+'/sources/efunds');assert.equal(evidenceResponse.status,200);const evidenceHtml=await evidenceResponse.text();assert.match(evidenceHtml,/原文与检查证据/);assert.match(evidenceHtml,/62fd32a72f9d2421b983ae01/);assert.ok(evidenceHtml.includes(detail.postName));assert.doesNotMatch(detailHtml,/手动保存的当前原文/);
 const page=await(await fetch(base+'/sources')).text();assert.match(page,/列表2项/);assert.match(page,/选中详情1项/);assert.match(page,/附件未检索/);assert.match(page,/原文与完整检查历史/);
 failing=true;const failed=await(await fetch(base+'/api/sources/efunds/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();assert.equal(failed.status,'failed');assert.match(failed.error,/网络失败/);assert.equal(app.listJobs().length,1);assert.equal(app.getPersonalState(id).applied,true);
 assert.match(await(await fetch(base+'/sources')).text(),/模拟来源网络失败/);const coverage=await(await fetch(base+'/api/sources/efunds')).json();assert.equal(coverage.history.length,2);assert.equal(coverage.lastSuccessfulAt,run.checkedAt);
});

test('平台日期与页面格式刷新复用加工；分页重复和有界超时保留旧岗位及失败阶段',async t=>{
 let mode='normal';const calls={count:0};const sourceFetch=(url,options)=>{
  if(mode==='timeout')return new Promise(()=>{});
  if(mode==='refresh'&&url.includes('posDetail.html'))return Promise.resolve(new Response('<!-- template refresh -->\n<script src="/pb/js/posDetail.js"></script>'));
  if(mode==='refresh'&&url.includes('listPositionDetail'))return Promise.resolve(Response.json({state:'200',data:{...detail,publishDate:'2026-10-08 09:01:00',pageViews:99999}}));
  if(mode==='duplicate'&&url.includes('/listPosition/')&&new URLSearchParams(options.body).get('currentPage')==='2')return Promise.resolve(Response.json({state:'200',data:{pageForm:{currentPage:2,totalPage:2,pageSize:10,dataCount:2,pageData:[{postId:target,postName:detail.postName,recruitType:2}]}}}));
  return fixtureFetch(url,options);
 };const app=createApplication(setup(t,{sourceFetch,sourceTimeoutMs:25,announcementProcessor:processor(calls)}));t.after(()=>app.close());
 const first=await app.checkEfundsSource({postIds:[target]});const id=first.jobIds[0];mode='refresh';const refreshed=await app.checkEfundsSource({postIds:[target]});assert.equal(refreshed.jobIds[0],id);assert.equal(calls.count,1);assert.equal(app.getJob(id).refreshedAt,'2026-10-08 09:01:00');assert.equal(app.getSourceCoverage().latest.details[0].raw.data.pageViews,99999);assert.notEqual(refreshed.details[0].rawHash,first.details[0].rawHash);assert.notEqual(refreshed.details[0].applicationPage.rawHash,first.details[0].applicationPage.rawHash);
 mode='duplicate';const duplicate=await app.checkEfundsSource({postIds:[target]});assert.equal(duplicate.status,'failed');assert.equal(duplicate.listComplete,false);assert.equal(duplicate.pages.length,2);assert.match(duplicate.error,/跨页重复/);assert.equal(app.listJobs().length,1);
 mode='timeout';const timedOut=await app.checkEfundsSource({postIds:[target]});assert.equal(timedOut.status,'failed');assert.equal(timedOut.stage,'official_chain');assert.match(timedOut.error,/25ms/);assert.equal(app.listJobs().length,1);assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');
});

test('职责条件仅换行缩进改变时保存新原文，复用已有模型结果及岗位',async t=>{
 let formatted=false;const calls={count:0};const options=setup(t,{sourceFetch:(url,options)=>formatted&&url.includes('listPositionDetail')?Promise.resolve(Response.json({state:'200',data:{...detail,workContent:detail.workContent.replaceAll('\n','  \n  '),serviceCondition:detail.serviceCondition.replaceAll('\n','  \n  ')}})):fixtureFetch(url,options),announcementProcessor:processor(calls)});const app=createApplication(options);t.after(()=>app.close());const first=await app.checkEfundsSource();formatted=true;const next=await app.checkEfundsSource();assert.equal(next.status,'success');assert.equal(next.jobIds[0],first.jobIds[0]);assert.equal(calls.count,1);assert.equal(app.listAnnouncements().length,1);assert.notEqual(first.details[0].rawHash,next.details[0].rawHash);
});

test('首响应实际分页尺寸与请求不同，后续使用返回尺寸并核对总数和唯一ID',async t=>{
 const calls={count:0};const sourceFetch=(url,options)=>{
  if(url.includes('/listPosition/')){const params=new URLSearchParams(options.body);const currentPage=Number(params.get('currentPage'));if(currentPage>1)assert.equal(params.get('pageSize'),'15');return Promise.resolve(Response.json({state:'200',data:{pageForm:{currentPage,totalPage:2,pageSize:15,dataCount:2,pageData:currentPage===1?[{postId:target,postName:detail.postName,recruitType:2}]:[{postId:'other',postName:'其他岗位',recruitType:2}]}}}));}
  return fixtureFetch(url,options);
 };const app=createApplication(setup(t,{sourceFetch,announcementProcessor:processor(calls)}));t.after(()=>app.close());const run=await app.checkEfundsSource();assert.equal(run.status,'success');assert.equal(run.listCount,2);assert.equal(run.listComplete,true);assert.equal(run.pages[1].raw.data.pageForm.pageSize,15);assert.equal(app.listJobs().length,1);
});

test('申请关闭保存新原件且不自动加工，保留投递，正常计划不生成网站故障',async t=>{
 let closed=false;const calls={count:0};const changed='计算机专业博士学历';
 const options=setup(t,{sourceFetch:(url,options)=>closed&&url.includes('listPositionDetail')?Promise.resolve(Response.json({state:'200',data:{...detail,serviceCondition:changed,canDelivery:false,showDeliverButton:0}})):fixtureFetch(url,options),announcementProcessor:{process:async input=>{
  calls.count++;const condition=input.documents[0].text.includes(changed)?changed:detail.serviceCondition;
  return {commonConditions:[],jobs:[{title:detail.postName,recruitmentUnit:detail.company,contractingEntity:null,department:null,batch:null,locations:detail.workPlaceList.map(x=>x.name),duties:detail.workContent,conditions:[{text:condition,evidence:[ref(condition)]}],evidence:[ref(detail.postName),ref(detail.company)],applicationPath:{kind:'direct',url:`https://wecruit.hotjob.cn/SU67ac68866202cc7916aea66e/pb/posDetail.html?postId=${target}&postType=society`,email:null,steps:'点击申请职位，登录后依官方流程填写简历并申请。',loginRequired:true},unknownFields:[],dateEvidence:[]}],inputGaps:[]};
 }}});const app=createApplication(options);t.after(()=>app.close());
 const first=await app.checkEfundsSource();const id=first.jobIds[0];app.setApplied(id,true);closed=true;
 const second=await app.checkEfundsSource({trigger:'scheduled',scheduledFor:'2026-10-08T01:00:00Z'});
 assert.equal(second.jobIds.length,0);assert.notEqual(app.getJob(id).knownConditions[0],changed);assert.match(app.getAnnouncement(second.details[0].announcementId).originalText,/博士学历/);
 assert.equal(second.status,'success');assert.ok(second.businessGaps.length>=1);assert.equal(app.getRecruitmentState(id).status,'unverified');assert.equal(app.getPersonalState(id).applied,true);
 await app.checkEfundsSource({trigger:'scheduled',scheduledFor:'2026-10-09T01:00:00Z'});
 assert.equal(app.listSourceHealthEvents().length,0);assert.equal(calls.count,1);
});

test('完整列表中新岗位持久入候选队列，重启后有界加工进入岗位库，不冒充资格已符合',async t=>{
 const newId='62fd32a72f9d2421b983af99',fresh={...detail,postId:newId};let time='2026-10-08T01:00:00Z';const calls={count:0};
 const options=setup(t,{now:()=>new Date(time),sourceFetch:(url,input)=>{
  if(url.includes('/listPosition/'))return Promise.resolve(Response.json({state:'200',data:{pageForm:{currentPage:1,totalPage:1,pageSize:10,dataCount:1,pageData:[{postId:newId,postName:detail.postName,recruitType:2}]}}}));
  if(url.includes('/listPositionDetail/'))return Promise.resolve(Response.json({state:'200',data:fresh}));return fixtureFetch(url,input);
 },announcementProcessor:{process:async input=>{const output=await processor(calls).process(input);output.jobs[0].applicationPath.url=output.jobs[0].applicationPath.url.replace(target,newId);return output;}}});let app=createApplication(options);
 const first=await app.runSourceCheck('efunds-social',{scheduledFor:time});assert.equal(first.status,'success');assert.equal(first.details.length,0);assert.equal(app.listJobs().length,0);
 assert.equal(app.listSourceCandidates('efunds-social').some(x=>x.externalId===newId&&x.status==='pending'),true);
 app.close();time='2026-10-09T01:00:00Z';app=createApplication(options);t.after(()=>app.close());const next=await app.runSourceCheck('efunds-social',{scheduledFor:time});assert.equal(next.details.length,1);assert.equal(next.jobIds.length,1);const job=app.getJob(next.jobIds[0]);assert.equal(job.sourceIdentities[0].externalId,newId);assert.equal(app.getEligibility(job.id),null);assert.equal(calls.count,1);assert.equal(app.listSourceCandidates('efunds-social').find(x=>x.externalId===newId).status,'processed');
});

test('详细来源页与历史按只列表和零列表成功显示，不声称选中岗位加工',async t=>{
 const {startServer}=await import('../src/server.mjs');let empty=false,modelCalls=0;
 const sourceFetch=(url,options)=>empty&&url.includes('/listPosition/')?Promise.resolve(Response.json({state:'200',data:{pageForm:{currentPage:1,totalPage:1,pageSize:10,dataCount:0,pageData:[]}}})):fixtureFetch(url,options);
 const app=createApplication(setup(t,{sourceFetch,announcementProcessor:{process:async()=>{modelCalls++;throw Error('仅列表不得加工');}},matchingProcessor:null,careerSource:null,notificationTransport:null}));
 const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const first=await app.checkEfundsSource({postIds:[],listOnly:true});assert.equal(first.status,'success');assert.equal(first.details.length,0);assert.equal(first.jobIds.length,0);
 const page=await(await fetch(base+'/sources/efunds')).text();assert.match(page,/<h2>列表检查成功，未选择详情<\/h2>/);assert.doesNotMatch(page,/检查及选中岗位加工成功/);
 empty=true;const second=await app.checkEfundsSource({postIds:[],listOnly:true});assert.equal(second.status,'success');assert.equal(second.listCount,0);
 const zero=await(await fetch(base+'/sources/efunds')).text();assert.match(zero,/<h2>列表检查成功（列表0项，未选择详情）<\/h2>/);
 assert.doesNotMatch(zero,/检查及选中岗位加工成功/);assert.match(zero,/检查历史[\s\S]*列表检查成功，未选择详情/);assert.equal(modelCalls,0);assert.equal(app.listJobs().length,0);
});

test('分页参数也进入请求URL，避免首个固定端点旧响应污染完整分页；仍校验实际完整性',async t=>{
 const app=createApplication(setup(t,{announcementProcessor:null,matchingProcessor:null,sourceFetch:async(url,options)=>{
  if(url.includes('listPosition/')&&!new URL(url).searchParams.has('currentPage'))return Response.json({state:'200',data:{pageForm:{currentPage:1,totalPage:130,pageSize:1,dataCount:130,pageData:[{postId:target,recruitType:2}]}}});
  if(url.includes('listPosition/')){const body=new URLSearchParams(options.body),query=new URL(url).searchParams;assert.equal(query.get('currentPage'),body.get('currentPage'));assert.equal(query.get('pageSize'),body.get('pageSize'));assert.equal(query.get('recruitType'),'2');}
  return fixtureFetch(url,options);
 }}));t.after(()=>app.close());const r=await app.checkEfundsSource({postIds:[],listOnly:true});assert.equal(r.status,'success',r.error);assert.equal(r.listComplete,true);assert.equal(r.listCount,2);
});
