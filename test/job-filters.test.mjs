import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';

test('岗位库五维组合筛选依本岗位方向与职责层级，Web/API及重启保留结束历史',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jh-filters-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const options={databasePath:join(dir,'data.sqlite'),announcementProcessor:null,matchingProcessor:{match:async({job})=>{const dimension={level:"low",explanation:"模拟与本人经历层级匹配低，岗位仍承担专家职责",directExperiences:[],transferableAbilities:[],gaps:["模拟匹配差距"],jobQuotes:[job.originalText]};return {technical:dimension,business:dimension,scope:dimension,route:"expert",routeExplanation:"模拟依据负责核心模型研发与技术路线判断专家职责",uncertainties:[]};}},now:()=>new Date('2026-10-08T01:00:00Z')};let app=createApplication(options);
 const expert=app.createJob({title:'大模型技术专家',recruitmentUnit:'模拟甲机构',originalText:'大模型技术专家，职责负责核心模型研发与技术路线。硕士学历。另一个岗位：营销负责人。',knownConditions:['硕士学历']});
 const manager=app.createJob({title:'营销技术负责人',recruitmentUnit:'模拟乙机构',originalText:'营销技术负责人，博士学历。',knownConditions:['博士学历']});
 const unknown=app.createJob({title:'数据工程师',recruitmentUnit:'模拟甲机构',originalText:'数据工程师，具有1年工作经验。',knownConditions:['具有1年工作经验']});
 app.saveCareerProfile({text:'模拟职业资料：负责算法研发',version:'模拟v1',sourceId:'manual'});await app.matchJob(expert.id);
 const titleOnly=app.createJob({title:'高级经理',originalText:'高级经理招聘，不负责团队建设或管理。',duties:'不负责团队建设或管理'});assert.equal(app.listJobs({level:'leader'}).some(x=>x.id===titleOnly.id),false);assert.equal(app.listJobs({level:'unknown'}).some(x=>x.id===titleOnly.id),true);
 app.evaluateEligibility(expert.id,{profile:{version:'模拟v1',education:'硕士'}});app.evaluateEligibility(manager.id,{profile:{version:'模拟v1',education:'硕士'}});
 assert.deepEqual(app.listJobs({unit:'模拟甲机构',direction:'大模型',level:'expert',eligibility:'verified',status:'unverified'}).map(x=>x.id),[expert.id]);
 assert.equal(app.listJobs({direction:'营销'}).some(x=>x.id===expert.id),false);assert.equal(app.listJobs({level:'unknown'}).some(x=>x.id===unknown.id),true);
 app.close();app=createApplication(options);const server=await startServer({app,port:0});t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});const base=`http://127.0.0.1:${server.address().port}`,query='?unit=模拟甲机构&direction=大模型&level=expert&eligibility=verified&status=unverified';
 const response=await fetch(base+'/api/jobs'+query);assert.equal(response.status,200);assert.deepEqual((await response.json()).map(x=>x.id),[expert.id]);const html=await(await fetch(base+'/jobs'+query)).text();assert.match(html,/name="unit"/);assert.match(html,/name="direction"/);assert.match(html,/name="level"/);assert.match(html,/name="eligibility"/);assert.match(html,/name="status"/);assert.match(html,/大模型技术专家/);assert.doesNotMatch(html,/营销技术负责人/);assert.match(html,/<tbody\b[^>]*>[\s\S]*data-job-column="route"[^>]*>[^<]*<span[^>]*>专家<\/span><\/td>/);
 assert.equal((await fetch(base+'/api/jobs?level=high')).status,400);assert.equal(app.listJobs().length,4);
});

test('资格证据变化不会沿用旧符合筛选，需重验与结束岗位历史重启仍可回看',t=>{
 const dir=mkdtempSync(join(tmpdir(),'jh-filter-history-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const options={databasePath:join(dir,'data.sqlite'),announcementProcessor:null,matchingProcessor:null};let app=createApplication(options);
 const input={title:'模拟历史岗位',recruitmentUnit:'模拟单位',originalText:'模拟岗位，硕士学历',knownConditions:['硕士学历'],sourceUrl:'https://example.org/history',sourceIdentity:{sourceId:'demo-history',externalId:'one'},observedAt:'2026-10-08T01:00:00Z'};
 const job=app.importJob(input).job;app.evaluateEligibility(job.id,{profile:{version:'模拟v1',education:'硕士'}});assert.equal(app.listJobs({eligibility:'verified'}).length,1);
 app.importJob({...input,originalText:'模拟岗位，博士学历',knownConditions:['博士学历'],observedAt:'2026-10-09T01:00:00Z'});
 assert.equal(app.listJobs({eligibility:'verified'}).length,0);assert.equal(app.listJobs({eligibility:'needs_review'}).length,1);
 const evidence={url:input.sourceUrl,text:'模拟岗位招聘结束',quote:'招聘结束'};app.recordRecruitmentObservation(job.id,{sourceId:'demo-history',externalId:'one',observedAt:'2026-10-09T01:01:00Z',acquisition:'success',explicitEnd:evidence,evidence});app.close();app=createApplication(options);t.after(()=>app.close());
 assert.equal(app.listJobs({status:'ended',eligibility:'needs_review'})[0].id,job.id);assert.equal(app.listEligibility(job.id)[0].profileVersion,'模拟v1');assert.equal(app.listJobs().length,1);
});
