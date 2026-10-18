import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
function setup(t) { const dir=mkdtempSync(join(tmpdir(),'jh-health-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {databasePath:join(dir,'data.sqlite'),now:()=>new Date('2026-10-07T01:00:00Z'),announcementProcessor:{process:async()=>{throw Error('模型不可调用');}}}; }
const failed=(id,time,trigger='scheduled')=>({id,sourceId:'efunds-social',status:'failed',checkedAt:time,trigger,scheduledFor:trigger==='scheduled'?time:null,stage:'list',error:'模拟列表获取失败',listCount:15,listComplete:false,pages:[{}],details:[],attachmentsChecked:0,gaps:['分页未完成']});
test('纳入51对象、4+1起点与EF扩展分开；未检查不冒充成功或已接入',t=>{
 const app=createApplication(setup(t));t.after(()=>app.close());const overview=app.getSourcesOverview();
 assert.equal(overview.monitoringObjects.length,51);assert.deepEqual(overview.counts,{included:51,implemented:6,successful:0,initialMonitoringObjects:4,discoveryEntrypoints:1});
 assert.equal(overview.sources.find(x=>x.id==='beijing-sasac').kind,'discovery');assert.equal(overview.sources.find(x=>x.id==='boc-social').implemented,true);assert.equal(overview.sources.find(x=>x.id==='efunds-social').latest,null);assert.ok(overview.monitoringObjects.some(x=>x.name==='中移九天相关招聘主体'));
});
test('首次失败即时可见，两个不同计划时刻失败产生一个事件；重启/重复/手动失败不制造连败，计划恢复可追溯',t=>{
 const options=setup(t);let app=createApplication(options);
 app.recordSourceCheck(failed('manual','2026-10-07T00:00:00Z','manual'));assert.equal(app.listSourceHealthEvents().length,0);
 app.recordSourceCheck(failed('one','2026-10-07T01:00:00Z'));assert.equal(app.listSourceHealthEvents().length,0);assert.match(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').latest.error,/列表获取失败/);
 app.recordSourceCheck(failed('repeat-slot','2026-10-07T01:00:00Z'));assert.equal(app.listSourceHealthEvents().length,0);
 app.close();app=createApplication(options);t.after(()=>app.close());
 app.recordSourceCheck(failed('two','2026-10-08T01:00:00Z'));const event=app.listSourceHealthEvents()[0];assert.equal(event.type,'source_persistent_failure');assert.equal(event.status,'active');assert.equal(event.notificationStatus,'pending');assert.equal(event.failureCount,2);
 app.recordSourceCheck(failed('two','2026-10-08T01:00:00Z'));app.recordSourceCheck(failed('three','2026-10-09T01:00:00Z'));assert.equal(app.listSourceHealthEvents().length,1);assert.equal(app.listSourceHealthEvents()[0].failureCount,3);
 app.recordSourceCheck({id:'recover',sourceId:'efunds-social',status:'success',trigger:'scheduled',scheduledFor:'2026-10-10T01:00:00.000Z',checkedAt:'2026-10-10T01:00:00.000Z',listComplete:true,listCount:130,pages:Array(9).fill({}),details:[{}],attachmentsChecked:0,gaps:[]});
 const source=app.getSourcesOverview().sources.find(x=>x.id==='efunds-social');assert.equal(source.lastSuccessfulAt,'2026-10-10T01:00:00.000Z');assert.equal(source.latest.details.length,1);assert.equal(source.health.consecutiveScheduledFailures,0);assert.equal(app.listSourceHealthEvents()[0].status,'recovered');assert.equal(app.listSourceHealthEvents()[0].recoveredAt,'2026-10-10T01:00:00.000Z');
 app.recordSourceCheck(failed('late','2026-10-06T01:00:00Z'));assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').latest.id,'recover');assert.equal(app.listSourceHealthEvents().length,1);
});
test('持久详情选择重启保留、显式当次选择不改设置，真实适配失败自动记健康；受控计划与手动区分',async t=>{
 const target='62fd32a72f9d2421b983ae01',other='62fd32a72f9d2421b983ae02';const options={...setup(t),sourceFetch:async()=>{throw Error('模拟网络不可达');}};let app=createApplication(options);
 app.setSourceSettings('efunds-social',{postIds:[other]});assert.deepEqual(app.getSourceSettings('efunds-social').postIds,[other]);app.close();app=createApplication(options);t.after(()=>app.close());
 assert.deepEqual(app.getSourceSettings('efunds-social').postIds,[other]);
 const manual=await app.checkEfundsSource({postIds:[target]});assert.equal(manual.trigger,'manual');assert.deepEqual(manual.selectedPostIds,[target]);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').latest.id,manual.id);assert.equal(app.listSourceHealthEvents().length,0);assert.deepEqual(app.getSourceSettings('efunds-social').postIds,[other]);
 const first=await app.runSourceCheck('efunds-social',{scheduledFor:'2026-10-07T01:00:00Z'});assert.deepEqual(first.selectedPostIds,[other]);assert.equal(first.trigger,'scheduled');await app.runSourceCheck('efunds-social',{scheduledFor:'2026-10-08T01:00:00Z'});assert.equal(app.listSourceHealthEvents().length,1);
 assert.throws(()=>app.setSourceSettings('efunds-social',{postIds:['bad']}),/岗位ID/);assert.deepEqual(app.getSourceSettings('efunds-social').postIds,[other]);
 assert.throws(()=>app.registerSource({id:'invented',name:'未知',monitoringObjectIds:['seed-999'],kind:'recruitment',scope:'未知'}),/监控对象/);
 app.registerSource({id:'boc-social',name:'中国银行',monitoringObjectIds:['seed-01'],kind:'recruitment',scope:'栏目和选中公告'});assert.equal(app.getSourcesOverview().counts.implemented,6);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='boc-social').lastSuccessfulAt,null);
});
test('Web及HTTP展示完整列表与选中详情/附件缺口、最近成功及首次错误，保存选择不伪造计划失败',async t=>{
 const {startServer}=await import('../src/server.mjs');const app=createApplication({...setup(t),sourceFetch:async()=>{throw Error('模拟来源首次失败');}});const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const html=await(await fetch(base+'/sources')).text();assert.match(html,/51 个目标/);assert.match(html,/5 个已接入/);assert.match(html,/北京国资委.*发现入口/);assert.match(html,/中移九天相关招聘主体/);
 const other='62fd32a72f9d2421b983ae02';const saved=await fetch(base+'/api/sources/efunds/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postIds:[other]})});assert.equal(saved.status,200);assert.deepEqual((await saved.json()).postIds,[other]);
 const response=await fetch(base+'/api/sources/efunds/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trigger:'scheduled',scheduledFor:'2026-10-07T01:00:00Z'})});assert.equal(response.status,200);assert.equal((await response.json()).trigger,'manual');assert.equal(app.listSourceHealthEvents().length,0);assert.match(await(await fetch(base+'/sources')).text(),/模拟来源首次失败/);
 app.registerSource({id:'boc-social',name:'中国银行',monitoringObjectIds:['seed-01'],kind:'recruitment',scope:'官网栏目、选中公告和附件'});
 app.recordSourceCheck({id:'boc-partial',sourceId:'boc-social',checkedAt:'2026-10-07T02:00:00Z',status:'partial',catalogCount:349,catalogComplete:true,catalogPages:Array(18).fill({}),platformListComplete:false,platformJobs:[],platformPages:[],announcements:[{attachments:[{status:200}]}],gaps:['指定平台列表未取得']});
 const page=await(await fetch(base+'/sources')).text();assert.match(page,/栏目349项/);assert.match(page,/18页/);assert.match(page,/选中公告1项/);assert.match(page,/附件取得1项/);assert.match(page,/指定平台列表未取得/);assert.match(page,/部分完成/);assert.doesNotMatch(page,/全部正常/);
 const overview=await(await fetch(base+'/api/sources')).json();assert.equal(overview.counts.implemented,6);assert.equal(overview.counts.successful,0);assert.equal(overview.sources.find(x=>x.id==='boc-social').lastSuccessfulAt,null);
});
test('部分覆盖不计完整成功，来源登记/计划上下文严格校验，恢复后的待发故障失效且新一轮故障另记',t=>{
 const app=createApplication(setup(t));t.after(()=>app.close());assert.throws(()=>app.recordSourceCheck({...failed('invalid','2026-10-07T01:00:00Z'),scheduledFor:'2026-10-07 09:00'}),/时区/);assert.equal(app.listSourceHealthEvents().length,0);
 assert.throws(()=>app.registerSource({id:'discovery-test',name:'发现入口',scope:'列表',kind:'discovery',monitoringObjectIds:['seed-01']}),/不计/);
 app.recordSourceCheck({...failed('partial-one','2026-10-07T01:00:00Z'),status:'partial',listComplete:true});app.recordSourceCheck({...failed('partial-two','2026-10-08T01:00:00Z'),status:'success',listComplete:true,gaps:['附件未取得']});assert.equal(app.getSourcesOverview().counts.successful,0);assert.equal(app.listSourceHealthEvents().length,1);assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').latest.status,'partial');
 app.recordSourceCheck({id:'ok',sourceId:'efunds-social',status:'success',trigger:'scheduled',checkedAt:'2026-10-09T01:00:00Z',scheduledFor:'2026-10-09T01:00:00Z',gaps:[]});assert.equal(app.listSourceHealthEvents()[0].notificationStatus,'cancelled_on_recovery');
 app.recordSourceCheck(failed('new-one','2026-10-10T01:00:00Z'));app.recordSourceCheck(failed('new-two','2026-10-11T01:00:00Z'));assert.equal(app.listSourceHealthEvents().length,2);assert.equal(app.listSourceHealthEvents().filter(x=>x.status==='active').length,1);assert.throws(()=>app.recordSourceCheck({...failed('new-two','2026-10-11T01:00:00Z'),error:'另一份证据'}),/另一份/);
});
test('两轮计划完整取得列表/详情后Codex失败，单独跟踪加工问题，不生成网站故障事件',async t=>{
 const {readFileSync}=await import('node:fs');const target='62fd32a72f9d2421b983ae01';const detail=JSON.parse(readFileSync(new URL(`./fixtures/efunds-source/detail-${target}.json`,import.meta.url))).data;
 const sourceFetch=async(url)=>{
  if(url==='https://job.efunds.com.cn/')return new Response('',{status:302,headers:{location:'https://wecruit.hotjob.cn/SU67ac68866202cc7916aea66e/pb/index.html'}});
  if(url.includes('/listPositionDetail/'))return Response.json({state:'200',data:detail});
  if(url.includes('/listPosition/'))return Response.json({state:'200',data:{pageForm:{currentPage:1,totalPage:1,pageSize:10,dataCount:1,pageData:[{postId:target,postName:detail.postName,recruitType:2}]}}});
  return new Response(url.includes('posDetail')?'<script src="/pb/js/posDetail.js"></script>':'<script src="/pb/js/social.js"></script>');
 };let time='2026-10-07T01:00:00Z';const app=createApplication({...setup(t),now:()=>new Date(time),sourceFetch,announcementProcessor:{process:async()=>{throw Error('模拟Codex加工失败');}}});t.after(()=>app.close());
 await app.runSourceCheck('efunds-social',{scheduledFor:time});time='2026-10-08T01:00:00Z';await app.runSourceCheck('efunds-social',{scheduledFor:time});
 const source=app.getSourcesOverview().sources.find(x=>x.id==='efunds-social');assert.equal(source.latest.listComplete,true);assert.equal(source.latest.listCount,1);assert.equal(source.latest.details.length,1);assert.equal(source.latest.status,'failed');assert.equal(source.latest.failureCategory,'processing');assert.equal(app.listSourceHealthEvents().length,0);assert.equal(source.health.consecutiveScheduledFailures,0);assert.equal(app.listProcessingIssues().filter(x=>x.status==='failed').length,1);
 const {startServer}=await import('../src/server.mjs');const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const html=await(await fetch(`http://127.0.0.1:${server.address().port}/sources`)).text();assert.match(html,/加工异常/);assert.match(html,/分页数量核对完整/);assert.match(html,/选中详情1项/);assert.doesNotMatch(html,/网站不可用|网络故障/);assert.equal(app.listJobs().length,0);assert.ok(app.listAnnouncements()[0].originalText.includes(detail.serviceCondition));
});

test('来源健康持有详情复查覆盖元数据，补充回执不重计计划失败并重启保留',t=>{
 const options=setup(t);let app=createApplication(options);
 const run=app.recordSourceCheck(failed('review-metadata','2026-10-07T01:00:00Z'));
 const metadata={reviewPendingCount:2,reviewSelected:[{externalId:'selected'}],reviewDeferred:[{externalId:'deferred'}],reviewDeferredPostIds:['deferred'],listOnly:false};
 app.recordSourceReviewMetadata(run.id,metadata);
 let source=app.getSourcesOverview().sources.find(x=>x.id===run.sourceId);
 assert.equal(source.latest.reviewDeferred.length,1);assert.equal(source.latest.status,'failed');assert.equal(source.latest.failureCategory,'pagination');
 assert.equal(source.health.consecutiveScheduledFailures,1);assert.equal(app.listSourceHealthEvents().length,0);
 assert.throws(()=>app.recordSourceReviewMetadata(run.id,{status:'success'}),/复查元数据/);
 app.close();app=createApplication(options);t.after(()=>app.close());
 source=app.getSourcesOverview().sources.find(x=>x.id===run.sourceId);
 assert.deepEqual(source.latest.reviewDeferredPostIds,['deferred']);assert.equal(source.health.consecutiveScheduledFailures,1);
});

test('来源总览折叠证据入口保留全部六源详细页，GET不检查外部来源', async t => {
  const { startServer } = await import('../src/server.mjs');
  let calls = 0;
  const blocked = async () => { calls++; throw Error('本票禁止真实外部接入'); };
  const app = createApplication({ ...setup(t), announcementProcessor: null, matchingProcessor: null,
    sourceFetch: blocked, ccbSourceFetch: blocked, icbcFetch: blocked, cmriFetch: blocked, sasacFetch: blocked,
    careerSource: null, notificationTransport: null });
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/sources')).text();
  const folded = [...html.matchAll(/<details><summary>[^<]+ · 采集选择[\s\S]*?<\/details>/g)].map(match => match[0]);
  for (const [alias, label] of [['boc', '中国银行详细来源证据'], ['ccb', '建设银行详细来源证据'],
    ['icbc', '工行详细来源证据'], ['cmri', '研究院详细来源证据'], ['sasac', '北京国资委详细来源证据'], ['efunds', '易方达详细来源证据']]) {
    assert.ok(folded.some(section => section.includes(`href="/sources/${alias}"`) && section.includes('原文与完整检查历史')), `${alias}证据入口须可从来源卡片展开`);
    assert.equal((await fetch(base + '/sources/' + alias)).status, 200);
  }
  assert.match(html, /尚无检查证据，不计成功覆盖/);
  assert.equal(calls, 0);
  assert.equal(app.listNotificationAttempts().length, 0);
});

test('来源成功标签按实际列表详情和保存岗位分开，空列表及后续失败不冒称加工', async t => {
  const {startServer}=await import('../src/server.mjs');let externalCalls=0;
  const blocked=async()=>{externalCalls++;throw Error('展示回归禁止外呼');};
  const app=createApplication({...setup(t),announcementProcessor:null,matchingProcessor:null,careerSource:null,
    notificationTransport:null,sourceFetch:blocked,ccbSourceFetch:blocked,icbcFetch:blocked,cmriFetch:blocked,sasacFetch:blocked});
  const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const saved=app.createJob({title:'模拟已保存加工岗位',originalText:'模拟来源原文，历史保存保护'});app.setApplied(saved.id,true);
  for(const run of [
    {sourceId:'boc-social',catalogCount:3,catalogComplete:true,catalogPages:[{}],platformListComplete:true,platformJobs:[],platformPages:[{}],announcements:[],platformDetails:[],listOnly:true,jobIds:[]},
    {sourceId:'ccb-social',listCount:2,listComplete:true,pages:[{}],details:[],announcements:[],jobIds:[]},
    {sourceId:'cmri-social',listCount:0,listComplete:true,pages:[{}],details:[],listOnly:true,jobIds:[]},
    {sourceId:'icbc-social',listCount:1,listComplete:true,pages:[{}],details:[{}],jobIds:[]},
    {sourceId:'beijing-sasac',details:[],jobIds:[]},
    {sourceId:'efunds-social',listCount:1,listComplete:true,pages:[{}],details:[{}],jobIds:[saved.id]}
  ]) app.recordSourceCheck({id:run.sourceId+'-display',checkedAt:'2026-10-08T01:00:00Z',status:'success',gaps:[],...run});
  const card=(html,name)=>[...html.matchAll(/<div data-source-evidence="[^"]+">([\s\S]*?)<\/div>/g)].map(x=>x[1]).find(x=>x.includes(`<h3>${name}</h3>`));
  const html=await(await fetch(base+'/sources')).text();const sources=app.getSourcesOverview().sources;
  for(const id of ['boc-social','ccb-social','cmri-social']){
    const section=card(html,sources.find(x=>x.id===id).name);assert.ok(section);
    assert.match(section,/列表检查成功/);assert.match(section,/未选择详情/);assert.doesNotMatch(section,/检查及选中岗位加工成功/);
    if(id==='cmri-social') assert.match(section,/列表0项/);
  }
  const acquired=card(html,sources.find(x=>x.id==='icbc-social').name);
  assert.match(acquired,/尚无已保存加工岗位/);assert.doesNotMatch(acquired,/检查及选中岗位加工成功/);
  const unknown=card(html,sources.find(x=>x.id==='beijing-sasac').name);
  assert.match(unknown,/列表及详情加工覆盖未记录/);assert.doesNotMatch(unknown,/列表检查成功|检查及选中岗位加工成功/);
  assert.match(card(html,sources.find(x=>x.id==='efunds-social').name),/检查及选中岗位加工成功/);
  app.recordSourceCheck({id:'boc-processed-display',sourceId:'boc-social',checkedAt:'2026-10-08T02:00:00Z',status:'success',catalogCount:3,catalogComplete:true,catalogPages:[{}],platformListComplete:true,platformJobs:[{}],platformPages:[{}],announcements:[],platformDetails:[{}],jobIds:[saved.id],gaps:[]});
  assert.match(card(await(await fetch(base+'/sources')).text(),sources.find(x=>x.id==='boc-social').name),/检查及选中岗位加工成功/);
  app.recordSourceCheck({id:'efunds-display-failure',sourceId:'efunds-social',checkedAt:'2026-10-08T03:00:00Z',status:'failed',stage:'detail',details:[],jobIds:[],gaps:['模拟详情失败'],error:'模拟详情失败<script>'});
  const failedHtml=await(await fetch(base+'/sources')).text();assert.match(failedHtml,/检查或加工失败/);assert.match(failedHtml,/模拟详情失败&lt;script&gt;/);
  assert.equal(app.getJob(saved.id).originalText,'模拟来源原文，历史保存保护');assert.equal(app.getPersonalState(saved.id).applied,true);
  assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').history.length,2);assert.equal(externalCalls,0);
});
