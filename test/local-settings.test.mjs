import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';

function setup(t) {
 const directory=mkdtempSync(join(tmpdir(),'jobhunter-settings-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const options={databasePath:join(directory,'test.sqlite'),announcementProcessor:null,matchingProcessor:null,careerSource:null};
 return {options,app:createApplication(options)};
}
test('设置持久化后城市与关键词改变推荐筛选，另一实例不串配置，原岗位和个人操作保留',t=>{
 const {app,options}=setup(t);t.after(()=>app.close());
 const job=app.createJob({title:'财务管理',originalText:'模拟公开岗位',location:{options:['上海']}});
 app.setPersonalState(job.id,{followed:true});
 assert.equal(app.getJobView(job.id).display.locationFit.status,'excluded');
 app.saveLocalSettings({targetCities:['上海'],roleMode:'keywords',roleKeywords:['财务'],excludedKeywords:['销售']});
 assert.equal(app.getJobView(job.id).display.locationFit.status,'included');
 assert.notEqual(app.getJobView(job.id).display.recommendation.level,'excluded');
 const other=createApplication({...options,databasePath:':memory:'});t.after(()=>other.close());
 const another=other.createJob({title:'财务管理',originalText:'模拟公开岗位',location:{options:['上海']}});
 assert.equal(other.getJobView(another.id).display.locationFit.status,'excluded');
 const reopened=createApplication(options);t.after(()=>reopened.close());
 assert.deepEqual(reopened.getLocalSettings().targetCities,['上海']);
 assert.equal(reopened.getPersonalState(job.id).followed,true);
 assert.equal(reopened.getJob(job.id).originalText,'模拟公开岗位');
});

test('Web设置可编辑目标和职业资料，保存不触发外部检查；校验失败保留原配置',async t=>{
 const {app}=setup(t);t.after(()=>app.close());
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const html=await (await fetch(base+'/sources')).text();
 assert.match(html,/目标岗位设置/);assert.match(html,/个人资料/);
 const post=(path,value)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await post('/api/settings',{targetCities:['上海','杭州'],roleMode:'all'})).status,200);
 assert.equal((await post('/api/settings',{recruitmentType:'invalid'})).status,400);
 assert.deepEqual(app.getLocalSettings().targetCities,['上海','杭州']);
 assert.equal((await post('/api/career-profiles',{sourceId:'manual',version:'模拟v1',text:'模拟职业事实：负责财务分析。'})).status,201);
 const settings=await (await fetch(base+'/settings')).text();assert.match(settings,/负责财务分析/);
 assert.equal(app.listScheduledRuns().length,0);assert.equal(app.listNotificationAttempts().length,0);
});

test('目标变化后旧匹配标为过时，自动加工对新城市与新方向重新判断',async t=>{
 const {options}=setup(t),app=createApplication({...options,now:()=>new Date('2026-10-18T02:00:00Z'),matchingProcessor:{match:async()=>{
  const d={level:'unknown',explanation:'模拟资料不足',directExperiences:[],transferableAbilities:[],gaps:['模拟资料不足'],jobQuotes:['模拟公开岗位']};
  return {technical:d,business:d,scope:d,route:'uncertain',routeExplanation:'模拟范围未知',uncertainties:['模拟']};
 }}});t.after(()=>app.close());
 app.saveCareerProfile({sourceId:'manual',version:'模拟v1',text:'模拟职业事实：负责财务分析。'});
 const job=app.createJob({title:'财务分析',originalText:'模拟公开岗位',location:{options:['上海']}});
 assert.equal((await app.matchJob(job.id)).status,'completed');
 app.saveLocalSettings({targetCities:['上海'],roleMode:'keywords',roleKeywords:['财务']});
 assert.equal(app.getMatch(job.id).stale,true);
 assert.equal((await app.matchJob(job.id)).stale,false);
 const ann=await app.createAnnouncement({title:'财务分析',sourceUrl:'https://example.invalid/announcement',originalText:'岗位名称：财务分析\n工作地点：上海\n工作职责：负责财务分析。\n报名截止时间：2026-11-01',sourceIdentityContext:{sourceId:'beijing-sasac',externalId:'https://example.invalid/announcement',observedAt:'2026-10-18T02:00:00Z'}});
 assert.equal(app.screenAnnouncementForAutomaticProcessing(ann.id).sourceProcessingDecision.status,'eligible');
 app.saveLocalSettings({targetCities:['广州']});
 assert.equal(app.screenAnnouncementForAutomaticProcessing(ann.id).sourceProcessingDecision.status,'excluded');
});
