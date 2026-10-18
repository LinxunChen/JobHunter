import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {startServer} from '../src/server.mjs';
const options=t=>{const dir=mkdtempSync(join(tmpdir(),'jh-settings-v2-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {databasePath:join(dir,'test.sqlite'),announcementProcessor:null,matchingProcessor:null,profileProcessor:null,careerSource:null};};
test('目标岗位直接生效，空值不限；旧默认配置保留原筛选缓存语义',t=>{
 const app=createApplication(options(t));t.after(()=>app.close());
 const job=app.createJob({title:'人力资源主管',originalText:'公开人力资源岗位',location:{options:['上海']}});
 const before=app.getMatch(job.id);
 app.saveLocalSettings({targetCities:['上海'],roleKeywords:['人力资源']});
 assert.equal(app.getJobView(job.id).display.relevance.status,'relevant');
 assert.equal(Object.hasOwn(app.getLocalSettings(),'roleMode'),false);
 app.saveLocalSettings({roleKeywords:[]});assert.equal(app.getJobView(job.id).display.relevance.status,'relevant');
 assert.equal(app.getMatch(job.id),before);
});
test('校招目标重启保留，直接与公共检查均跳过社招来源，不访问网站、不改变岗位状态',async t=>{
 const settings=options(t);let calls=0;
 const app=createApplication({...settings,sourceFetch:async()=>{calls++;throw Error('禁止访问');}});t.after(()=>app.close());
 const job=app.createJob({title:'算法工程师',originalText:'公开模拟岗位'});
 app.saveLocalSettings({recruitmentType:'campus'});
 const direct=await app.checkEfundsSource(),review=await app.runSourceCheck('efunds-social',{trigger:'manual'});
 assert.equal(direct.status,'unsupported_type');assert.equal(review.status,'unsupported_type');assert.equal(calls,0);
 assert.equal(app.getJob(job.id).recruitmentStatus,'unverified');
 const reopened=createApplication(settings);t.after(()=>reopened.close());assert.equal(reopened.getLocalSettings().recruitmentType,'campus');
 assert.deepEqual(app.getSourcesOverview().sources.find(s=>s.id==='efunds-social').supportedRecruitmentTypes,['social']);
 app.saveLocalSettings({recruitmentType:'all'});assert.equal(app.getSourceRecruitmentSupport('efunds-social').supported,true);
 app.saveLocalSettings({recruitmentType:'social'});assert.equal(app.getSourceRecruitmentSupport('efunds-social').supported,true);
 assert.equal(app.getJob(job.id).recruitmentStatus,'unverified');assert.equal(calls,0);
});

test('统一保存先校验且原子提交，资料异步提取有引用、去重；失败保留资料且旧自动事实不冒充当前',async t=>{
 let calls=0,fail=false;
 const settings=options(t),app=createApplication({...settings,profileProcessor:{analyze:async({profile})=>{
  calls++;if(fail)throw Error('私密错误不得展示');
  return {facts:{education:'硕士',major:'计算机'},evidence:{education:'教育背景：已取得硕士学历',major:'专业：计算机'},gaps:[]};
 }}});t.after(()=>app.close());
 const text='教育背景：已取得硕士学历\n专业：计算机\n负责算法项目';
 assert.throws(()=>app.saveSettings({targetCities:['上海'],recruitmentType:'wrong',profileText:text}));
 assert.equal(app.listCareerProfiles().length,0);assert.deepEqual(app.getLocalSettings().targetCities,['北京']);
 app.saveSettings({targetCities:['上海'],roleKeywords:['算法'],profileText:text});
 await app.waitForProfileAnalysis();
 assert.equal(calls,1);assert.equal(app.getProfileAnalysis().status,'completed');
 assert.equal(app.getQualificationProfile().facts.education,'硕士');
 assert.equal(app.getQualificationProfile().sources.education.quote,'教育背景：已取得硕士学历');
 app.saveSettings({targetCities:['杭州'],profileText:text});await app.waitForProfileAnalysis();assert.equal(calls,1);
 fail=true;app.saveSettings({profileText:'新的资料：只有已确认的项目经历'});await app.waitForProfileAnalysis();
 assert.equal(app.getProfileAnalysis().status,'failed');assert(app.getQualificationProfile().stale);
 assert.doesNotMatch(JSON.stringify(app.getProfileAnalysis()),/私密错误/);
 assert.equal(app.getCareerProfile(app.listCareerProfiles()[0].id).text,'新的资料：只有已确认的项目经历');
});

test('手动确认优先，伪造引文拒绝；手动资料和知识库刷新共用提取，分析受预算限制',async t=>{
 let mode='valid',calls=0;
 const app=createApplication({...options(t),initialSettings:{careerDocumentId:'20000101000000-example'},careerSource:{readCareerOverview:async()=>({id:'20000101000000-example',complete:true,text:'已取得硕士学历；负责算法建设项目。'})},profileProcessor:{analyze:async()=>{
  calls++;return {facts:{education:'硕士'},evidence:{education:mode==='valid'?'已取得硕士学历':'不存在的引文'},gaps:[]};
 }}});t.after(()=>app.close());
 app.saveQualificationProfile({facts:{education:'本科'},sources:{education:{kind:'user',reference:'本人确认',quote:'本人已确认本科学历'}}});
 await app.refreshCareerProfile();await app.waitForProfileAnalysis();
 assert.equal(app.getProfileAnalysis().status,'needs_review');assert.equal(app.getQualificationProfile().facts.education,'本科');
 assert.deepEqual(app.getProfileAnalysis().conflicts,['education']);assert.equal(calls,1);
 assert.equal(app.getModelBudgetStatus().used,1);
 mode='invalid';app.saveSettings({profileText:'新的个人资料，已取得硕士学历，负责研发。'});await app.waitForProfileAnalysis();
 assert.equal(app.getProfileAnalysis().status,'failed');assert.equal(app.getQualificationProfile().facts.education,'本科');
});

test('处理中更新资料时旧分析不覆盖新版本，中断后可由新实例继续',async t=>{
 let release,started;
 const ready=new Promise(resolve=>started=resolve),settings=options(t);
 const app=createApplication({...settings,profileProcessor:{analyze:async()=>{started();return new Promise(resolve=>release=resolve);}}});
 app.saveSettings({profileText:'已取得硕士学历；负责项目。'});await ready;
 const next=createApplication({...settings,profileProcessor:{analyze:async()=>({facts:{education:'本科'},evidence:{education:'已取得本科学历'},gaps:[]})}});t.after(()=>next.close());
 next.saveSettings({profileText:'已取得本科学历；负责新项目。'});await next.waitForProfileAnalysis();
 release({facts:{education:'硕士'},evidence:{education:'已取得硕士学历'},gaps:[]});await app.waitForProfileAnalysis();
 assert.equal(next.getQualificationProfile().facts.education,'本科');app.close();
 // A queued analysis survives shutdown before its callback begins.
 const queued=createApplication({...settings,profileProcessor:{analyze:async()=>{throw Error('关闭后不可调用');}}});
 queued.saveSettings({profileText:'最新资料已取得硕士学历'});queued.close();
 await next.runPendingProfileAnalyses();
 assert.equal(next.getProfileAnalysis().status,'failed'); // synthetic processor's quote does not belong to this text
 assert.equal(next.getCareerProfile(next.listCareerProfiles()[0].id).text,'最新资料已取得硕士学历');
});

test('四项表单统一保存，GET只读；不再要求岗位模式和资格长表',async t=>{
 const app=createApplication(options(t));t.after(()=>app.close());
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const html=await(await fetch(base+'/settings')).text();
 for(const name of ['targetCities','roleKeywords','recruitmentType','profileText'])assert(html.includes(`name="${name}"`));
 assert(!html.includes('name="roleMode"'));assert(!html.includes('name="education"'));assert(html.includes('查看与纠正已识别信息'));
 const response=await fetch(base+'/settings',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({targetCities:'上海',roleKeywords:'人力资源',recruitmentType:'campus',profileText:'演示资料：负责组织发展。'}),redirect:'manual'});
 assert.equal(response.status,303);assert.equal(app.getLocalSettings().recruitmentType,'campus');
 assert.equal(app.getCareerProfile(app.listCareerProfiles()[0].id).text,'演示资料：负责组织发展。');
 const before=app.getModelUsageSummary().calls;await fetch(base+'/settings');await fetch(base+'/api/settings');assert.equal(app.getModelUsageSummary().calls,before);
});

test('旧默认目标的匹配指纹保留，补充偏好只使匹配待更新，不重加工原文',async t=>{
 const app=createApplication({...options(t),matchingProcessor:{match:async()=>{const d={level:'unknown',explanation:'资料不足',directExperiences:[],transferableAbilities:[],gaps:['资料不足'],jobQuotes:['公开算法岗位']};return {technical:d,business:d,scope:d,route:'uncertain',routeExplanation:'范围未知',uncertainties:['模拟']};}}});t.after(()=>app.close());
 app.saveCareerProfile({sourceId:'manual',version:'模拟v1',text:'负责算法项目。'});
 const job=app.createJob({title:'算法岗位',originalText:'公开算法岗位',location:{options:['北京']}});
 const match=await app.matchJob(job.id);assert.equal(match.targetScopeKey,'01f78b4b7f648c21');
 app.saveLocalSettings({roleMode:'technical'});assert.equal(app.getMatch(job.id).stale,false);
 app.saveLocalSettings({preferences:'希望独立负责专业领域'});assert.equal(app.getMatch(job.id).stale,true);
 assert.equal(app.getJob(job.id).originalText,'公开算法岗位');
});

test('自动资料分析共用每日预算，额度不足不调用模型，下一日恢复后才完成',async t=>{
 let at=new Date('2026-10-18T02:00:00Z'),calls=0;
 const app=createApplication({...options(t),now:()=>at,profileProcessor:{analyze:async()=>{calls++;return {facts:{education:'本科'},evidence:{education:'已取得本科学历'},gaps:[]};}}});t.after(()=>app.close());
 for(let i=0;i<50;i++)app.reserveAutomaticModelCall();
 app.saveSettings({profileText:'已取得本科学历，负责项目。'});await app.waitForProfileAnalysis();
 assert.equal(app.getProfileAnalysis().status,'deferred');assert.equal(calls,0);
 at=new Date('2026-10-19T02:00:00Z');await app.runPendingProfileAnalyses();
 assert.equal(app.getProfileAnalysis().status,'completed');assert.equal(calls,1);assert.equal(app.getModelBudgetStatus().used,1);
});

test('活动资料分析关闭后可恢复，已中断的旧结果不能回写覆盖',async t=>{
 const settings=options(t);let release,started;
 const ready=new Promise(resolve=>started=resolve);
 const old=createApplication({...settings,profileProcessor:{analyze:async()=>{started();return new Promise(resolve=>release=resolve);}}});
 old.saveSettings({profileText:'已取得本科学历；负责项目。'});await ready;old.close();
 const app=createApplication({...settings,profileProcessor:{analyze:async()=>({facts:{education:'本科'},evidence:{education:'已取得本科学历'},gaps:[]})}});t.after(()=>app.close());
 assert.equal(app.getProfileAnalysis().status,'interrupted');await app.runPendingProfileAnalyses();
 assert.equal(app.getProfileAnalysis().status,'completed');assert.equal(app.getProfileAnalysis().history[0].status,'interrupted');
 release({facts:{education:'博士'},evidence:{education:'伪造旧结果'},gaps:[]});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(app.getQualificationProfile().facts.education,'本科');
});

test('引文真实但所提学历仍在读时也不能成为已取得学历',async t=>{
 const app=createApplication({...options(t),profileProcessor:{analyze:async()=>({facts:{education:'硕士'},evidence:{education:'硕士在读，本科已毕业'},gaps:[]})}});t.after(()=>app.close());
 app.saveSettings({profileText:'硕士在读，本科已毕业'});await app.waitForProfileAnalysis();
 assert.equal(app.getProfileAnalysis().status,'failed');assert.equal(app.getQualificationProfile(),null);
});

test('单独保留软件研发关键词仍覆盖后端专业职责，不依赖整组默认词或方向模式',t=>{
 const app=createApplication(options(t));t.after(()=>app.close());app.saveLocalSettings({roleKeywords:['软件研发']});
 const job=app.createJob({title:'后端开发工程师',duties:'负责后台开发与技术架构',originalText:'公开后端开发岗位'});
 assert.equal(app.getJobView(job.id).display.relevance.status,'relevant');
});


test('旧方向下未生效的关键词不改变迁移含义，旧匹配指纹在保存与重启后仍有效',async t=>{
 const settings=options(t),legacy={targetCities:['北京'],roleMode:'technical',roleKeywords:['人力资源'],excludedKeywords:[]};
 const app=createApplication({...settings,initialSettings:legacy,matchingProcessor:{match:async()=>{const d={level:'unknown',explanation:'资料不足',directExperiences:[],transferableAbilities:[],gaps:['资料不足'],jobQuotes:['公开算法岗位']};return {technical:d,business:d,scope:d,route:'uncertain',routeExplanation:'范围未知',uncertainties:['模拟']};}}});
 app.saveCareerProfile({sourceId:'manual',version:'模拟v1',text:'负责算法项目。'});
 const job=app.createJob({title:'算法岗位',originalText:'公开算法岗位'}),result=await app.matchJob(job.id);
 const legacyKey=createHash('sha256').update(JSON.stringify(legacy)).digest('hex').slice(0,16);
 const db=new DatabaseSync(settings.databasePath),stored=JSON.parse(db.prepare('SELECT body FROM matching_results WHERE id=?').get(result.id).body);stored.targetScopeKey=legacyKey;db.prepare('UPDATE matching_results SET body=? WHERE id=?').run(JSON.stringify(stored),result.id);db.close();
 assert.equal(app.getMatch(job.id).stale,false);assert(app.getLocalSettings().roleKeywords.includes('软件研发'));
 app.saveSettings({roleKeywords:app.getLocalSettings().roleKeywords});app.close();
 const reopened=createApplication(settings);t.after(()=>reopened.close());assert.equal(reopened.getMatch(job.id).stale,false);
 reopened.saveSettings({roleKeywords:['人力资源']});assert.equal(reopened.getMatch(job.id).stale,true);
});
