import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

const duties='负责推荐排序模型研发与业务指标优化，独立设计系统架构并推进上线。';
const experience='负责推荐排序研发项目，主导业务指标优化及系统架构设计。';
const dim = () => ({level:'high',shortReason:'直接承担推荐排序研发',explanation:'有直接研发和架构经历',directExperiences:[{profileQuote:experience,jobQuote:duties,explanation:'有直接研发职责'}],transferableAbilities:[],gaps:[],jobQuotes:[duties]});
const output = () => ({technical:dim(),business:dim(),scope:dim(),route:'expert',routeExplanation:'独立研发专家职责',routeEvidence:[duties],recommendation:{level:'priority',reason:'直接研发经历与岗位职责一致'},uncertainties:[]});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'jh-recommendation-v2-'));let response=output();const app=createApplication({databasePath:join(dir,'data.sqlite'),announcementProcessor:null,now:()=>new Date('2026-10-08T01:00:00Z'),matchingProcessor:{match:async()=>response}});t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});return{app,setResponse:value=>response=value};}
function seed(app,condition='硕士及以上'){const job=app.importJob({title:'模拟推荐算法专家',originalText:duties+condition,duties,knownConditions:[condition],sourceIdentity:{sourceId:'demo',externalId:condition},sourceUrl:'https://example.invalid/job',evidenceUse:'current',observedAt:'2026-10-08T00:00:00Z'}).job;app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:condition,observedAt:'2026-10-08T00:00:00Z',acquisition:'success',listComplete:true,listed:true,applicationOpen:true,evidence:{url:'https://example.invalid/job',text:'模拟开放',quote:'模拟开放'}});return job;}

test('LLM四档短结论在公共岗位展示复用，独立资格不被职业版本误挡且博士不符合强制不推荐',async t=>{
 const{app}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'career-v1'});app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟确认',quote:'最高学历硕士'}}});
 const good=seed(app);app.evaluateEligibility(good.id);assert.equal((await app.matchJob(good.id)).status,'completed');
 const view=app.listJobView().find(j=>j.id===good.id);assert.equal(view.display.recommendation.label,'优先考虑');assert.equal(view.display.dimensions[0].shortReason,'直接承担推荐排序研发');assert.equal(app.getMatch(good.id).qualificationAllowsAction,true);
 const bad=seed(app,'博士及以上学历');app.evaluateEligibility(bad.id);await app.matchJob(bad.id);
 const excluded=app.listJobView().find(j=>j.id===bad.id);assert.equal(excluded.display.recommendation.label,'不推荐');assert.equal(excluded.display.eligibility.label,'不满足');assert.match(excluded.display.eligibility.reason,/博士/);assert.equal(excluded.display.group,'history');assert.equal(excluded.display.recruitment.label,'在招');assert.equal(app.getToday().opportunities.some(x=>x.jobId===bad.id),false);
});

test('资格满足但当前匹配不推荐也进入排除表，职业证据变化后旧判断不能继续排除',async t=>{
 const{app,setResponse}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟确认',quote:'硕士'}}});
 const job=seed(app);app.evaluateEligibility(job.id);const mismatch=output();mismatch.technical={...mismatch.technical,level:'low',shortReason:'决定性技术要求不符',directExperiences:[],gaps:['模拟决定性能力差距']};mismatch.recommendation={level:'avoid',reason:'决定性技术能力不符'};setResponse(mismatch);assert.equal((await app.matchJob(job.id)).status,'completed');
 let view=app.listJobView().find(item=>item.id===job.id);assert.equal(view.display.eligibility.label,'满足');assert.equal(view.display.group,'history');assert.equal(view.display.exclusionReason,'不推荐：决定性技术能力不符');assert.equal(view.display.recruitment.label,'在招');
 app.saveCareerProfile({sourceId:'manual',text:experience+'模拟新增本人项目证据。',version:'v2'});view=app.listJobView().find(item=>item.id===job.id);assert.equal(view.display.recommendation.label,'不确定');assert.equal(view.display.group,'pending');assert.equal(view.display.exclusionReason,null);
});

test('矛盾优先推荐及无职责引文被拒绝，模型失败和legacy不伪造新结论',async t=>{
 const{app,setResponse}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});const job=seed(app);
 let invalid=output();invalid.technical.level='low';setResponse(invalid);assert.equal((await app.matchJob(job.id)).status,'failed');
 invalid=output();invalid.routeEvidence=['模拟推荐算法专家'];setResponse(invalid);assert.equal((await app.matchJob(job.id)).status,'failed');
 const legacy=output();delete legacy.recommendation;delete legacy.routeEvidence;for(const key of['technical','business','scope'])delete legacy[key].shortReason;setResponse(legacy);assert.equal((await app.matchJob(job.id)).status,'completed');
 assert.equal(app.listJobView()[0].display.recommendation.needsUpdate,true);assert.equal(app.listJobView()[0].display.recommendation.label,'不确定');
});

test('逐字职责中的重构改进、技术方案实现不会被动词白名单误拒绝，改写和资格引文仍拒绝',async t=>{
 const{app,setResponse}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});
 const actualDuties=['持续重构和改进前端技术平台，不断提升用户体验。','根据业务需求，明确技术可行性方案，实现知识服务赋能业务。'];
 for(const text of actualDuties){
  const job=app.createJob({title:'技术专家',originalText:text+'硕士及以上学历。',duties:text});
  const valid=output();valid.routeEvidence=[text];for(const key of['technical','business','scope']){valid[key].jobQuotes=[text];valid[key].directExperiences[0].jobQuote=text;}
  setResponse(valid);assert.equal((await app.matchJob(job.id)).status,'completed');
  const changed=structuredClone(valid);changed.routeEvidence=[text.replace('。','！')];setResponse(changed);assert.equal((await app.matchJob(job.id)).status,'failed');
  const qualification=structuredClone(valid);qualification.routeEvidence=['硕士及以上学历'];setResponse(qualification);assert.equal((await app.matchJob(job.id)).status,'failed');
 }
});

test('公共岗位组合筛选地点推荐与日期，推荐排序不把明确不满足放在前面',async t=>{
 const{app}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});app.saveQualificationProfile({facts:{education:'硕士'},sources:{education:{kind:'user',reference:'模拟确认',quote:'硕士'}}});
 const good=seed(app);app.evaluateEligibility(good.id);await app.matchJob(good.id);
 app.correctJob(good.id,{field:'location',value:{options:['北京','北京'],confirmed:null,note:null},basis:{reason:'模拟明确地点修正'}});
 // Correction alters the evidence; re-assess before using a current recommendation.
 app.evaluateEligibility(good.id);await app.matchJob(good.id);
 const jobs=app.listJobView('all',{location:'北京',recommendation:'priority',sort:'recommendation'});assert.equal(jobs.length,1);assert.equal(jobs[0].display.location,'北京');
 assert.throws(()=>app.listJobs({deadlineBefore:'tomorrow'}),/日期/);
});

test('已有优先匹配不能覆盖当前申请关闭或完整列表下线，恢复开放后自动回推荐',async t=>{
 const{app}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});const job=seed(app);await app.matchJob(job.id);assert.equal(app.listJobView()[0].display.group,'active');
 const observe=(at,fields)=>app.recordRecruitmentObservation(job.id,{sourceId:'demo',externalId:'硕士及以上',observedAt:at,acquisition:'success',listComplete:false,listed:true,detailAccessible:true,evidence:{url:'https://example.invalid/job',text:'官方复查',quote:'官方复查'},...fields});
 observe('2026-10-08T00:10:00Z',{applicationOpen:false});assert.equal(app.listJobView()[0].display.group,'pending');assert.equal(app.getMatch(job.id).status,'completed');
 observe('2026-10-08T00:20:00Z',{applicationOpen:true});assert.equal(app.listJobView()[0].display.group,'active');
 observe('2026-10-08T00:30:00Z',{listComplete:true,listed:false,applicationOpen:null});assert.equal(app.listJobView()[0].display.group,'history');
});

test('旧版匹配已完成但缺四档推荐时，公共自动匹配补齐结论并清空队列',async t=>{
 const{app,setResponse}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});const job=seed(app);app.correctJob(job.id,{field:'location',value:{options:['北京'],confirmed:null,note:null},basis:{reason:'官方模拟地点'}});
 const legacy=output();delete legacy.recommendation;delete legacy.routeEvidence;for(const key of ['technical','business','scope'])delete legacy[key].shortReason;setResponse(legacy);await app.matchJob(job.id);
 const {pendingAutomaticMatches,updateNecessaryJobs}=await import('../src/necessary-jobs.mjs');assert.equal(pendingAutomaticMatches(app).length,1);
 setResponse(output());await app.withModelBatch(()=>updateNecessaryJobs(app),{automatic:true});assert.equal(pendingAutomaticMatches(app).length,0);assert.equal(app.listJobView()[0].display.group,'active');assert.equal(app.listMatches(job.id).length,2);
});

test('职责路线保留真实责任引文，移除混入的技能背景；纯技能或改写不能通过',async t=>{
 const{app,setResponse}=setup(t);app.saveCareerProfile({sourceId:'manual',text:experience,version:'v1'});
 const skill='在 OpenStack、Linux 内核方向中至少精通1-2项；',all=duties+'\n'+skill,job=app.createJob({title:'技术专家',originalText:all,duties:all});
 const valid=output();valid.routeEvidence=[duties,skill];setResponse(valid);const r=await app.matchJob(job.id);assert.equal(r.status,'completed');assert.deepEqual(r.output.routeEvidence,[duties]);
 const only=structuredClone(valid);only.routeEvidence=[skill];setResponse(only);assert.equal((await app.matchJob(job.id)).status,'failed');
 const fake=structuredClone(valid);fake.routeEvidence=[duties,'并未出现的主导团队职责'];setResponse(fake);assert.equal((await app.matchJob(job.id)).status,'failed');
});
