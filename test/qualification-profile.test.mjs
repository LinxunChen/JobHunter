import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from './helpers/career-application.mjs';
const optionsFor=t=>{const dir=mkdtempSync(join(tmpdir(),'qualification-profile-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {databasePath:join(dir,'jobs.sqlite'),announcementProcessor:null,matchingProcessor:null,careerSource:null,now:()=>new Date('2026-10-08T02:00:00Z')};};
const source=quote=>({kind:'user',reference:'本轮明确确认',quote});
const saveEducation=(app,education)=>app.saveQualificationProfile({facts:{education},sources:{education:source(`本人已取得${education}学历`)}});
const job=(app,text)=>app.createJob({title:'模拟岗位',originalText:text,knownConditions:[text]});

test('独立资格事实保留来源和历史，学历更正使旧资格过时且不改职业匹配档案',t=>{
 const options=optionsFor(t);let app=createApplication(options);
 const career=app.saveCareerProfile({sourceId:'manual',version:'career-v1',text:'模拟算法经历'});
 const first=saveEducation(app,'博士');
 const saved=job(app,'要求博士学历');
 const qualified=app.evaluateEligibility(saved.id);
 assert.equal(qualified.status,'verified');assert.equal(qualified.profileVersion,first.version);assert.equal(qualified.profileSource.kind,'qualification');
 app.setPersonalState(saved.id,{followed:true});
 const second=saveEducation(app,'硕士');assert.notEqual(second.version,first.version);
 assert.equal(app.getEligibility(saved.id).stale,true);
 assert.equal(app.listCareerProfiles().length,1);assert.equal(app.listCareerProfiles()[0].id,career.id);
 assert.equal(saveEducation(app,'硕士').id,second.id);
 app.close();app=createApplication(options);t.after(()=>app.close());
 assert.equal(app.getQualificationProfile().facts.education,'硕士');assert.equal(app.listQualificationProfiles().length,2);
 assert.equal(app.listQualificationProfiles()[1].sources.education.quote,'本人已取得博士学历');
 assert.equal(app.getEligibility(saved.id).profileSnapshot.education,'博士');
 assert.equal(app.getPersonalState(saved.id).followed,true);
 assert.equal(app.evaluateEligibility(saved.id).status,'ineligible');assert.equal(app.listEligibility(saved.id).length,2);
});

test('软能力、偏好、流程不制造资格缺口，博士硬门槛和真实声明仍独立核验', t => {
 const app=createApplication(optionsFor(t));t.after(()=>app.close());saveEducation(app,'硕士');
 const clauses=['硕士及以上学历','保持研究热情','有极强的技术信仰与热情','具备较强业务理解能力','熟悉Python和大模型训练','熟悉计算机专业知识','计算机专业优先','持有CFA证书优先','报名时请填写简历，保持手机畅通'];
 const one=app.createJob({title:'模拟研发岗',originalText:clauses.join('\n'),knownConditions:clauses});
 const result=app.evaluateEligibility(one.id);assert.equal(result.status,'verified');assert.equal(result.checks.filter(x=>x.status==='pending').length,0);
 const doctorate=app.evaluateEligibility(job(app,'计算机相关专业，博士及以上学历').id);
 assert.equal(doctorate.status,'ineligible');assert.equal(doctorate.checks.some(x=>x.facts?.requiredEducation==='博士'),true);
 assert.equal(app.evaluateEligibility(job(app,'硕士及以上，博士优先').id).status,'verified');
 assert.equal(app.evaluateEligibility(job(app,'博士学历或具有10年相关经验').id).status,'pending');
 assert.equal(app.evaluateEligibility(job(app,'符合亲属回避要求，无不良记录').id).status,'pending');
});

test('指定职业概览只提取明确资格，来源更新撤销旧事实，保留本人学历且使旧判断失效',async t=>{
 let text='学历：博士\n专业：计算机\n已取得证书：CFA\n相关经历：AI | 2020-01 | 2023-01\n曾在知名机构任职，不据此推断生日。';
 const app=createApplication({...optionsFor(t),careerSource:{readCareerOverview:async()=>({id:'20000101000000-example',complete:true,text})}});t.after(()=>app.close());saveEducation(app,'硕士');
 assert.equal((await app.refreshCareerProfile()).status,'completed');
 const first=app.getQualificationProfile();assert.equal(first.facts.education,'硕士');assert.equal(first.sources.education.kind,'user');assert.equal(first.facts.major,'计算机');assert.deepEqual(first.facts.certificates,['CFA']);assert.equal(first.facts.experiences[0].startMonth,'2020-01');assert.equal(first.facts.birthday,undefined);
 const j=job(app,'须为计算机专业');assert.equal(app.evaluateEligibility(j.id).status,'verified');
 text='学历：博士\n专业：数学\n只有大约三年工作经验，未明确起止年月。';await app.refreshCareerProfile();
 assert.equal(app.getEligibility(j.id).stale,true);const second=app.getQualificationProfile();assert.equal(second.facts.education,'硕士');assert.equal(second.facts.major,'数学');assert.equal(second.facts.certificates,undefined);assert.equal(second.facts.experiences,undefined);
 assert.equal(app.listQualificationProfiles().some(item=>item.id===first.id),true);assert.equal(app.evaluateEligibility(j.id).status,'pending');assert.equal(app.getEligibility(j.id).profileSnapshot.major,'数学');
 assert.throws(()=>app.saveQualificationProfile({facts:{education:null},sources:{education:source('未知')}}),/学历/);
});
