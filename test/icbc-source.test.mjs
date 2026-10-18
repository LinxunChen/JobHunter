import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
const load=name=>JSON.parse(readFileSync(new URL(`./fixtures/icbc/${name}.json`,import.meta.url)));
const current=load('current-post'), historical=load('historical-post');
const notices=[load('current-announcement'),load('historical-announcement')];
const ref=quote=>({documentId:'announcement',locator:'正文',quote});
const decode=value=>decodeURIComponent(Buffer.from(value,'base64').toString());
function fixtureFetch(url,options={}){
 const path=new URL(url).pathname;
 if(path==='/'||path==='/pc/index.html')return Promise.resolve(new Response('<script src="/icbc/trmo/d/pc/umi.f39052b7.js"></script>'));
 if(path.endsWith('umi.f39052b7.js'))return Promise.resolve(new Response('/main/social/postDetail/:postId R00302 2:"d1de6fe1"'));
 if(path.endsWith('.async.js'))return Promise.resolve(new Response('"1"==this.state.applyState?button:"0"==this.state.applyState?button:disabled:!0,postDetail.disabled'));
 if(path.startsWith('/api/v1/chunkserver/'))return Promise.resolve(new Response(Buffer.from('模拟未解析XLS原件'),{headers:{'content-type':'application/vnd.ms-excel'}}));
 const input=JSON.parse(options.body);assert.equal(input.public.call_app,'F-TRM');const params=input.private;
 let data;
 if(path.endsWith('/post/qryPostList')){assert.equal(params.recruitType,'R00302');assert.equal(params.postName,undefined);data={total:2,dataList:params.page===1?[current]:[historical]};}
 else if(path.endsWith('/announ/qryAnnounList')){assert.equal(params.projectType,'R00302');data={total:2,dataList:notices.slice((params.page-1)*params.pageSize,params.page*params.pageSize)};}
 else if(path.endsWith('/post/qryPostById'))data=params.postId===current.postId?current:historical;
 else if(path.endsWith('/announ/qryAnnounListByPostId'))data=[notices[params.postId===current.postId?0:1]];
 else if(path.endsWith('/announ/qryAnnounById'))data=notices.find(x=>x.announId===params.announId);
 else throw Error('不允许的模拟来源路径 '+path);
 return Promise.resolve(Response.json({retCode:'0',data}));
}
function setup(t,extra={}){const directory=mkdtempSync(join(tmpdir(),'jh-icbc-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return {databasePath:join(directory,'data.sqlite'),icbcFetch:fixtureFetch,...extra};}
function processor(calls){return {process:async input=>{calls.count++;const target=input.targetJobs[0],text=input.documents[0].text;const duties=target.title===current.publishPostName?'1.进行互联网领域专题分析和数据建模':'机器学习';assert.ok(text.includes(duties));return {commonConditions:[{text:'三年及以上全职计算机相关工作经验',evidence:[ref('三年及以上全职计算机相关工作经验')]}].filter(()=>target.title===current.publishPostName),jobs:[{...target,contractingEntity:null,locations:[target.title===current.publishPostName?'北京市-通州区':'中国-北京市'],duties,conditions:[],evidence:[ref(target.title),ref(target.recruitmentUnit),ref(duties)],applicationPath:{kind:'steps',url:`https://job.icbc.com.cn/pc/index.html#/main/social/postDetail/${target.title===current.publishPostName?current.postId:historical.postId}`,email:null,steps:'注册并登录官方招聘站，在该岗位详情点击投递，依官方流程填写简历并申请。',loginRequired:true},unknownFields:['签约主体未披露'],dateEvidence:[]}],inputGaps:[]};}}}

test('工行附件岗位名换行与全半角规范化后仍只选地点一致的唯一行，不混淆方向',async t=>{
 const {existsSync}=await import('node:fs'),{resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??[resolve('.runtime/attachment-venv/bin/python'),resolve('../../.runtime/attachment-venv/bin/python')].find(existsSync);assert.ok(python);
 const bytes=readFileSync(new URL('./fixtures/icbc/current-positions.xls',import.meta.url));const post={...current,publishPostName:'软件开发中心（上海）-信息科技类-架构设计岗(知识体系方向)',placeStr:'上海市-浦东新区'};let calls=0;
 const app=createApplication(setup(t,{attachmentPython:python,icbcFetch:async(url,input)=>{if(url.endsWith('/post/qryPostById'))return Response.json({retCode:'0',data:post});if(new URL(url).pathname.startsWith('/api/v1/chunkserver/'))return new Response(bytes);const response=await fixtureFetch(url,input);if(url.endsWith('/post/qryPostList')){const data=await response.json();data.data.dataList=data.data.dataList.map(row=>row.postId===post.postId?post:row);return Response.json(data);}return response;},announcementProcessor:{process:async input=>{
  calls++;const table=input.documents.find(d=>d.id==='attachment-1');assert.deepEqual(table.segments.map(s=>s.locator),['sheet:2026年社会招聘岗位需求表/row:1','sheet:2026年社会招聘岗位需求表/row:2','sheet:2026年社会招聘岗位需求表/row:16']);assert.doesNotMatch(table.text,/可信数据空间方向/);
  return {commonConditions:[],inputGaps:[],jobs:[{...input.targetJobs[0],contractingEntity:null,locations:['上海'],duties:null,conditions:[],evidence:[ref(post.publishPostName)],applicationPath:null,unknownFields:[],dateEvidence:[]}]};
 } } }));t.after(()=>app.close());const run=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});assert.equal(run.status,'success',run.error);assert.equal(calls,1);assert.equal(app.getJob(run.jobIds[0]).title,post.publishPostName);
});

test('社会招聘完整分页、关联公告和原始附件保存，当前与历史独立标记，公共SQLite重启可读',async t=>{
 const calls={count:0},options=setup(t,{announcementProcessor:processor(calls)});const app=createApplication(options);
 const run=await app.checkIcbcSource({postIds:[current.postId,historical.postId],pageSize:1});assert.equal(run.status,'partial',run.error);assert.equal(run.listComplete,true);assert.equal(run.listCount,2);assert.equal(run.pages.length,2);assert.equal(run.catalogComplete,true);assert.equal(run.catalogCount,2);assert.equal(run.details.length,2);assert.equal(run.attachmentsChecked,2);assert.equal(run.jobIds.length,2);assert.match(run.gaps.join(' '),/附件类型暂不支持|读取需要配置|附件读取失败/);
 const jobs=run.jobIds.map(id=>app.getJob(id));const active=jobs.find(j=>j.title===current.publishPostName),old=jobs.find(j=>j.title===historical.publishPostName);assert.equal(active.recruitmentStatus,'publicly_listed_open');assert.equal(active.evidenceUse,'current');assert.equal(old.recruitmentStatus,'ended');assert.equal(old.evidenceUse,'historical');assert.equal(active.applicationPath.loginRequired,true);assert.ok(active.knownConditions.some(x=>x.includes('三年及以上')));assert.equal(active.contractingEntity,null);assert.equal(active.dateEvidence.find(x=>x.field==='enterEndTime').meaning,'explicit_deadline');
 const announcement=app.getAnnouncement(active.announcementId);assert.ok(announcement.originalText.includes('报名起始日'));assert.equal(app.getAnnouncementAttachment(announcement.id,'attachment-1').toString(),'模拟未解析XLS原件');assert.equal(calls.count,2);app.setApplied(active.id,true);
 const again=await app.checkIcbcSource({postIds:[current.postId,historical.postId],pageSize:1});assert.deepEqual(again.jobIds,run.jobIds);assert.equal(calls.count,2);assert.equal(app.listJobs().length,2);assert.equal(app.getPersonalState(active.id).applied,true);app.close();const restarted=createApplication(options);t.after(()=>restarted.close());assert.equal(restarted.getIcbcCoverage().latest.listComplete,true);assert.equal(restarted.getSourcesOverview().sources.find(x=>x.id==='icbc-social').latest.status,'partial');assert.equal(restarted.getAnnouncementAttachment(announcement.id,'attachment-1').toString(),'模拟未解析XLS原件');
});

test('Web公开检查入口可见具体覆盖和登录投递步骤，故障不会清空旧岗位或个人投递',async t=>{
 const {startServer}=await import('../src/server.mjs');let failing=false;const calls={count:0};const app=createApplication(setup(t,{announcementProcessor:processor(calls),icbcFetch:(url,input)=>failing?Promise.reject(Error('模拟工行公开来源故障')):fixtureFetch(url,input)}));const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const base=`http://127.0.0.1:${server.address().port}`;
 // Preserve an explicitly imported historical fixture with an unread XLS; automatic Web checks must reuse, never reprocess it.
 await app.checkIcbcSource({postIds:[current.postId],pageSize:1});
 const checked=await fetch(base+'/api/sources/icbc/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postIds:[current.postId],pageSize:1})});assert.equal(checked.status,200);const first=await checked.json();assert.equal(first.jobIds.length,1);const id=first.jobIds[0];app.setApplied(id,true);
 const page=await(await fetch(base+'/sources/icbc')).text();assert.match(page,/列表2项/);assert.match(page,/选中详情1项/);assert.match(page,/\.xls/i);assert.match(page,/未选中/);assert.match(await(await fetch(base+`/jobs/${id}`)).text(),/需要登录/);assert.match(await(await fetch(base+'/sources')).text(),/href="\/sources\/icbc"/);
 failing=true;const failed=await(await fetch(base+'/api/sources/icbc/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();assert.equal(failed.status,'failed');assert.equal(app.listJobs().length,1);assert.equal(app.getPersonalState(id).applied,true);const coverage=await(await fetch(base+'/api/sources/icbc')).json();assert.equal(coverage.history.length,3);assert.equal(coverage.lastSuccessfulAt,null);assert.match(await(await fetch(base+'/sources/icbc')).text(),/模拟工行公开来源故障/);
});

test('解析失败保留取得的异常原文，重复分页与有界超时不会否定旧岗位',async t=>{
 let mode='normal';const calls={count:0};const options=setup(t,{sourceTimeoutMs:25,announcementProcessor:processor(calls),icbcFetch:(url,input)=>{
  if(mode==='timeout')return new Promise(()=>{});
  if(mode==='invalid'&&url.endsWith('/post/qryPostList'))return Promise.resolve(new Response('模拟已取得但格式变更的原文'));
  if(mode==='duplicate'&&url.endsWith('/post/qryPostList'))return Promise.resolve(Response.json({retCode:'0',data:{total:2,dataList:[current]}}));
  return fixtureFetch(url,input);
 }});const app=createApplication(options);t.after(()=>app.close());const first=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});const id=first.jobIds[0];assert.ok(id);
 mode='invalid';const invalid=await app.checkIcbcSource({pageSize:1});assert.equal(invalid.status,'failed');assert.equal(invalid.lastResponse.raw,'模拟已取得但格式变更的原文');assert.match(invalid.error,/JSON/);
 mode='duplicate';const duplicate=await app.checkIcbcSource({pageSize:1});assert.equal(duplicate.status,'failed');assert.equal(duplicate.listComplete,false);assert.match(duplicate.error,/跨页重复/);
 mode='timeout';const timeout=await app.checkIcbcSource();assert.equal(timeout.status,'failed');assert.match(timeout.error,/25ms/);assert.equal(app.listJobs().length,1);assert.equal(app.getJob(id).recruitmentStatus,'publicly_listed_open');assert.equal(calls.count,1);
});

test('选中范围加工越界与模型故障保留原文且不产生其他岗位；旧岗申请记录仍可读',async t=>{
 let mode='normal';const calls={count:0};const baseProcessor=processor(calls);const app=createApplication(setup(t,{announcementProcessor:{process:async input=>{if(mode==='failure')throw Error('模拟Codex故障');const output=await baseProcessor.process(input);if(mode==='other')output.jobs.push({...output.jobs[0]});return output;}}}));t.after(()=>app.close());const first=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});assert.equal(first.jobIds.length,1);app.setApplied(first.jobIds[0],true);
 mode='other';const other=await app.checkIcbcSource({postIds:[historical.postId],pageSize:1});assert.equal(other.status,'failed');assert.match(other.error,/选中岗位来源范围/);assert.equal(app.listJobs().length,1);assert.ok(app.listAnnouncements().some(a=>a.status==='failed'&&a.originalText.includes(historical.publishPostName)));
 mode='failure';const failure=await app.checkIcbcSource({postIds:[historical.postId],pageSize:1});assert.equal(failure.status,'failed');assert.match(failure.error,/模拟Codex故障/);assert.equal(app.getPersonalState(first.jobIds[0]).applied,true);assert.equal(app.listJobs().length,1);
});

test('来源缺失选中岗位不关闭旧岗，格式及平台刷新日期不触发重复模型；HTTP空ID清单拒绝',async t=>{
 let mode='normal';const calls={count:0};const app=createApplication(setup(t,{announcementProcessor:processor(calls),icbcFetch:(url,input)=>{
  if(mode==='missing'&&url.endsWith('/post/qryPostList'))return Promise.resolve(Response.json({retCode:'0',data:{total:0,dataList:[]}}));
  if(mode==='format'&&url.endsWith('/post/qryPostById'))return Promise.resolve(Response.json({retCode:'0',data:{...current,publishTime:'2026-10-08 00:00:00',postDepict:Buffer.from(decode(current.postDepict).replaceAll('<p>','<p>  ')).toString('base64')}}));
  return fixtureFetch(url,input);
 }}));const {startServer}=await import('../src/server.mjs');const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const first=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});mode='format';const format=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});assert.deepEqual(format.jobIds,first.jobIds);assert.equal(calls.count,1);assert.equal(app.getJob(first.jobIds[0]).refreshedAt,'2026-10-08 00:00:00');mode='missing';const missing=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});assert.equal(missing.status,'success');assert.match(missing.businessGaps.join(' '),/不据此关闭/);assert.equal(app.getJob(first.jobIds[0]).recruitmentStatus,'suspected_offline');
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sources/icbc/check`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"postIds":[]}'});assert.equal(response.status,400);
});

test('HTTP无效JSON对象及恢复核对模式不会启动工行外部接入',async t=>{
 let calls=0;const options=setup(t,{verificationMode:true,icbcFetch:async()=>{calls++;throw Error('不应访问来源');}});const app=createApplication(options);const {startServer}=await import('../src/server.mjs');const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const invalid=await fetch(base+'/api/sources/icbc/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'});assert.equal(invalid.status,400);await assert.rejects(app.checkIcbcSource(),/核对模式/);assert.equal(calls,0);assert.equal(app.listJobs().length,0);
});

test('通用OLE XLS读取保留原始字节和sheet/row/cell/merged证据，北京条件不串到同名上海/成都岗位',async t=>{
 const {existsSync}=await import('node:fs');const {resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??[resolve('.runtime/attachment-venv/bin/python'),resolve('../../.runtime/attachment-venv/bin/python')].find(existsSync);assert.ok(python,'实际XLS验收需要已批准隔离venv Python，未配置不能当作通过');
 const app=createApplication(setup(t,{attachmentPython:python,announcementProcessor:null}));t.after(()=>app.close());const bytes=readFileSync(new URL('./fixtures/icbc/current-positions.xls',import.meta.url));const saved=await app.createAnnouncement({title:'公开工行2026年岗位表读取',originalText:'保留公开原始岗位表，未推个人资格',attachments:[{name:'实际官方岗位表.xls',mediaType:'application/vnd.ms-excel',contentBase64:bytes.toString('base64')}]});const attachment=saved.attachments[0];assert.equal(attachment.status,'read',attachment.error);assert.deepEqual(app.getAnnouncementAttachment(saved.id,'attachment-1'),bytes);
 const target=attachment.segments.find(s=>s.locator==='sheet:2026年社会招聘岗位需求表/row:32');assert.ok(target);assert.ok(target.text.includes('数据科学岗'));assert.ok(target.text.includes('北京'));assert.ok(target.text.includes('信息安全、计算机科学、软件工程相关专业'));assert.doesNotMatch(target.text,/条件优秀者可适当放宽/);assert.ok(target.cells.some(c=>c.address==='G32'&&c.text==='信息安全、计算机科学、软件工程相关专业'));
 const other=attachment.segments.find(s=>s.locator==='sheet:2026年社会招聘岗位需求表/row:21');assert.ok(other.text.includes('上海'));assert.ok(other.text.includes('条件优秀者可适当放宽'));const merged=attachment.segments[0].cells.find(c=>c.address==='A1');assert.equal(merged.mergedRange,'A1:H1');assert.equal(merged.anchor,'A1');assert.equal(attachment.segments[0].cells.find(c=>c.address==='H1').anchor,'A1');
});

test('附件完整时仅北京唯一行及表头进入加工，普通未知不计来源故障，scheduled接入真实健康合同',async t=>{
 const {existsSync}=await import('node:fs');const {resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??[resolve('.runtime/attachment-venv/bin/python'),resolve('../../.runtime/attachment-venv/bin/python')].find(existsSync);assert.ok(python);
 let failing=false;const calls={count:0},baseProcessor=processor(calls),bytes=readFileSync(new URL('./fixtures/icbc/current-positions.xls',import.meta.url));const app=createApplication(setup(t,{attachmentPython:python,icbcFetch:(url,input)=>failing?Promise.reject(Error('模拟计划来源故障')):new URL(url).pathname.startsWith('/api/v1/chunkserver/')?Promise.resolve(new Response(bytes)):fixtureFetch(url,input),announcementProcessor:{process:async input=>{const table=input.documents.find(d=>d.id==='attachment-1');assert.ok(table);assert.deepEqual(table.segments.map(s=>s.locator),['sheet:2026年社会招聘岗位需求表/row:1','sheet:2026年社会招聘岗位需求表/row:2','sheet:2026年社会招聘岗位需求表/row:32']);assert.doesNotMatch(table.text,/条件优秀者可适当放宽/);const output=await baseProcessor.process(input);output.inputGaps=['部门未单独披露','正式批次未披露','签约主体未披露','5年以上与5年及以上具体认定待核验','其他政策内容未提供'];output.jobs[0].conditions.push({text:'信息安全、计算机科学、软件工程相关专业',evidence:[{documentId:'attachment-1',locator:'sheet:2026年社会招聘岗位需求表/row:32',quote:'信息安全、计算机科学、软件工程相关专业'}]});return output;}}}));t.after(()=>app.close());
 const success=await app.checkIcbcSource({postIds:[current.postId],pageSize:1,trigger:'scheduled',scheduledFor:'2026-10-08T09:00:00+08:00'});assert.equal(success.status,'success',success.error);assert.equal(success.trigger,'scheduled');assert.equal(success.gaps.length,0);assert.ok(success.unknowns.includes('签约主体未披露'));const job=app.getJob(success.jobIds[0]);assert.equal(job.contractingEntity,null);assert.equal(job.sourceEvidence.attachmentConditionsComplete,true);assert.ok(job.conditions.some(c=>c.evidence.some(e=>e.documentId==='attachment-1'&&e.locator.endsWith('/row:32'))));
 assert.equal(app.getSourcesOverview().sources.find(s=>s.id==='icbc-social').health.consecutiveScheduledFailures,0);failing=true;const failed=await app.checkIcbcSource({trigger:'scheduled',scheduledFor:'2026-10-09T09:00:00+08:00'});assert.equal(failed.status,'failed');assert.equal(app.getSourcesOverview().sources.find(s=>s.id==='icbc-social').health.consecutiveScheduledFailures,1);await app.checkIcbcSource();assert.equal(app.getSourcesOverview().sources.find(s=>s.id==='icbc-social').health.consecutiveScheduledFailures,1);assert.equal(app.listJobs().length,1);
});

test('历史北京分行XLS跨行公共资格合并C3:C9随目标行继承，精确完整岗位名定位且保持历史用途',async t=>{
 const {existsSync}=await import('node:fs');const {resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??[resolve('.runtime/attachment-venv/bin/python'),resolve('../../.runtime/attachment-venv/bin/python')].find(existsSync);assert.ok(python);const bytes=readFileSync(new URL('./fixtures/icbc/historical-positions.xls',import.meta.url));const calls={count:0},baseProcessor=processor(calls);
 const app=createApplication(setup(t,{attachmentPython:python,icbcFetch:(url,input)=>new URL(url).pathname.startsWith('/api/v1/chunkserver/')?Promise.resolve(new Response(bytes)):fixtureFetch(url,input),announcementProcessor:{process:async input=>{const table=input.documents.find(d=>d.id==='attachment-1');assert.deepEqual(table.segments.map(s=>s.locator),['sheet:Sheet1/row:1','sheet:Sheet1/row:2','sheet:Sheet1/row:5']);const row=table.segments[2],cell=row.cells.find(c=>c.address==='C5');assert.equal(cell.anchor,'C3');assert.equal(cell.mergedRange,'C3:C9');assert.match(cell.text,/取得国家承认的本科/);const output=await baseProcessor.process(input);output.commonConditions.push({text:cell.text,evidence:[{documentId:'attachment-1',locator:'sheet:Sheet1/row:5',quote:cell.text}]});return output;}}}));t.after(()=>app.close());const run=await app.checkIcbcSource({postIds:[historical.postId],pageSize:1});assert.equal(run.status,'success',run.error);const job=app.getJob(run.jobIds[0]);assert.equal(job.evidenceUse,'historical');assert.equal(job.recruitmentStatus,'ended');assert.ok(job.conditions.some(c=>c.text.includes('取得国家承认的本科')&&c.evidence.some(e=>e.locator==='sheet:Sheet1/row:5')));assert.equal(job.sourceEvidence.attachmentConditionsComplete,true);assert.equal(calls.count,1);
});

test('工行完整列表与公开按钮证据更新公共招聘观察、截止及复核；失败不结束，完整缺失仅疑似下线',async t=>{
 let mode='normal';const calls={count:0};const options=setup(t,{now:()=>new Date('2026-10-08T02:00:00Z'),announcementProcessor:processor(calls),icbcFetch:(url,input)=>{
 if(mode==='failed')return Promise.reject(Error('模拟工行故障'));
 if(mode==='missing'&&url.endsWith('/post/qryPostList'))return Promise.resolve(Response.json({retCode:'0',data:{total:0,dataList:[]}}));
 return fixtureFetch(url,input);
 }});const app=createApplication(options);const first=await app.checkIcbcSource({postIds:[current.postId,historical.postId],pageSize:1});const active=first.jobIds.map(id=>app.getJob(id)).find(j=>j.title===current.publishPostName),old=first.jobIds.map(id=>app.getJob(id)).find(j=>j.title===historical.publishPostName);
 assert.equal(active.recruitment.review.lastDetailCheckedAt,first.checkedAt);assert.equal(active.recruitment.dates.officialDeadline.value,'2026-12-31T15:59:59.000Z');assert.equal(active.recruitmentStatus,'publicly_listed_open');assert.equal(old.recruitmentStatus,'ended');assert.equal(old.evidenceUse,'historical');assert.equal(old.recruitment.history.at(-1).applicationOpen,false);assert.equal(old.recruitment.history.at(-1).explicitEnd,undefined);
 mode='failed';await app.checkIcbcSource({pageSize:1});assert.equal(app.getJob(active.id).recruitmentStatus,'publicly_listed_open');assert.equal(app.getRecruitmentState(active.id).history.at(-1).acquisition,'failed');
 mode='missing';await app.checkIcbcSource({pageSize:1});assert.equal(app.getJob(active.id).recruitmentStatus,'suspected_offline');assert.equal(app.getRecruitmentState(active.id).history.at(-1).listed,false);app.close();const restarted=createApplication(options);t.after(()=>restarted.close());assert.equal(restarted.getJob(active.id).recruitmentStatus,'suspected_offline');assert.equal(restarted.getRecruitmentState(active.id).dates.officialDeadline.value,'2026-12-31T15:59:59.000Z');
});

test('官方公告直接返回HTML实体开头正文时仍保留原文并完成读取',async t=>{
 const app=createApplication(setup(t,{announcementProcessor:processor({count:0}),icbcFetch:async(url,input)=>{
  const response=await fixtureFetch(url,input);
  if(!url.endsWith('/announ/qryAnnounById'))return response;
  const value=await response.json();value.data.content='&nbsp; '+(value.data.content.trim().startsWith('<')?value.data.content:decode(value.data.content));return Response.json(value);
 }}));t.after(()=>app.close());
 const run=await app.checkIcbcSource({postIds:[current.postId],pageSize:1});
 assert.notEqual(run.status,'failed',run.error);assert.equal(run.jobIds.length,1);
 assert.ok(app.getAnnouncement(app.getJob(run.jobIds[0]).announcementId).originalText.includes('报名'));
});

test('自动检查先排除京外岗位，再核对附件行，避免无关岗位阻塞整源',async t=>{
 const {existsSync}=await import('node:fs'),{resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??resolve('.runtime/attachment-venv/bin/python');assert.ok(existsSync(python));const bytes=readFileSync(new URL('./fixtures/icbc/current-positions.xls',import.meta.url));let calls=0;
 const post={...current,publishPostName:'河南分行本部-纪检岗',placeStr:'河南省-郑州市'};
 const app=createApplication(setup(t,{attachmentPython:python,matchingProcessor:null,announcementProcessor:{process:async()=>{calls++;throw Error('不得加工京外岗位');}},icbcFetch:async(url,input)=>{if(url.endsWith('/post/qryPostById'))return Response.json({retCode:'0',data:post});if(new URL(url).pathname.startsWith('/api/v1/chunkserver/'))return new Response(bytes);const r=await fixtureFetch(url,input);if(url.endsWith('/post/qryPostList')){const body=await r.json();body.data.dataList=body.data.dataList.map(x=>x.postId===post.postId?post:x);return Response.json(body);}return r;}}));t.after(()=>app.close());
 const run=await app.withModelBatch(()=>app.checkIcbcSource({postIds:[post.postId],pageSize:1}),{automatic:true});assert.equal(run.status,'success',run.error);assert.equal(calls,0);assert.equal(run.details[0].processingStatus,'scope_excluded');assert.equal(app.listSourceCandidates('icbc-social').find(x=>x.externalId===post.postId).status,'excluded');
});

test('同轮两个岗位共享公告和附件获取，岗位条件独立核验，下一轮重新读取原件',async t=>{
 const bytes=readFileSync(new URL('./fixtures/icbc/current-positions.xls',import.meta.url));
 const second={...current,postId:'00000000000099999999',publishPostName:'软件开发中心（上海）-信息科技类-架构设计岗(知识体系方向)',placeStr:'上海市-浦东新区'};
 const requests=new Map(),inputs=[];
 const {writeFileSync}=await import('node:fs');const directory=mkdtempSync(join(tmpdir(),'jh-reader-count-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const {resolve}=await import('node:path');const python=process.env.JOBHUNTER_ATTACHMENT_PYTHON??resolve('.runtime/attachment-venv/bin/python');
 const reader=join(directory,'reader.py'),count=join(directory,'count');
 writeFileSync(reader,'#!/usr/bin/env python3\nimport os,sys\nwith open('+JSON.stringify(count)+',"a") as f: f.write("read\\n")\nos.execv('+JSON.stringify(python)+',['+JSON.stringify(python)+']+sys.argv[1:])\n',{mode:0o700});
 const app=createApplication(setup(t,{attachmentPython:reader,icbcFetch:async(url,input)=>{
  const key=url+'|'+(input?.body??'');requests.set(key,(requests.get(key)??0)+1);
  const params=input?.body?JSON.parse(input.body).private:{};let data;
  if(url.endsWith('/post/qryPostList'))data={total:2,dataList:[current,second].slice((params.page-1)*params.pageSize,params.page*params.pageSize)};
  else if(url.endsWith('/post/qryPostById'))data=params.postId===current.postId?current:second;
  else if(url.endsWith('/announ/qryAnnounListByPostId'))data=[notices[0]];
  else if(new URL(url).pathname.startsWith('/api/v1/chunkserver/'))return new Response(bytes);
  return data?Response.json({retCode:'0',data}):fixtureFetch(url,input);
 },announcementProcessor:{process:async input=>{inputs.push(input);return {commonConditions:[],inputGaps:[],jobs:[{...input.targetJobs[0],contractingEntity:null,locations:[input.targetJobs[0].title===second.publishPostName?'上海':'北京'],duties:null,conditions:[],evidence:[ref(input.targetJobs[0].title)],applicationPath:null,unknownFields:[],dateEvidence:[]}]};}}}));t.after(()=>app.close());
 const run=await app.checkIcbcSource({postIds:[current.postId,second.postId],pageSize:1});assert.equal(run.status,'success',run.error);assert.equal(inputs.length,2);
 const shared=[...requests].filter(([key])=>key.includes('/announ/qryAnnounById')||key.includes('/api/v1/chunkserver/'));
 assert.equal(readFileSync(count,'utf8'),'read\n');
 assert.equal(shared.length,2);assert.ok(shared.every(([,count])=>count===1),JSON.stringify(shared));
 assert.notDeepEqual(inputs[0].documents.find(x=>x.id==='attachment-1').segments.map(x=>x.locator),inputs[1].documents.find(x=>x.id==='attachment-1').segments.map(x=>x.locator));
 const again=await app.checkIcbcSource({postIds:[current.postId,second.postId],pageSize:1});assert.equal(again.status,'success',again.error);
 assert.ok(shared.every(([key])=>requests.get(key)===2));assert.equal(inputs.length,2);assert.equal(app.listNotificationAttempts().length,0);
});

test('自动检查提前跳过已截止非北京岗位，不因无招聘机构标题或坏附件中止后续技术岗',async t=>{
 let attachments=0,models=0;const past={...historical,publishPostName:'广西分行本部-纪检岗',placeStr:'广西壮族自治区',postDepict:'<p>工作职责：纪检监督</p>'};
 const app=createApplication(setup(t,{now:()=>new Date('2026-10-18T02:00:00Z'),announcementProcessor:{process:async()=>{models++;throw Error('不应加工历史或附件缺失岗位');}},icbcFetch:async(url,input)=>{
  if(url.endsWith('/post/qryPostById')&&JSON.parse(input.body).private.postId===historical.postId)return Response.json({retCode:'0',data:past});
  if(url.endsWith('/post/qryPostList')){const data=await (await fixtureFetch(url,input)).json();data.data.dataList=data.data.dataList.map(x=>x.postId===past.postId?past:x);return Response.json(data);}
  if(url.endsWith('/announ/qryAnnounById')&&JSON.parse(input.body).private.announId===notices[1].announId)return Response.json({retCode:'0',data:{...notices[1],content:'<p>中国工商银行广西分行。招聘纪检岗，截止日期已过。</p>'}});
  if(new URL(url).pathname.startsWith('/api/v1/chunkserver/')){attachments++;return new Response('not found',{status:404});}
  return fixtureFetch(url,input);
 }}));t.after(()=>app.close());
 const run=await app.checkIcbcSource({postIds:[past.postId,current.postId],pageSize:1,trigger:'scheduled',scheduledFor:'2026-10-18T01:00:00Z'});
 assert.equal(run.details.length,2,run.error);assert.notEqual(run.status,'failed',run.error);assert.equal(attachments,1);assert.equal(models,0);
 assert.ok(run.skippedSelections.some(x=>x.externalId===past.postId));
});

test('同轮共享失效附件只请求一次并保留缺口，后续周期重新读取不沿用失败',async t=>{
 const second={...current,postId:'00000000000006161505'};let downloads=0;
 const app=createApplication(setup(t,{now:()=>new Date('2026-10-18T02:00:00Z'),announcementProcessor:null,icbcFetch:async(url,input)=>{
  const path=new URL(url).pathname;
  if(path.startsWith('/api/v1/chunkserver/')){downloads++;return new Response('not found',{status:404});}
  if(path.endsWith('/post/qryPostList')){const page=JSON.parse(input.body).private.page;return Response.json({retCode:'0',data:{total:2,dataList:page===1?[current]:[second]}});}
  if(path.endsWith('/post/qryPostById'))return Response.json({retCode:'0',data:JSON.parse(input.body).private.postId===current.postId?current:second});
  if(path.endsWith('/announ/qryAnnounListByPostId'))return Response.json({retCode:'0',data:[notices[0]]});
  return fixtureFetch(url,input);
 }}));t.after(()=>app.close());
 const input={postIds:[current.postId,second.postId],pageSize:1,trigger:'scheduled',scheduledFor:'2026-10-18T01:00:00Z'};
 const r=await app.checkIcbcSource(input);assert.equal(downloads,1);assert.equal(r.status,'partial');assert.equal(r.gaps.length,1);assert.equal(r.attachmentsChecked,0);
 await app.checkIcbcSource(input);assert.equal(downloads,2);
});
