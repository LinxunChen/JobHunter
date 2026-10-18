import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
const profileText = '模拟个人资料：负责推荐排序模型开发及广告效果优化。主导算法系统方案设计和业务落地。不包含金融风险建模或监管专业项目。';
const jobText = '算法专家负责推荐排序建模与广告效果优化，制定技术路线，独立负责核心系统，不要求带团队。';
const pair = { profileQuote: '负责推荐排序模型开发及广告效果优化', jobQuote: '负责推荐排序建模与广告效果优化', explanation: '有直接推荐与广告项目事实' };
const dimension = () => ({ level: 'high', explanation: '模拟直接匹配解释', directExperiences: [pair], transferableAbilities: [], gaps: [], jobQuotes: ['负责推荐排序建模与广告效果优化'] });
const output = { technical: dimension(), business: dimension(), scope: dimension(), route: 'expert', routeExplanation: '按实际技术路线和核心系统职责识别专家路线，带团队不是硬门槛', uncertainties: [] };
function setup(t, processor) {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-matching-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, 'jobs.sqlite'), announcementProcessor: null, matchingProcessor: processor, now: () => new Date('2026-10-07T02:00:00Z') };
}

test('Codex边界模拟三维匹配，原文和资料版本可追溯，重启与重算不新增岗位', async t => {
  const options = setup(t, { match: async () => ({ output, receipt: { model: 'gpt-6.1-sol', simulated: true } }) });
  const app = createApplication(options);
  const profile = app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual' });
  const job = app.createJob({ title: '算法专家', originalText: jobText });
  const result = await app.matchJob(job.id, { profileId: profile.id });
  assert.equal(result.status, 'completed');
  assert.equal(result.output.technical.level, 'high');
  assert.equal(result.output.business.directExperiences[0].profileQuote, pair.profileQuote);
  assert.equal(result.output.route, 'expert');
  assert.equal(result.profileVersion, '模拟v1');
  assert.equal(result.profileHash, profile.hash);
  assert.equal(result.jobSnapshot.originalText, jobText);
  assert.equal(result.matchVersion, 'career-match-v2');
  await app.matchJob(job.id, { profileId: profile.id });
  assert.equal(app.listMatches(job.id).length, 2);
  assert.equal(app.listJobs().length, 1);
  app.close(); const restarted = createApplication(options); t.after(() => restarted.close());
  assert.equal(restarted.getMatch(job.id).profileVersion, '模拟v1');
  assert.equal(restarted.getCareerProfile(profile.id).text, profileText);
});

test('拒绝编造引文、总分、品牌推高以及缺证据的职责层级，失败保留旧结果', async t => {
  let selected = structuredClone(output);
  const app = createApplication(setup(t, { match: async () => selected })); t.after(() => app.close());
  const profile = app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual' });
  const job = app.createJob({ title: '算法专家', originalText: jobText });
  await app.matchJob(job.id, { profileId: profile.id });
  selected.technical.directExperiences[0].profileQuote = '不存在的Python金融监管经历';
  const fabricated = await app.matchJob(job.id, { profileId: profile.id });
  assert.equal(fabricated.status, 'failed');
  assert.equal(fabricated.output, null);
  assert.equal(fabricated.previousResult.output.technical.level, 'high');
  selected = { ...structuredClone(output), totalScore: 100 };
  assert.equal((await app.matchJob(job.id, { profileId: profile.id })).status, 'failed');
  const brandProfile = app.saveCareerProfile({ text: '在示例企业工作', version: '模拟品牌v1', sourceId: 'manual' });
  selected = structuredClone(output);
  for (const dimension of ['technical', 'business', 'scope']) selected[dimension].directExperiences[0].profileQuote = '在示例企业工作';
  assert.equal((await app.matchJob(job.id, { profileId: brandProfile.id })).status, 'failed');
  const titleOnly = app.createJob({ title: '高级经理', originalText: '高级经理' });
  selected = structuredClone(output);
  for (const dimension of ['technical', 'business', 'scope']) { selected[dimension].jobQuotes = ['高级经理']; selected[dimension].directExperiences[0].jobQuote = '高级经理'; }
  assert.equal((await app.matchJob(titleOnly.id, { profileId: profile.id })).status, 'failed');
});

test('高技术不能放行博士资格，Codex失败原文及旧结果保留', async t => {
  let fail = false;
  const app = createApplication(setup(t, { match: async () => { if (fail) throw new Error('模拟Codex失败'); return output; } })); t.after(() => app.close());
  const profile = app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual', qualificationFacts: { education: '硕士' } });
  const job = app.createJob({ title: '算法专家', originalText: jobText + '明确要求博士学历。', knownConditions: ['博士学历'] });
  app.evaluateEligibility(job.id, { profile: { version: profile.version, education: '硕士' } });
  const completed = await app.matchJob(job.id, { profileId: profile.id });
  assert.equal(completed.output.technical.level, 'high');
  assert.equal(completed.qualification.status, 'ineligible');
  assert.equal(completed.qualificationAllowsAction, false);
  fail = true;
  const failed = await app.matchJob(job.id, { profileId: profile.id });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.output, null);
  assert.match(failed.gaps[0], /Codex失败/);
  assert.equal(failed.previousResult.id, completed.id);
  assert.equal(app.getJob(job.id).originalText, jobText + '明确要求博士学历。');
});

test('农业方向保留迁移解释、行业及年限缺口，未知职责不被低年限门槛定为初级', async t => {
  const agricultural = '农业AI解决方案经理负责农业场景AI解决方案设计，需要5年农业科技及3年AI产品经验。';
  const transfer = { profileQuote: pair.profileQuote, jobQuote: '负责农业场景AI解决方案设计', explanation: '模型与系统能力可迁移，农业专业知识未证实' };
  const migration = { technical: { level: 'medium', explanation: '部分模型能力可迁移', directExperiences: [], transferableAbilities: [transfer], gaps: ['完整AI产品经验精确年月缺少'], jobQuotes: [transfer.jobQuote] }, business: { level: 'low', explanation: '农业专业经验缺少', directExperiences: [], transferableAbilities: [], gaps: ['农业科技直接经历未见依据'], jobQuotes: ['5年农业科技'] }, scope: { level: 'unknown', explanation: '缺少负责范围，不凭年限和头衔判定初级或管理岗', directExperiences: [], transferableAbilities: [], gaps: ['岗位授权和负责范围'], jobQuotes: [transfer.jobQuote] }, route: 'uncertain', routeExplanation: '需要职责范围证据', uncertainties: ['不是本人已符合全部条件'] };
  const app = createApplication(setup(t, { match: async () => migration })); t.after(() => app.close());
  const profile = app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual' });
  const job = app.createJob({ title: '农业AI解决方案经理', originalText: agricultural });
  const result = await app.matchJob(job.id, { profileId: profile.id });
  assert.equal(result.status, 'completed');
  assert.equal(result.output.technical.directExperiences.length, 0);
  assert.equal(result.output.technical.transferableAbilities.length, 1);
  assert.match(result.output.business.gaps[0], /农业/);
  assert.equal(result.output.scope.level, 'unknown');
  assert.equal(result.qualificationAllowsAction, false);
});

test('匹配模型等待不持有写锁，跨应用重复加工拒绝，个人投递可立即保存', async t => {
  let complete;
  const options = setup(t, { match: () => new Promise(resolve => { complete = resolve; }) });
  const app = createApplication(options); const concurrent = createApplication(options);
  t.after(() => { concurrent.close(); app.close(); });
  const profile = app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual' });
  const job = app.createJob({ title: '算法专家', originalText: jobText });
  const pending = app.matchJob(job.id, { profileId: profile.id });
  assert.equal(concurrent.getMatch(job.id).status, 'processing');
  await assert.rejects(concurrent.matchJob(job.id, { profileId: profile.id }), /正在匹配/);
  concurrent.setApplied(job.id, true);
  assert.equal(app.getPersonalState(job.id).applied, true);
  complete(output); assert.equal((await pending).status, 'completed');
});

test('Web保存档案并触发匹配，列表和详情三维解释、缺口及失败可读', async t => {
  const { startServer } = await import('../src/server.mjs');
  let fail = false;
  const app = createApplication(setup(t, { match: async () => { if (fail) throw new Error('模拟匹配断网'); return output; } }));
  const job = app.createJob({ title: '算法专家', originalText: jobText });
  const server = await startServer({ app, port: 0 }); t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = await fetch(base + '/api/career-profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: profileText, version: '模拟v1', sourceId: 'manual' }) });
  assert.equal(saved.status, 201); const profile = await saved.json();
  const matched = await fetch(base + `/api/jobs/${job.id}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: profile.id }) });
  assert.equal(matched.status, 200); assert.equal((await matched.json()).status, 'completed');
  const detail = await (await fetch(base + `/jobs/${job.id}`)).text();
  assert.match(detail, /专业匹配/); assert.match(detail, /业务匹配/); assert.match(detail, /职责层级匹配/);
  assert.match(detail, /直接经历/); assert.match(detail, /可迁移能力/); assert.match(detail, /专业差距/);
  assert.match(detail, /模拟v1/);
  assert.match(await (await fetch(base + '/jobs')).text(), /专业：高/);
  fail = true;
  await fetch(base + `/api/jobs/${job.id}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.match(await (await fetch(base + `/jobs/${job.id}`)).text(), /模拟匹配断网/);
  assert.match(await (await fetch(base + `/jobs/${job.id}`)).text(), /保留此前/);
});

test('资格后续明确不符时历史高匹配仍可读，却不能继续放行行动资格', async t => {
  const app = createApplication(setup(t, { match: async () => output })); t.after(() => app.close());
  const profile = app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual' });
  const job = app.createJob({ title: '算法专家', originalText: jobText + '硕士及以上', knownConditions: ['硕士及以上'] });
  app.evaluateEligibility(job.id, { profile: { version: '模拟v1', education: '硕士' } });
  assert.equal((await app.matchJob(job.id, { profileId: profile.id })).qualificationAllowsAction, true);
  app.evaluateEligibility(job.id, { profile: { version: '模拟v2', education: '本科' } });
  assert.equal(app.getMatch(job.id).qualificationAllowsAction, false);
  assert.equal(app.getMatch(job.id).output.technical.level, 'high');
});

test('成功回执但引文拒收时保留输出与具体字段，原文同版本可零模型复验且不放宽校验',async t=>{
 let calls=0;const bad=structuredClone(output);bad.technical.jobQuotes=['不存在的改写职责'];
 const app=createApplication(setup(t,{match:async()=>{calls++;return {output:calls===1?output:bad,receipt:{model:'gpt-6.1-sol',completed:true}};}}));t.after(()=>app.close());
 app.saveCareerProfile({text:profileText,version:'v1',sourceId:'manual'});const job=app.createJob({title:'算法专家',originalText:jobText});
 const prior=await app.matchJob(job.id);const failed=await app.withModelBatch(()=>app.matchJob(job.id),{automatic:true});
 assert.equal(failed.status,'failed');assert.equal(failed.output,null);assert.equal(failed.previousResult.id,prior.id);
 assert.deepEqual(failed.rejectedMatching.output,bad);assert.equal(failed.validationFailure.field,'technical.jobQuotes');assert.equal(failed.validationFailure.reason,'not_literal');
 const budget=app.getModelBudgetStatus().used;const again=await app.withModelBatch(()=>app.matchJob(job.id,{revalidateSavedOutput:true}),{automatic:true});
 assert.equal(again.status,'failed');assert.equal(again.revalidation.matchId,failed.id);assert.equal(calls,2);assert.equal(app.getModelBudgetStatus().used,budget);
 app.saveCareerProfile({text:profileText+' 新确认职责。',version:'v2',sourceId:'manual'});
 await assert.rejects(app.matchJob(job.id,{revalidateSavedOutput:true}),/同一岗位和职业资料版本/);assert.equal(calls,2);
});
