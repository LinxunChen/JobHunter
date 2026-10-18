import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './helpers/career-application.mjs';
import { DatabaseSync } from 'node:sqlite';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-eligibility-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, 'jobs.sqlite'), announcementProcessor: null, now: () => new Date('2026-10-07T02:00:00Z') };
}
const profile = { version: '模拟个人资料v1', education: '硕士', birthday: '1990-10-08' };
const job = (app, text, extra = {}) => app.createJob({ title: '专家', originalText: text, knownConditions: [text], ...extra });

test('明确博士门槛不可被相关能力放行，资格原文和资料版本重启后可追溯', t => {
  const options = setup(t); const app = createApplication(options);
  const saved = job(app, '博士研究生学历');
  const result = app.evaluateEligibility(saved.id, { profile });
  assert.equal(result.status, 'ineligible');
  assert.match(result.checks[0].reason, /博士/);
  assert.equal(result.checks[0].evidence[0].quote, '博士研究生学历');
  assert.equal(result.profileVersion, '模拟个人资料v1');
  assert.equal(result.profileSnapshot.education, '硕士');
  assert.equal(result.jobSnapshot.originalText, '博士研究生学历');
  assert.equal(result.ruleVersion, 'eligibility-v3');
  app.close(); const restarted = createApplication(options); t.after(() => restarted.close());
  assert.deepEqual(restarted.getEligibility(saved.id), result);
});

test('明确派遣外包排除，签约主体等普通未披露不否定或强制待核验', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  const qualified = job(app, '硕士及以上');
  const result = app.evaluateEligibility(qualified.id, { profile });
  assert.equal(result.status, 'verified');
  assert.equal(result.checks.some(check => /签约/.test(check.condition)), false);
  assert.equal(result.checks.some(check => check.status === 'pending'), false);
  assert.match(result.unknownFields.join('；'), /签约主体/);
  assert.doesNotMatch(result.statement, /已确认直签|全部符合/);
  for (const clause of ['本岗位为劳务派遣用工', '外包岗位']) {
    const excluded = app.evaluateEligibility(job(app, clause).id, { profile });
    assert.equal(excluded.status, 'ineligible');
    assert.match(excluded.checks[0].reason, /本人用工偏好/);
  }
  const provider = app.evaluateEligibility(job(app, '负责外包供应商技术管理').id, { profile });
  assert.notEqual(provider.status, 'ineligible');
});

test('按生日及公告明确基准核验年龄，跨生日与出生日期边界可追溯', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  const before = app.evaluateEligibility(job(app, '截至2026年10月7日，年龄不超过35周岁').id, { profile });
  assert.equal(before.status, 'verified');
  assert.equal(before.checks[0].facts.age, 35);
  assert.equal(before.checks[0].facts.referenceDate, '2026-10-07');
  const after = app.evaluateEligibility(job(app, '截至2026年10月8日，年龄不超过35周岁').id, { profile });
  assert.equal(after.status, 'ineligible');
  assert.equal(after.checks[0].facts.age, 36);
  const range = app.evaluateEligibility(job(app, '1990年10月8日及以后出生').id, { profile });
  assert.equal(range.status, 'verified');
  const tooOld = app.evaluateEligibility(job(app, '1990年10月9日及以后出生').id, { profile });
  assert.equal(tooOld.status, 'ineligible');
});

test('原则性、替代和歧义年龄不硬排除，专业证书及经验年月缺口明确而不冒充满足', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  for (const clause of ['原则上35岁以下，特别优秀者可放宽', '年龄35岁以下', '博士或具有十年相关经验']) {
    const result = app.evaluateEligibility(job(app, clause).id, { profile });
    assert.equal(result.status, 'pending');
    assert.notEqual(result.status, 'ineligible');
  }
  for (const [clause, gap] of [['计算机专业', '专业'], ['须持有CFA证书', '证书'], ['具有3年AI项目经验', '精确年月']]) {
    const result = app.evaluateEligibility(job(app, clause).id, { profile });
    assert.equal(result.status, 'pending');
    assert.match(result.checks[0].reason, new RegExp(gap));
  }
  const option = app.evaluateEligibility(job(app, '硕士及以上', { location: { options: ['北京', '上海'], confirmed: null } }).id, { profile });
  assert.equal(option.status, 'verified');
  assert.deepEqual(option.jobSnapshot.location.options, ['北京', '上海']);
  assert.equal(option.jobSnapshot.location.confirmed, null);
  assert.match(option.unknownFields.join('；'), /最终工作地点/);
});

test('专业证书精确月经验可据明确事实核验，复合条件和优先条件不误放行或误排除', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  const facts = { ...profile, major: '计算机', certificates: ['CFA'], experiences: [{ domain: 'AI', startMonth: '2020-01', endMonth: '2023-01' }] };
  for (const clause of ['计算机专业', '须持有CFA证书', '具有3年AI项目经验']) assert.equal(app.evaluateEligibility(job(app, clause).id, { profile: facts }).status, 'verified');
  assert.equal(app.evaluateEligibility(job(app, '硕士及以上，博士优先').id, { profile }).status, 'verified');
  assert.equal(app.evaluateEligibility(job(app, '博士学历；须持有CFA证书').id, { profile }).status, 'ineligible');
  const noEvidence = app.createJob({ title: '专家', originalText: '没有学历门槛的原文', knownConditions: ['博士学历'] });
  assert.equal(app.evaluateEligibility(noEvidence.id, { profile }).status, 'pending');
  const soft = app.evaluateEligibility(job(app, '具有良好沟通能力和团队合作精神').id, { profile });
  assert.equal(soft.checks[0].status, 'information');
  assert.notEqual(soft.status, 'ineligible');
  assert.equal(soft.checks.some(check => check.status === 'pending'), false);
});

test('不把派遣管理职责、仅本科限制或优先博士误解释为派遣／最低博士', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  const supplier = app.evaluateEligibility(job(app, '负责劳务派遣供应商管理').id, { profile });
  assert.notEqual(supplier.status, 'ineligible');
  assert.equal(app.evaluateEligibility(job(app, '本岗位非劳务派遣用工').id, { profile }).status, 'verified');
  assert.equal(app.evaluateEligibility(job(app, '仅限本科毕业生').id, { profile }).status, 'ineligible');
  const noExplicit = app.evaluateEligibility(app.createJob({ title: '未披露条件', originalText: '只有招聘标题', knownConditions: [] }).id, { profile });
  assert.notEqual(noExplicit.status, 'verified');
  assert.match(noExplicit.statement, /未取得明确条件/);
});

test('公告公共和附件条件参与资格，资料重算保留历史，不新增岗位或覆盖投递', async t => {
  const originalText = '公共条件：硕士及以上。岗位：算法专家，工作地点北京或上海。';
  const output = { commonConditions: [{ text: '硕士及以上', evidence: [{ documentId: 'announcement', locator: '正文', quote: '硕士及以上' }] }], jobs: [{
    title: '算法专家', recruitmentUnit: null, contractingEntity: null, department: null, batch: null, locations: ['北京', '上海'], duties: null,
    conditions: [{ text: '须持有CFA证书', evidence: [{ documentId: 'attachment-1', locator: '全文', quote: '须持有CFA证书' }] }],
    evidence: [{ documentId: 'announcement', locator: '正文', quote: '岗位：算法专家，工作地点北京或上海' }], applicationPath: null, unknownFields: [], dateEvidence: [],
  }], inputGaps: [] };
  const app = createApplication({ ...setup(t), announcementProcessor: { process: async () => output } }); t.after(() => app.close());
  const announcement = await app.createAnnouncement({ title: '模拟公告', originalText, attachments: [{ name: '条件.txt', mediaType: 'text/plain', contentBase64: Buffer.from('须持有CFA证书').toString('base64') }] });
  const processed = await app.processAnnouncement(announcement.id);
  assert.equal(processed.status, 'processed');
  const id = processed.jobIds[0]; app.setApplied(id, true);
  const first = app.evaluateEligibility(id, { profile });
  assert.equal(first.status, 'pending');
  assert.equal(first.checks[1].evidence[0].documentId, 'attachment-1');
  const second = app.evaluateEligibility(id, { profile: { ...profile, version: '模拟个人资料v2', certificates: ['CFA'] } });
  assert.equal(second.status, 'verified');
  assert.equal(app.listEligibility(id).length, 2);
  assert.equal(app.listEligibility(id)[1].profileVersion, '模拟个人资料v1');
  assert.equal(app.listJobs().length, 1);
  assert.equal(app.getPersonalState(id).applied, true);
  assert.equal(app.listApplications()[0].resumeVersion, null);
});

test('Web展示资格理由与证据版本，HTTP资格核验结果可读取', async t => {
  const { startServer } = await import('../src/server.mjs');
  const app = createApplication(setup(t)); const saved = job(app, '博士研究生学历');
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + `/api/jobs/${saved.id}/eligibility`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ineligible');
  const detail = await (await fetch(base + `/jobs/${saved.id}`)).text();
  assert.match(detail, /明确不符合/);
  assert.match(detail, /博士研究生学历/);
  assert.match(detail, /模拟个人资料v1/);
  assert.match(detail, /eligibility-v3/);
  assert.match(await (await fetch(base + '/jobs')).text(), /不满足/);
  const latest = await (await fetch(base + `/api/jobs/${saved.id}/eligibility`)).json();
  assert.equal(latest.profileVersion, '模拟个人资料v1');
});

test('明确双边出生范围及缺失附件不能被普通已核验学历掩盖', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  const range = job(app, '1990年10月8日至1995年10月7日出生');
  assert.equal(app.evaluateEligibility(range.id, { profile }).status, 'verified');
  assert.equal(app.evaluateEligibility(range.id, { profile: { ...profile, version: '模拟越界', birthday: '1995-10-08' } }).status, 'ineligible');
  const missing = job(app, '硕士及以上', { unknownFields: ['公共资格附件未取得'] });
  assert.equal(app.evaluateEligibility(missing.id, { profile }).status, 'pending');
  assert.equal(app.evaluateEligibility(job(app, '硕士及以上', { unknownFields: ['薪酬未披露', '签约主体未披露'] }).id, { profile }).status, 'verified');
});

test('同条中专业学历年龄经验分别核验，例外与否定仍保留原语义', t => {
  const app = createApplication(setup(t)); t.after(() => app.close());
  const facts = { ...profile, major: '计算机', experiences: [{ domain: 'AI', startMonth: '2020-01', endMonth: '2023-01' }] };
  const result = app.evaluateEligibility(job(app, '计算机专业博士学历').id, { profile: facts });
  assert.equal(result.status, 'ineligible');
  for(const clause of ['博士学历且具有良好沟通能力','博士学历并非劳务派遣']) assert.equal(app.evaluateEligibility(job(app,clause).id,{profile:facts}).status,'ineligible');
  assert.equal(result.checks.some(check => check.facts?.requiredEducation === '博士'), true);
  assert.equal(result.checks.every(check => check.originalCondition === '计算机专业博士学历' && check.evidence[0].quote === '计算机专业博士学历'), true);
  assert.equal(app.evaluateEligibility(job(app, '计算机专业硕士学历').id, { profile: facts }).status, 'verified');
  assert.equal(app.evaluateEligibility(job(app, '硕士学历且须为中共党员').id, { profile: facts }).status, 'pending');
  assert.equal(app.evaluateEligibility(job(app, '硕士学历须为中共党员').id, { profile: facts }).status, 'pending');
  assert.equal(app.evaluateEligibility(job(app, '硕士学历且博士优先').id, { profile: facts }).status, 'verified');
  assert.equal(result.checks.every(check => check.scope === 'manual'), true);
  for (const clause of ['年龄不超过35周岁及博士学历，截至2026年10月7日', '须持有CFA证书及博士学历']) assert.equal(app.evaluateEligibility(job(app, clause).id, { profile: {...facts, certificates:['CFA']} }).status, 'ineligible');
  assert.equal(app.evaluateEligibility(job(app, '硕士学历且年龄不超过35周岁，截至2026年10月8日').id, { profile: facts }).status, 'ineligible');
  assert.equal(app.evaluateEligibility(job(app, '计算机专业硕士学历且具有3年AI项目经验').id, { profile: facts }).status, 'verified');
  assert.equal(app.evaluateEligibility(job(app, '不要求博士学历，计算机专业').id, { profile: facts }).status, 'verified');
  for (const clause of ['原则上计算机专业博士学历', '计算机专业博士学历或具有10年AI项目经验', '计算机专业博士学历，特别优秀者可放宽']) {
    assert.equal(app.evaluateEligibility(job(app, clause).id, { profile: facts }).status, 'pending');
  }
});


test('旧v1误判夹具重启后只留历史，不放行行动；人工重验生成v2且原快照保留', async t => {
  const options = { ...setup(t), matchingProcessor: { match: async ({ job }) => {
    const dimension = { level: 'unknown', explanation: '模拟资料缺口', directExperiences: [], transferableAbilities: [], gaps: ['模拟职责依据不足'], jobQuotes: [job.originalText] };
    return { technical: dimension, business: dimension, scope: dimension, route: 'uncertain', routeExplanation: '模拟资料缺口，不推断路线', uncertainties: ['模拟待核验'] };
  } } };
  let app = createApplication(options);
  const saved = job(app, '计算机专业博士学历');
  const facts = { ...profile, major: '计算机' };
  const current = app.evaluateEligibility(saved.id, { profile: facts });
  app.saveCareerProfile({ text: '模拟职业资料', version: profile.version, sourceId: 'manual' });
  app.close();
  // Legacy persisted input fixture, created only in this test's temporary database.
  const fixture = new DatabaseSync(options.databasePath);
  fixture.prepare('UPDATE eligibility_results SET body=? WHERE id=?').run(JSON.stringify({ ...current, ruleVersion: 'eligibility-v1', status: 'verified', checks: [ { ...current.checks[0], status: 'verified' } ] }), current.id);
  fixture.close();
  app = createApplication(options); t.after(() => app.close());
  assert.equal(app.getEligibility(saved.id).status, 'verified');
  assert.equal(app.getEligibility(saved.id).stale, true);
  assert.equal(app.listJobs({ eligibility: 'verified' }).length, 0);
  assert.equal(app.listJobs({ eligibility: 'needs_review' })[0].id, saved.id);
  await app.matchJob(saved.id);
  assert.equal(app.getMatch(saved.id).qualificationAllowsAction, false);
  const next = app.evaluateEligibility(saved.id, { profile: facts });
  assert.equal(next.ruleVersion, 'eligibility-v3');
  assert.equal(next.status, 'ineligible');
  assert.equal(app.listEligibility(saved.id).length, 2);
  assert.equal(app.listEligibility(saved.id)[1].ruleVersion, 'eligibility-v1');
  assert.equal(app.listEligibility(saved.id)[1].jobSnapshot.originalText, '计算机专业博士学历');
});

test('职业资格事实更正后旧符合需重验，重启及重新核验保留历史', t => {
  const options=setup(t); let app=createApplication(options);
  const saved=job(app,'博士学历');
  const career=app.saveCareerProfile({sourceId:'manual',version:'facts-v1',text:'模拟博士资料',qualificationFacts:{education:'博士'}});
  const original=app.evaluateEligibility(saved.id,{profile:{...career.qualificationFacts,version:career.version}});
  assert.equal(original.status,'verified');
  // Seed the original persisted v2 shape, which predates profile provenance.
  app.close();
  const legacyDb=new DatabaseSync(options.databasePath);
  const legacy={...original};delete legacy.profileSource;delete legacy.profileStale;
  legacyDb.prepare('UPDATE eligibility_results SET body=? WHERE id=?').run(JSON.stringify(legacy),original.id);legacyDb.close();
  app=createApplication(options);
  app.saveCareerProfile({sourceId:'manual',version:'facts-v2',text:'模拟更正硕士资料',qualificationFacts:{education:'硕士'}});
  assert.equal(app.getEligibility(saved.id).profileStale,true);
  assert.equal(app.getEligibility(saved.id).stale,true);
  assert.deepEqual(app.listJobs({eligibility:'verified'}),[]);
  assert.deepEqual(app.listJobs({eligibility:'needs_review'}).map(x=>x.id),[saved.id]);
  app.close();app=createApplication(options);t.after(()=>app.close());
  assert.equal(app.getEligibility(saved.id).profileSnapshot.education,'博士');
  assert.equal(app.getEligibility(saved.id).profileStale,true);
  const current=app.listCareerProfiles()[0];
  assert.equal(app.evaluateEligibility(saved.id,{profile:{education:'硕士',version:current.version},careerProfileId:current.id}).status,'ineligible');
  const history=app.listEligibility(saved.id);
  assert.equal(history.length,2);assert.equal(history[1].id,original.id);
  assert.equal(history[1].profileSnapshot.education,'博士');
  assert.equal(history[0].profileStale,false);
});

test('无资格事实的职业原文刷新不冒充资格变化或硬排除', t => {
  const app=createApplication(setup(t));t.after(()=>app.close());
  const saved=job(app,'博士学历');
  const career=app.saveCareerProfile({sourceId:'manual',version:'facts-v1',text:'模拟博士资料',qualificationFacts:{education:'博士'}});
  app.evaluateEligibility(saved.id,{profile:{education:'博士',version:career.version}});
  app.saveCareerProfile({sourceId:'manual',version:'text-v2',text:'只改职业原文，没有明确资格事实'});
  const result=app.getEligibility(saved.id);
  assert.equal(result.status,'verified');assert.equal(result.profileStale,false);assert.equal(result.stale,false);
  assert.equal(result.profileSnapshot.education,'博士');assert.equal(result.profileVersion,'facts-v1');
});

test('独立手工资格保留来源及版本，不被同版本职业资料机械关联', t => {
  const app=createApplication(setup(t));t.after(()=>app.close());
  const saved=job(app,'博士学历');
  app.saveCareerProfile({sourceId:'manual',version:'shared-label',text:'模拟职业资料',qualificationFacts:{education:'博士'}});
  app.evaluateEligibility(saved.id,{profile:{source:'manual',version:'shared-label',education:'博士'}});
  app.saveCareerProfile({sourceId:'manual',version:'career-v2',text:'模拟职业资格更正',qualificationFacts:{education:'硕士'}});
  const result=app.getEligibility(saved.id);
  assert.equal(result.profileStale,false);assert.equal(result.stale,false);
  assert.equal(result.profileSource.kind,'manual');assert.equal(result.profileSnapshot.source,'manual');
  assert.equal(result.profileVersion,'shared-label');assert.equal(app.listJobs({eligibility:'verified'}).length,1);
});

test('同版本事实有多个职业来源时不猜关联，明确指定档案后才成为当前资格',t=>{
  const app=createApplication(setup(t));t.after(()=>app.close());
  const saved=job(app,'博士学历');
  app.saveCareerProfile({sourceId:'manual',version:'same-v1',text:'模拟手动职业档案',qualificationFacts:{education:'博士'}});
  const current=app.saveCareerProfile({sourceId:'20000101000000-example',version:'same-v1',text:'模拟指定来源档案',qualificationFacts:{education:'博士'}});
  const uncertain=app.evaluateEligibility(saved.id,{profile:{version:'same-v1',education:'博士'}});
  assert.equal(uncertain.profileSource.kind,'unresolved');assert.equal(uncertain.stale,true);assert.equal(app.listJobs({eligibility:'verified'}).length,0);
  const resolved=app.evaluateEligibility(saved.id,{profile:{version:'same-v1',education:'博士'},careerProfileId:current.id});
  assert.equal(resolved.profileSource.careerProfileId,current.id);assert.equal(resolved.stale,false);
  assert.throws(()=>app.evaluateEligibility(saved.id,{profile:{version:'same-v1',education:'硕士'},careerProfileId:current.id}),/资格事实及版本/);
});

test('Web详情将职业资格资料变化与历史符合一起解释为需重验',async t=>{
  const app=createApplication(setup(t));t.after(()=>app.close());
  const saved=job(app,'博士学历');
  app.saveCareerProfile({sourceId:'manual',version:'v1',text:'模拟博士',qualificationFacts:{education:'博士'}});
  app.evaluateEligibility(saved.id,{profile:{version:'v1',education:'博士'}});
  app.saveCareerProfile({sourceId:'manual',version:'v2',text:'模拟硕士',qualificationFacts:{education:'硕士'}});
  const {startServer}=await import('../src/server.mjs');const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const html=await(await fetch(`http://127.0.0.1:${server.address().port}/jobs/${saved.id}`)).text();
  assert.match(html,/资格资料已变化或来源待确认/);assert.match(html,/历史判断需重新核验/);
});

test('同一人的职业档案跨来源更新明确事实后，旧关联资格需重验',t=>{
  const options=setup(t);let app=createApplication(options);
  const saved=job(app,'博士学历');
  const career=app.saveCareerProfile({sourceId:'20000101000000-example',version:'life-v1',text:'模拟指定职业档案博士',qualificationFacts:{education:'博士'}});
  const original=app.evaluateEligibility(saved.id,{profile:{version:career.version,education:'博士'},careerProfileId:career.id});
  assert.equal(original.status,'verified');
  const current=app.saveCareerProfile({sourceId:'manual',version:'career-manual-v2',text:'模拟手动职业档案更正硕士',qualificationFacts:{education:'硕士'}});
  assert.equal(app.listCareerProfiles()[0].id,current.id);
  assert.equal(app.getEligibility(saved.id).profileStale,true);
  assert.equal(app.getEligibility(saved.id).stale,true);
  assert.equal(app.listJobs({eligibility:'verified'}).length,0);
  assert.deepEqual(app.listJobs({eligibility:'needs_review'}).map(x=>x.id),[saved.id]);
  app.close();app=createApplication(options);t.after(()=>app.close());
  assert.equal(app.getEligibility(saved.id).profileSource.sourceId,'20000101000000-example');
  assert.equal(app.getEligibility(saved.id).profileSnapshot.education,'博士');
  assert.equal(app.getEligibility(saved.id).profileStale,true);
  const corrected=app.evaluateEligibility(saved.id,{profile:{version:current.version,education:'硕士'},careerProfileId:current.id});
  assert.equal(corrected.status,'ineligible');assert.equal(corrected.profileStale,false);
  assert.equal(app.listEligibility(saved.id)[1].id,original.id);
});
