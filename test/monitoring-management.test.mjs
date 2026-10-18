import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
function setup(t,extra={}){const dir=mkdtempSync(join(tmpdir(),'jh-monitors-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {databasePath:join(dir,'data.sqlite'),now:()=>new Date('2026-10-08T01:00:00Z'),announcementProcessor:{process:async()=>{throw Error('禁止模型');}},matchingProcessor:{process:async()=>{throw Error('禁止模型');}},careerSource:null,...extra};}
test('本人新增编辑暂停及移出目标重启保留，名称和入口不冒充来源接入或集团子公司认可',t=>{
 const options=setup(t);let app=createApplication(options);
 const target=app.createMonitoringObject({name:'演示集团',officialUrl:'https://example.org/jobs',note:'只认可该主体'});
 assert.equal(target.monitoringStatus,'active');assert.equal(target.integrationStatus,'pending');assert.deepEqual(target.sourceIds,[]);
 assert.equal(app.getSourcesOverview().counts.implemented,6);assert.equal(app.getSourcesOverview().counts.included,52);
 app.updateMonitoringObject(target.id,{name:'演示集团本体',monitoringStatus:'paused'});
 app.close();app=createApplication(options);t.after(()=>app.close());
 const paused=app.listMonitoringObjects().find(x=>x.id===target.id);assert.equal(paused.name,'演示集团本体');assert.equal(paused.monitoringStatus,'paused');assert.equal(paused.integrationStatus,'pending');
 app.updateMonitoringObject(target.id,{monitoringStatus:'removed'});
 assert.equal(app.listMonitoringObjects().find(x=>x.id===target.id).monitoringStatus,'removed');assert.equal(app.getSourcesOverview().counts.included,51);
 assert.throws(()=>app.createMonitoringObject({name:'另一目标',sourceIds:['efunds-social']}),/字段|关联/);
 assert.throws(()=>app.updateMonitoringObject('seed-01',{monitoringStatus:'invented'}),/状态/);
 assert.throws(()=>app.createMonitoringObject({name:'',officialUrl:'file:///tmp/no'}),/名称|链接/);
 assert.equal(app.listMonitoringObjects().find(x=>x.id==='seed-39').integrationStatus,'implemented');
});
test('暂停及移出对象不再采集或后台匹配，已取得岗位、关注、投递及运行历史仍可读',async t=>{
 let externalCalls=0;const forbidden=async()=>{externalCalls++;throw Error('受控外部来源');};
 const options=setup(t,{sourceFetch:forbidden,ccbSourceFetch:forbidden,icbcFetch:forbidden,cmriFetch:forbidden,sasacFetch:forbidden});let app=createApplication(options);
 const job=app.importJob({title:'演示已存岗',recruitmentUnit:'中国银行',originalText:'演示证据',sourceIdentity:{sourceId:'boc-social',externalId:'62fd32a72f9d2421b983ae01'},observedAt:'2026-10-08T01:00:00Z'}).job;
 app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);app.saveCareerProfile({sourceId:'manual',version:'demo',text:'演示职业资料'});
 app.recordSourceCheck({id:'before-pause',sourceId:'boc-social',status:'success',trigger:'manual',checkedAt:'2026-10-07T01:00:00Z',gaps:[]});
 for(const id of ['seed-01','seed-02','seed-04','seed-23','seed-39'])app.updateMonitoringObject(id,{monitoringStatus:id==='seed-02'?'removed':'paused'});
 const skipped=await app.runSourceCheck('boc-social',{scheduledFor:'2026-10-08T01:00:00Z'});assert.equal(skipped.status,'paused');assert.equal(externalCalls,0);
 const direct=await app.checkBocSource();assert.equal(direct.status,'paused');assert.equal(externalCalls,0);
 const cycle=await app.runScheduledCycle();assert.equal(externalCalls,1); // 独立国资委发现入口仍可采集
 assert.equal(cycle.sources.find(x=>x.sourceId==='boc-social').status,'paused');assert.equal(cycle.jobs.considered,0);assert.equal(app.getMatch(job.id),null);
 assert.ok(app.listRecruitmentReviewPlan().filter(x=>x.sourceId==='boc-social').every(x=>x.due===false&&x.monitoringBlocked));
 const runId=cycle.id;app.close();app=createApplication(options);t.after(()=>app.close());
 assert.equal(app.getJob(job.id).title,'演示已存岗');assert.equal(app.getPersonalState(job.id).followed,true);assert.equal(app.getPersonalState(job.id).applied,true);
 assert.equal(app.getScheduledRun(runId).sources.find(x=>x.sourceId==='boc-social').status,'paused');assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='boc-social').history[0].id,'before-pause');
});
test('共享来源继续发现活跃对象，已暂停对象及无法核定范围的候选不读详情不调用模型',async t=>{
 const activeId='62fd32a72f9d2421b983ae01',inactiveId='62fd32a72f9d2421b983ae02',unknownId='62fd32a72f9d2421b983ae03';let details=[],models=0;
 const sourceFetch=async (url,options)=>{
  if(url==='https://job.efunds.com.cn/')return new Response('',{status:302,headers:{location:'https://wecruit.hotjob.cn/SU67ac68866202cc7916aea66e/pb/index.html'}});
  if(url.includes('/listPositionDetail/')){details.push(new URLSearchParams(options.body).get('postId'));throw Error('演示详情暂不可读');}
  if(url.includes('/listPosition/'))return Response.json({state:'200',data:{pageForm:{currentPage:1,totalPage:1,pageSize:10,dataCount:3,pageData:[activeId,inactiveId,unknownId].map(postId=>({postId,postName:'演示共享列表',recruitType:2}))}}});
  return new Response('<script src="/pb/js/social.js"></script>');
 };const app=createApplication(setup(t,{sourceFetch,announcementProcessor:{process:async()=>{models++;throw Error('禁止模型');}}}));t.after(()=>app.close());
 app.registerSource({id:'efunds-social',name:'演示共享官方入口',kind:'recruitment',scope:'演示明确双对象映射',monitoringObjectIds:['seed-01','seed-39']});
 const active=app.importJob({title:'演示活跃对象岗',recruitmentUnit:'中国银行',originalText:'演示公开证据',sourceIdentity:{sourceId:'efunds-social',externalId:activeId},observedAt:'2026-10-08T01:00:00Z'}).job;
 const paused=app.importJob({title:'演示暂停对象岗',recruitmentUnit:'易方达基金',originalText:'演示公开证据',sourceIdentity:{sourceId:'efunds-social',externalId:inactiveId},observedAt:'2026-10-08T01:00:00Z'}).job;
 app.setSourceSettings('efunds-social',{postIds:[activeId,inactiveId,unknownId]});app.updateMonitoringObject('seed-39',{monitoringStatus:'paused'});
 const run=await app.checkDueRecruitmentDetails({sourceId:'efunds-social'});assert.equal(run.listCount,3);assert.deepEqual(details,[activeId]);assert.equal(models,0);
 const plan=app.listRecruitmentReviewPlan();assert.equal(plan.find(x=>x.jobId===active.id).monitoringBlocked,undefined);assert.equal(plan.find(x=>x.jobId===paused.id).due,false);assert.match(plan.find(x=>x.selectionId===unknownId).monitoringReason,/范围待核验/);
 details=[];await app.checkEfundsSource({postIds:[inactiveId,unknownId]});assert.deepEqual(details,[]);assert.equal(models,0);
 assert.equal(app.getSourcesOverview().sources.find(x=>x.id==='efunds-social').monitoring.enabled,true);
});
test('HTTP目标管理可新增编辑暂停移出，来源页默认展示机构与人可读运行状态而非技术表单或JSON',async t=>{
 const {startServer}=await import('../src/server.mjs');const app=createApplication(setup(t));const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const add=await fetch(base+'/api/monitoring-objects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'演示<目标>',officialUrl:'https://example.org/jobs'})});assert.equal(add.status,201);const saved=await add.json();assert.equal(saved.integrationStatus,'pending');
 const edit=await fetch(base+'/monitoring-objects/'+saved.id,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name:'演示<修改>',officialUrl:'https://example.org/recruitment',note:'明确本体',monitoringStatus:'paused'}),redirect:'manual'});assert.equal(edit.status,303);
 const overview=await(await fetch(base+'/api/monitoring-objects')).json();assert.equal(overview.find(x=>x.id===saved.id).monitoringStatus,'paused');
 const html=await(await fetch(base+'/sources')).text();assert.match(html,/目标机构管理/);assert.match(html,/新增目标机构/);assert.match(html,/演示&lt;修改&gt;/);assert.match(html,/待接入/);assert.match(html,/已暂停/);assert.match(html,/运行概览/);assert.match(html,/暂无后台信号/);
 assert.doesNotMatch(html,/<pre>/);assert.match(html,/高级采集选择/);
 const remove=await fetch(base+'/api/monitoring-objects/'+saved.id,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"monitoringStatus":"removed"}'});assert.equal(remove.status,200);assert.equal((await remove.json()).monitoringStatus,'removed');
 assert.equal((await fetch(base+'/api/monitoring-objects/'+saved.id,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"sourceIds":["efunds-social"]}'})).status,400);
 assert.equal((await fetch(base+'/api/monitoring-objects',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.org'},body:'{"name":"跨站写入"}'})).status,403);
});
test('独立发现入口仍跟踪已明确活跃机构的岗位，暂停另一机构不阻断其后台匹配，未知机构保持范围待核验',async t=>{
 const forbidden=async()=>{throw Error('演示外部来源不可用');};
 const activeUrl='https://gzw.beijing.gov.cn/yggq/gqzp/202610/t20261008_123.html',unknownUrl='https://gzw.beijing.gov.cn/yggq/gqzp/202610/t20261008_124.html';const requested=[];
 const sasacFetch=async url=>{requested.push(url);return new Response(url==='https://gzw.beijing.gov.cn/yggq/gqzp/'?`<div class="public_list_team"><ul>${[activeUrl,unknownUrl].map(link=>`<li><a href="${link}" title="演示社会招聘">演示社会招聘</a><span>2026-10-08</span></li>`).join('')}</ul></div><script>var currentPage=0;var countPage=1;</script>`:`<div id="div_zhengwen">演示社会招聘公告：中国银行已经明确的岗位条件及公开职责在此保留，另一主体的具体范围仍需核对，不以整篇公告自动认可所有招聘主体。</div>`);};
 const app=createApplication(setup(t,{sourceFetch:forbidden,ccbSourceFetch:forbidden,icbcFetch:forbidden,cmriFetch:forbidden,sasacFetch,matchingProcessor:{match:async({job})=>{const dimension={level:'unknown',explanation:'演示证据不足',directExperiences:[],transferableAbilities:[],gaps:['演示不足'],jobQuotes:[job.originalText]};return {technical:dimension,business:dimension,scope:dimension,route:'uncertain',routeExplanation:'演示待核验',uncertainties:['演示']};}}}));t.after(()=>app.close());
 const active=app.importJob({title:'演示算法活跃公告岗',recruitmentUnit:'中国银行',originalText:'演示公告证据',location:{options:['北京'],confirmed:null,note:null},sourceIdentity:{sourceId:'beijing-sasac',externalId:'https://gzw.beijing.gov.cn/yggq/gqzp/202610/t20261008_123.html#job1'},observedAt:'2026-10-08T01:00:00Z'}).job;
 const unknown=app.importJob({title:'演示未核定主体',recruitmentUnit:'某集团未认可子公司',originalText:'演示证据',sourceIdentity:{sourceId:'beijing-sasac',externalId:'https://gzw.beijing.gov.cn/yggq/gqzp/202610/t20261008_124.html#job1'},observedAt:'2026-10-08T01:00:00Z'}).job;
 app.recordRecruitmentObservation(active.id,{sourceId:'beijing-sasac',externalId:activeUrl+'#job1',observedAt:'2026-10-08T01:00:00Z',acquisition:'success',listComplete:true,listed:true,applicationOpen:true,evidence:{url:activeUrl,text:'模拟北京开放',quote:'模拟北京开放'}});
 app.updateMonitoringObject('seed-39',{monitoringStatus:'paused'});
 assert.equal(app.isJobMonitoringEnabled(active.id),true);assert.equal(app.isJobMonitoringEnabled(unknown.id),false);
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.jobId===active.id).due,true);
 assert.equal(app.listRecruitmentReviewPlan().find(x=>x.jobId===unknown.id).due,false);
 const scopeRun=await app.checkSasacSource({articleUrls:[activeUrl,unknownUrl]});assert.equal(scopeRun.bodyCount,1);assert.equal(scopeRun.processingScopeLimited,true);assert.equal(scopeRun.jobIds.length,0);assert.equal(requested.includes(unknownUrl),false);assert.match(app.getSourcesOverview().sources.find(source=>source.id==='beijing-sasac').latest.monitoringGaps.join('；'),/逐岗位范围/);
 app.saveCareerProfile({sourceId:'manual',version:'demo-discovery',text:'演示职业事实'});
 await app.runScheduledCycle();assert.equal(app.getMatch(active.id).status,'completed');assert.equal(app.getMatch(unknown.id),null);
});
test('发现入口独立暂停不外呼；用户链接不替换已核验入口，恢复不立即检查',async t=>{
 let calls=0;const app=createApplication(setup(t,{sasacFetch:async()=>{calls++;throw Error('controlled');}}));t.after(()=>app.close());
 assert.equal(typeof app.setDiscoveryMonitoring,'function');
 const before=app.listMonitoringObjects().find(x=>x.id==='seed-39').recruitmentEntries;
 assert.ok(before.some(x=>x.url==='https://job.efunds.com.cn/'));
 app.updateMonitoringObject('seed-39',{officialUrl:'https://example.org/clue'});
 assert.deepEqual(app.listMonitoringObjects().find(x=>x.id==='seed-39').recruitmentEntries,before);
 app.setDiscoveryMonitoring('beijing-sasac',false);assert.equal((await app.checkSasacSource()).status,'paused');assert.equal(calls,0);
 app.setDiscoveryMonitoring('beijing-sasac',true);assert.equal(calls,0);
});
