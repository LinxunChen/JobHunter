import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-ccb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { databasePath: join(dir, 'jobs.sqlite'), ...extra };
}
const shell = '<script src="/cn/job/v3/js/job_list.js"></script>社会招聘';
test('社招动态占位及HTTP200空响应保存原文、明确缺口，重启与计划健康可读', async t => {
  const options = setup(t, { ccbSourceFetch: async url => new Response(url.includes('TXCODE=') ? '' : shell) });
  const app = createApplication(options);
  const run = await app.checkCcbSource({ trigger: 'scheduled', scheduledFor: '2026-10-08T08:00:00+08:00' });
  assert.equal(run.status, 'failed');
  assert.equal(run.listComplete, false);
  assert.match(run.error, /空响应/);
  assert.equal(run.pages[0].raw, '');
  assert.equal(app.listJobs().length, 0);
  assert.equal(app.getSourcesOverview().sources.find(s => s.id === 'ccb-social').latest.trigger, 'scheduled');
  app.close();
  const restarted = createApplication(options); t.after(() => restarted.close());
  assert.equal(restarted.getCcbSourceCoverage().latest.pages[0].rawHash.length, 64);
  assert.ok(restarted.getCcbSourceCoverage().latest.officialChain[0].raw.includes('社会招聘'));
});

const listing = { planId:'p2026', planPost:'ai1', orgId:'ccb', secondOrgId:'research', planType:'SH', planPostName:'算法专家', orgName:'中国建设银行', secondOName:'研究中心', workPlace:'北京', planStatus:'1', endDate:'2026-10-20' };
const detail = { SUCCESS:'true', planPostName:'算法专家', orgName:'中国建设银行', secondOrgName:'研究中心', cityName:'北京', planName:'2026社会招聘第一批', planStatus:'1', endTime:'2026-10-20', postDesc:'推荐排序算法研发', PostRequest:'须3年算法研发经验' };
const announcement = { SUCCESS:'true', annoTitle:'2026社会招聘第一批公告', annoContent:'公共条件：硕士及以上。', planId:'p2026', orgId:'ccb', planType:'SH', annoDate:'2026-09-03', attachList:[] };
function fixtureFetch(url) {
 const u=new URL(url), code=u.searchParams.get('TXCODE');
 if(u.pathname.endsWith('/job_detail.js'))return Promise.resolve(new Response("mapping: { planStatus: { 1: '正在报名', 2: '报名结束' } }"));
 if(!code)return Promise.resolve(new Response(u.pathname.endsWith('job_detail.html')?'<script src="/cn/job/v3/js/job_detail.js"></script>应聘岗位':shell));
 if(code==='NHR104'){const n=Number(u.searchParams.get('PAGE_JUMP'));return Promise.resolve(Response.json({SUCCESS:'true',TOTAL_PAGE:'2',planPostList:n===1?[listing]:[{...listing,planPost:'other',planPostName:'其他岗位'}]}));}
 if(code==='NHR107')return Promise.resolve(Response.json(detail));
 if(code==='NHR105')return Promise.resolve(Response.json({SUCCESS:'true',TOTAL_PAGE:'1',annoList:[{annoId:'anno1',planId:'p2026',orgId:'ccb'}]}));
 if(code==='NHR106')return Promise.resolve(Response.json(announcement));
 throw Error('unexpected fixture '+url);
}
const ref=quote=>({documentId:'announcement',locator:'正文',quote});
function model(calls) {return {process:async input=>{calls.count++;assert.deepEqual(input.targetJobs,[{title:'算法专家',recruitmentUnit:'中国建设银行',department:'研究中心',batch:null}]);assert.ok(input.documents[0].text.includes('公共条件：硕士及以上。'));return {commonConditions:[{text:'硕士及以上',evidence:[ref('硕士及以上')]}],jobs:[{title:'算法专家',recruitmentUnit:'中国建设银行',contractingEntity:null,department:'研究中心',batch:null,locations:['北京'],duties:detail.postDesc,conditions:[{text:detail.PostRequest,evidence:[ref(detail.PostRequest)]}],evidence:[ref(detail.planPostName),ref(detail.orgName),ref(detail.postDesc)],applicationPath:{kind:'steps',url:'https://job.ccb.com/cn/job/job_detail.html?planId=p2026&planPost=ai1&planType=SH&orgId=ccb&secondOrgId=research',email:null,steps:'在岗位详情点击应聘岗位，登录后依官方流程填写简历及申请。',loginRequired:true},unknownFields:['签约主体未披露'],dateEvidence:[]}],inputGaps:[]};}};}
test('完整SH分页、选中单位地点与关联公共公告经应用加工，内容缓存不动个人记录',async t=>{
 const calls={count:0};const options=setup(t,{ccbSourceFetch:fixtureFetch,announcementProcessor:model(calls)});const app=createApplication(options);
 const first=await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(first.status,'success',first.error ?? JSON.stringify(first.gaps));assert.equal(first.listComplete,true);assert.equal(first.listCount,2);assert.equal(first.details.length,1);assert.equal(first.announcements.length,1);assert.equal(first.jobIds.length,1);assert.equal(calls.count,1);
 const job=app.getJob(first.jobIds[0]);assert.equal(job.recruitmentUnit,'中国建设银行');assert.equal(job.department,'研究中心');assert.equal(job.batch,null);assert.deepEqual(job.knownConditions,['硕士及以上','须3年算法研发经验']);assert.deepEqual(job.location.options,['北京']);assert.equal(job.applicationPath.loginRequired,true);assert.equal(job.publishedAt,null);
 app.setApplied(job.id,true);const again=await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(again.jobIds[0],job.id);assert.equal(calls.count,1);assert.equal(app.listJobs().length,1);assert.equal(app.getPersonalState(job.id).applied,true);
 app.close();const restarted=createApplication(options);t.after(()=>restarted.close());assert.equal(restarted.getCcbSourceCoverage().latest.details[0].response.raw.includes('3年算法研发经验'),true);assert.equal(restarted.getJob(job.id).sourceIdentities[0].externalId,'p2026:ai1:research');
});

test('列表总数不符、跨页重复、混入校招及后续超时都不能计完整或删除旧成果',async t=>{
 let mode='valid';const calls={count:0};const app=createApplication(setup(t,{announcementProcessor:model(calls),ccbSourceFetch:async url=>{const u=new URL(url);if(u.searchParams.get('TXCODE')==='NHR104'){
  if(mode==='timeout')throw Error('模拟来源超时');const page=Number(u.searchParams.get('PAGE_JUMP'));const response=await fixtureFetch(url),data=await response.json();
  if(mode==='count')data.TOTAL_REC='50';if(mode==='duplicate')data.planPostList=[listing];if(mode==='campus')data.planPostList[0].planType='XY';return Response.json(data);
 }return fixtureFetch(url);}}));t.after(()=>app.close());
 const first=await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(first.status,'success');app.setApplied(first.jobIds[0],true);
 for(mode of ['count','duplicate','campus','timeout']){const run=await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(run.status,'failed',mode);assert.equal(run.listComplete,false);assert.equal(app.listJobs().length,1);assert.equal(app.getPersonalState(first.jobIds[0]).applied,true);}
});

test('Web公开入口读取具体岗位和缺口，手动检查不能伪造计划事件',async t=>{
 const {startServer}=await import('../src/server.mjs');let failed=false;const app=createApplication(setup(t,{ccbSourceFetch:url=>failed?Promise.resolve(new Response('')):fixtureFetch(url),announcementProcessor:model({count:0})}));t.after(()=>app.close());const server=await startServer({app,port:0});t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/api/sources/ccb/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({postIds:['p2026:ai1:research']})});assert.equal(response.status,200);const run=await response.json();assert.equal(run.trigger,'manual');assert.equal(run.jobIds.length,1);
 assert.match(await(await fetch(base+'/sources')).text(),/href="\/sources\/ccb"/);const page=await(await fetch(base+'/sources/ccb')).text();assert.match(page,/查看具体岗位/);assert.match(page,/岗位详情点击应聘岗位/);assert.match(page,/完整覆盖已核对/);
 const spoof=await fetch(base+'/api/sources/ccb/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({trigger:'scheduled',scheduledFor:'2026-10-08T08:00:00+08:00'})});assert.equal(spoof.status,400);
 failed=true;await fetch(base+'/api/sources/ccb/check',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.match(await(await fetch(base+'/sources/ccb')).text(),/空响应|社招页面未取得/);assert.equal(app.listJobs().length,1);assert.equal((await(await fetch(base+'/api/sources/ccb')).json()).history.length,2);
});

test('公共招聘状态随真实观察刷新，详情失败不下线、完整缺席仅疑似、官网报名结束才结束',async t=>{
 let mode='open',clock='2026-10-08T01:00:00Z';const app=createApplication(setup(t,{now:()=>new Date(clock),announcementProcessor:model({count:0}),ccbSourceFetch:async url=>{
  const u=new URL(url),code=u.searchParams.get('TXCODE');
  if(code==='NHR104'&&mode==='missing')return Response.json({SUCCESS:'true',TOTAL_PAGE:'1',TOTAL_REC:'1',planPostList:[{...listing,planPost:'other'}]});
  if(code==='NHR107'&&mode==='detailFailed')return Response.json({SUCCESS:'false',ERRORMSG:'登录要求，未读取详情'});
  if(code==='NHR107'&&mode==='ended')return Response.json({...detail,planStatus:'2'});
  return fixtureFetch(url);
 }}));t.after(()=>app.close());
 const first=await app.checkCcbSource({postIds:['p2026:ai1:research']});const id=first.jobIds[0];app.setApplied(id,true);assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');assert.equal(app.getRecruitmentState(id).history.length,1);assert.equal(app.getRecruitmentState(id).dates.officialDeadline.value,'2026-10-20');
 clock='2026-10-09T01:00:00Z';await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(app.getRecruitmentState(id).lastOpenAt,new Date(clock).toISOString());
 mode='detailFailed';clock='2026-10-10T01:00:00Z';await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');
 mode='missing';clock='2026-10-11T01:00:00Z';await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(app.getJob(id).recruitmentStatus,'suspected_offline');assert.equal(app.getPersonalState(id).applied,true);
 mode='ended';clock='2026-10-12T01:00:00Z';const ended=await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(ended.status,'success',ended.error);assert.equal(app.getJob(id).recruitmentStatus,'ended');assert.equal(app.getPersonalState(id).applied,true);const negative={url:'https://job.ccb.com/cn/job/announcement.html?annoId=anno1',text:'未报名结束',quote:'未报名结束'};assert.throws(()=>app.recordRecruitmentObservation(id,{sourceId:'ccb-social',externalId:'p2026:ai1:research',acquisition:'success',observedAt:clock,evidence:negative,explicitEnd:negative}),/明确结束/);
});

test('关联公告先保存，详情登录限制仍保留全公共条件和附件，未加工不造岗位',async t=>{
 const app=createApplication(setup(t,{announcementProcessor:{process:async()=>{throw Error('不应调用模型');}},ccbSourceFetch:async url=>{const u=new URL(url);if(u.searchParams.get('TXCODE')==='NHR107')return Response.json({SUCCESS:'false',ERRORCODE:'0060Z1108006',ERRORMSG:'请重新登录'});return fixtureFetch(url);}}));t.after(()=>app.close());
 const run=await app.checkCcbSource({postIds:['p2026:ai1:research'],announcementIds:['anno1']});assert.equal(run.status,'failed');assert.equal(run.listComplete,true);assert.equal(run.announcements.length,1);assert.ok(run.announcements[0].originalAnnouncementId);assert.match(app.getAnnouncement(run.announcements[0].originalAnnouncementId).originalText,/硕士及以上/);assert.equal(app.listJobs().length,0);
});

test('有明确零总数的JSON才可计零列表，缺分页元信息不能计完整',async t=>{
 let incomplete=false;const app=createApplication(setup(t,{ccbSourceFetch:async url=>{const code=new URL(url).searchParams.get('TXCODE');if(!code)return new Response(shell);return Response.json(incomplete?{SUCCESS:'true'}:{SUCCESS:'true',TOTAL_PAGE:'0',TOTAL_REC:'0',CURR_TOTAL_PAGE:'1'});}}));t.after(()=>app.close());
 const empty=await app.checkCcbSource();assert.equal(empty.listComplete,true);assert.equal(empty.listCount,0);assert.equal(empty.status,'success');assert.match(empty.businessGaps.join(' '),/未选择具体岗位/);for(const scheduledFor of ['2026-10-08T09:00:00+08:00','2026-10-09T09:00:00+08:00'])await app.checkCcbSource({trigger:'scheduled',scheduledFor});assert.equal(app.listSourceHealthEvents().length,0);incomplete=true;const unknown=await app.checkCcbSource();assert.equal(unknown.listComplete,false);assert.equal(unknown.status,'failed');
});

test('已取得附件原件但不能读取仍是实际来源缺口，两个计划只合并一个故障', async t => {
 const app=createApplication(setup(t,{announcementProcessor:null,ccbSourceFetch:async url=>{
  if(new URL(url).pathname.endsWith('/FileDownloadZPServlet'))return new Response('模拟不可解析附件原件');
  if(new URL(url).searchParams.get('TXCODE')==='NHR106')return Response.json({...announcement,attachList:[{filePath:'demo-attachment',file_Name:'模拟条件.bin'}]});
  return fixtureFetch(url);
 }}));t.after(()=>app.close());
 for(const scheduledFor of ['2026-10-08T09:00:00+08:00','2026-10-09T09:00:00+08:00']){
  const run=await app.checkCcbSource({postIds:[],announcementIds:['anno1'],trigger:'scheduled',scheduledFor});
  assert.equal(run.status,'partial');assert.match(run.gaps.join(' '),/模拟条件.bin/);assert.equal(app.getSourcesOverview().sources.find(item=>item.id==='ccb-social').latest.failureCategory,'attachment');
  const ann=app.getAnnouncement(run.announcements[0].originalAnnouncementId);assert.equal(app.getAnnouncementAttachment(ann.id,'attachment-1').toString(),'模拟不可解析附件原件');
 }
 assert.equal(app.listSourceHealthEvents().filter(item=>item.sourceId==='ccb-social').length,1);
});

test('公共列表省略计划字段时以唯一官方计划标题找到公告，再按正文planId/orgId严格关联',async t=>{
 let duplicate=false,mismatch=false;const calls={count:0};const app=createApplication(setup(t,{announcementProcessor:model(calls),ccbSourceFetch:async url=>{
  const code=new URL(url).searchParams.get('TXCODE');
  if(code==='NHR105')return Response.json({SUCCESS:'true',TOTAL_PAGE:'1',annoList:[{annoId:'anno1',annoTitle:detail.planName},...(duplicate?[{annoId:'anno2',annoTitle:detail.planName}]:[])]});
  if(code==='NHR106')return Response.json({...announcement,orgId:mismatch?'other-org':'ccb'});
  return fixtureFetch(url);
 }}));t.after(()=>app.close());
 const linked=await app.checkCcbSource({postIds:['p2026:ai1:research']});assert.equal(linked.status,'success');assert.equal(linked.announcements[0].matched,true);assert.match(app.getJob(linked.jobIds[0]).originalText,/公共条件：硕士及以上/);
 duplicate=true;const ambiguous=await app.checkCcbSource({postIds:['p2026:ai1:research'],processJobs:false});assert.equal(ambiguous.announcements.length,0);assert.match(ambiguous.gaps.join('\n'),/公共条件尚未核验/);
 duplicate=false;mismatch=true;const rejected=await app.checkCcbSource({postIds:['p2026:ai1:research'],processJobs:false});assert.equal(rejected.announcements[0].matched,false);assert.match(rejected.gaps.join('\n'),/关联未确认/);
});

test('已截止的京外非技术岗位缺公共公告只保留原文，不制造待处理异常或模型调用',async t=>{
 let calls=0;const app=createApplication(setup(t,{now:()=>new Date('2026-10-13T02:00:00Z'),announcementProcessor:{process:async()=>{calls++;throw Error('不应加工');}},ccbSourceFetch:async url=>{
  const code=new URL(url).searchParams.get('TXCODE');
  if(code==='NHR107')return Response.json({...detail,cityName:'呼和浩特',planStatus:'2',endTime:'2026-07-24'});
  if(code==='NHR105')return Response.json({SUCCESS:'true',TOTAL_PAGE:'1',annoList:[]});
  return fixtureFetch(url);
 }}));t.after(()=>app.close());const run=await app.withModelBatch(()=>app.checkCcbSource({postIds:['p2026:ai1:research']}),{automatic:true});assert.equal(run.status,'success',run.gaps.join(';'));assert.equal(calls,0);assert.equal(run.details[0].processingStatus,'scope_excluded');assert.equal(run.gaps.length,0);
});
