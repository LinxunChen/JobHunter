import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application.mjs';
async function fixture(t,externalPostId){
 const id='6accefe8f0cfabf2b4ed6480',row={postId:id,postName:'模拟软件研发专家',company:'天翼云科技有限公司',recruitType:2,currentSuiteKey:'62b185f42f9d24458d716272'};
 let models=0;
 const app=createApplication({databasePath:':memory:',expandedSources:true,matchingProcessor:null,announcementProcessor:{process:async()=>{models++;throw Error('禁止模型');}},sourceFetch:async(url,options)=>{
  if(!String(url).includes('/wecruit/'))return new Response('/mc/js/index.js');
  const query=new URLSearchParams(options.body);assert.equal(query.get('recruitType'),'2');
  return Response.json({state:'200',data:String(url).includes('listPositionDetail')?{...row,externalPostId,workContent:'研发软件平台',serviceCondition:'本科以上',canDelivery:true,workPlaceList:[{name:'上海市'}]}:{pageForm:{totalPage:1,pageSize:50,currentPage:1,dataCount:1,pageData:[row]}}});
 }});t.after(()=>app.close());const run=await app.checkExpanded_ctyun_social({postIds:[id]});assert.equal(models,0);assert.equal(app.listNotificationAttempts().length,0);return run;
}
test('采用官方详情的强身份桥接编号，社招入口避开未配置的展示套件',async t=>{
 const run=await fixture(t,'280002');assert.equal(run.status,'success');assert.equal(run.details[0].applicationUrl,'https://www.hotjob.cn/wt/ecloud/mobweb/v8/position/detail?recruitType=2&postIdsAry=280002&brandCode=1');assert.match(run.details[0].originalText,/投递入口：https:\/\/wecruit\.hotjob\.cn/);assert.equal(run.details[0].url,'https://wecruit.hotjob.cn/SU62b185f42f9d24458d716272/mc/position/detail?postId=6accefe8f0cfabf2b4ed6480&recruitType=society');
});
test('没有跨系统官方编号时不虚构替代岗位地址',async t=>{const run=await fixture(t,undefined);assert.notEqual(run.status,'success');assert.equal(run.details.length,0);});
test('异常跨系统编号不能注入查询参数或混淆岗位身份',async t=>{const run=await fixture(t,'280002&postIdsAry=111');assert.notEqual(run.status,'success');assert.equal(run.details.length,0);});


test('存量入口用有依据的纠正覆盖，三页生效且原件、个人及投递历史保留',async t=>{
 const oldUrl='https://wecruit.hotjob.cn/SU62b185f42f9d24458d716272/mc/position/detail?postId=6accefe8f0cfabf2b4ed6480&recruitType=society',url='https://www.hotjob.cn/wt/ecloud/mobweb/v8/position/detail?recruitType=2&postIdsAry=280002&brandCode=1';
 const app=createApplication({databasePath:':memory:',announcementProcessor:null,matchingProcessor:null,careerSource:null});t.after(()=>app.close());
 const job=app.createJob({title:'模拟入口修复',originalText:'模拟原始招聘信息',sourceUrl:oldUrl,applicationPath:{kind:'direct',url:oldUrl}});app.setPersonalState(job.id,{followed:true});app.setApplied(job.id,true);
 const source=app.getSourceJob(job.id),personal=app.getPersonalState(job.id),applications=app.listApplications(job.id),notifications=app.listNotificationAttempts();
 app.correctJob(job.id,{field:'applicationPath',value:{kind:'direct',url,loginRequired:true},basis:{reason:'官方详情强身份桥接；网页已实测',sourceUrl:url}});
 assert.equal(app.getJob(job.id).applicationPath.url,url);assert.deepEqual(app.getSourceJob(job.id),source);assert.deepEqual(app.getPersonalState(job.id),personal);assert.deepEqual(app.listApplications(job.id),applications);assert.deepEqual(app.listNotificationAttempts(),notifications);
 const {startServer}=await import('../src/server.mjs');const server=await startServer({app,port:0});t.after(()=>new Promise(r=>server.close(r)));
 for(const path of ['/jobs','/followed','/applications']){const body=await(await fetch('http://127.0.0.1:'+server.address().port+path)).text();assert.ok(body.includes(url.replaceAll('&','&amp;')));assert.ok(!body.includes('href="'+oldUrl.replaceAll('&','&amp;')+'"'));}
});


test('来源观察更新入口，不改岗位正文或模型输入；失败观察不能覆盖，个人纠正优先',t=>{
 const app=createApplication({databasePath:':memory:',expandedSources:true,announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date('2026-10-15T02:00:00Z')});t.after(()=>app.close());
 const postId='6accefe8f0cfabf2b4ed6480',url='https://www.hotjob.cn/wt/ecloud/mobweb/v8/position/detail?recruitType=2&postIdsAry=280002&brandCode=1';
 const job=app.importJob({title:'模拟软件工程师',originalText:'模拟原始职责',location:{options:['北京']},sourceIdentity:{sourceId:'ctyun-social',externalId:postId},observedAt:'2026-10-15T01:00:00Z'}).job;
 const source=app.getSourceJob(job.id),observation={sourceId:'ctyun-social',externalId:postId,observedAt:'2026-10-15T01:30:00Z',acquisition:'success',listComplete:true,listed:true,applicationOpen:true,applicationUrl:url,evidence:{url,text:'模拟官方跨系统编号280002',quote:'280002'}};
 app.recordRecruitmentObservation(job.id,observation);assert.equal(app.listJobView().find(x=>x.id===job.id).display.application.href,url);assert.equal(app.listJobView().find(x=>x.id===job.id).display.application.label,'岗位直达');assert.deepEqual(app.getSourceJob(job.id),source);
 const changed=url.replace('280002','280003');app.recordRecruitmentObservation(job.id,{...observation,acquisition:'failed',applicationUrl:changed,observedAt:'2026-10-15T01:40:00Z'});assert.equal(app.getRecruitmentState(job.id).applicationUrl,url);
 assert.throws(()=>app.recordRecruitmentObservation(job.id,{...observation,applicationUrl:'javascript:alert(1)'}),/官方跨系统/);
 app.correctJob(job.id,{field:'applicationPath',value:{kind:'direct',url:'https://example.org/manual'},basis:{reason:'本人指定入口'}});assert.equal(app.listJobView().find(x=>x.id===job.id).display.application.href,'https://example.org/manual');assert.equal(app.listNotificationAttempts().length,0);
});
