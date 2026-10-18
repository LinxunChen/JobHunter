import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './helpers/career-application.mjs';
const sourceId = '20000101000000-example';
const original = '模拟个人资料：负责推荐模型开发，主导算法系统设计。';
const jobText = '算法专家负责推荐模型开发，主导算法系统设计。';
const output = () => {
  const dimension = { level: 'medium', explanation: '模拟有依据匹配', directExperiences: [], transferableAbilities: [], gaps: ['模拟证据仍需核验'], jobQuotes: ['负责推荐模型开发'] };
  return { technical: dimension, business: dimension, scope: dimension, route: 'expert', routeExplanation: '实际算法职责', uncertainties: ['模拟输出'] };
};
function setup(t, source, matcher = { match: async () => output() }) {
  const dir = mkdtempSync(join(tmpdir(), 'job-hunter-career-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = new Date('2026-10-07T02:00:00Z');
  return { options: { databasePath: join(dir, 'test.sqlite'), now: () => clock, announcementProcessor: null, matchingProcessor: matcher, careerSource: source }, at: value => { clock = new Date(value); } };
}
const snapshot = text => ({ id: sourceId, text, complete: true, windows: [{ blockStart: 0, returnedBlocks: 2, totalBlocks: 2, hasNextWindow: false }] });

test('指定职业概览仅实质变化重算，保持岗位、申请实际版本和重启历史', async t => {
  let text = original;
  const { options } = setup(t, { readCareerOverview: async () => snapshot(text) });
  let app = createApplication(options); t.after(() => app.close());
  const first = await app.refreshCareerProfile();
  assert.equal(first.status, 'completed'); assert.equal(first.change, 'initial');
  const job = app.createJob({ title: '算法专家', originalText: jobText });
  await app.matchJob(job.id);
  const applied = app.setApplied(job.id, true); app.updateApplication(applied.id, { resumeVersion: '实际提交-旧版', notes: '本人备注' });
  text = original + '\n\n{: id="20261007000000-example" updated="20261008000000"}';
  const unchanged = await app.refreshCareerProfile();
  assert.equal(unchanged.change, 'unchanged'); assert.equal(app.listMatches(job.id).length, 1); assert.equal(app.listCareerProfiles().length, 1);
  text = original + '新增模拟事实：负责模型评测标准。';
  const changed = await app.refreshCareerProfile();
  assert.equal(changed.change, 'material'); assert.equal(changed.recomputed[0].status, 'completed');
  assert.equal(app.listJobs().length, 1); assert.equal(app.listMatches(job.id).length, 2);
  assert.notEqual(app.getMatch(job.id).profileVersion, first.profileVersion);
  assert.equal(app.getApplication(applied.id).resumeVersion, '实际提交-旧版'); assert.equal(app.getApplication(applied.id).notes, '本人备注');
  app.close(); app = createApplication(options);
  assert.equal(app.getCareerRefresh().id, changed.id); assert.equal(app.listCareerRefreshes().length, 3);
  assert.equal(app.listCareerProfiles().length, 2); assert.equal(app.getApplication(applied.id).resumeVersion, '实际提交-旧版');
});

test('周检查按最近成功时间到期，来源故障、其他文档或不完整分页保留旧版本并可重试', async t => {
  let selected = snapshot(original);
  let fail = false;
  const { options, at } = setup(t, { readCareerOverview: async () => { if (fail) throw new Error('敏感连接详情不能进入公开回执'); return selected; } });
  const app = createApplication(options); t.after(() => app.close());
  const first = await app.refreshCareerProfile({ trigger: 'weekly' });
  at('2026-10-13T02:00:00Z'); fail = true;
  const early = await app.refreshCareerProfile({ trigger: 'weekly' });
  assert.equal(early.status, 'not_due'); assert.equal(app.getCareerRefresh().id, first.id);
  at('2026-10-14T02:00:00Z');
  const failed = await app.refreshCareerProfile({ trigger: 'weekly' });
  assert.equal(failed.status, 'failed'); assert.match(failed.gaps[0], /旧档案/); assert.doesNotMatch(JSON.stringify(failed), /敏感连接详情/);
  assert.equal(app.listCareerProfiles().length, 1);
  fail = false; selected = { ...snapshot(original + '模拟新事实'), complete: false };
  assert.equal((await app.refreshCareerProfile()).status, 'failed');
  selected = { ...snapshot(original + '模拟新事实'), id: '禁止其他文档' };
  assert.equal((await app.refreshCareerProfile()).status, 'failed'); assert.equal(app.listCareerProfiles().length, 1);
  selected = snapshot(original);
  assert.equal((await app.refreshCareerProfile({ trigger: 'weekly' })).status, 'completed');
  await assert.rejects(app.refreshCareerProfile({ trigger: 'scan-all-notes' }), /手动或周检查/);
});

test('窄Life MCP源完整分页后才采用，通过应用刷新且拒绝漏页', async t => {
  const { createLifeCareerSource } = await import('../src/career-life.mjs');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'job-hunter-life-adapter-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ enabled: true, host: '127.0.0.1', port: 36807, authEnabled: true, token: 'simulation-only-token' }));
  let incomplete = false;
  const source = createLifeCareerSource({ settingsPath, fetcher: async (_url, options) => {
    if (options.method === 'DELETE') return new Response('', { status: 200 });
    const input = JSON.parse(options.body);
    if (input.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { protocolVersion: '2024-11-05' } }), { headers: { 'Mcp-Session-Id': 'simulated-session' } });
    if (input.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (input.method !== 'tools/call' || input.params.name !== 'document' || input.params.arguments.action !== 'get_doc' || input.params.arguments.id !== sourceId) throw new Error('模拟服务拒绝其他工具或文档');
    const start = input.params.arguments.blockStart;
    const doc = { id: sourceId, content: start === 0 ? original : '新增模拟事实：负责模型评测标准。', blockStart: start, returnedBlocks: start === 0 || incomplete ? 1 : 2, totalBlocks: 3, truncated: start === 0, hasNextWindow: start === 0, nextBlockStart: start === 0 ? 1 : undefined };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { structuredContent: doc } }));
  } });
  const { options } = setup(t, source); const app = createApplication(options); t.after(() => app.close());
  const first = await app.refreshCareerProfile();
  assert.equal(first.status, 'completed'); assert.equal(first.windows.length, 2);
  assert.match(app.getCareerProfile(first.profileId).text, /模型评测标准/);
  incomplete = true;
  assert.equal((await app.refreshCareerProfile()).status, 'failed'); assert.equal(app.listCareerProfiles().length, 1);
});

test('职业读取等待不持有写锁，跨应用重叠拒绝，关注与申请可立即保存', async t => {
  let release;
  const { options } = setup(t, { readCareerOverview: () => new Promise(resolve => { release = resolve; }) });
  const app = createApplication(options); const concurrent = createApplication(options); t.after(() => { concurrent.close(); app.close(); });
  const job = app.createJob({ title: '算法专家', originalText: jobText });
  const pending = app.refreshCareerProfile();
  const duplicate = concurrent.refreshCareerProfile();
  await assert.rejects(duplicate, /职业资料正在检查/);
  concurrent.setPersonalState(job.id, { followed: true }); concurrent.setApplied(job.id, true);
  assert.equal(app.getPersonalState(job.id).followed, true); assert.equal(app.getPersonalState(job.id).applied, true);
  release(snapshot(original));
  assert.equal((await pending).status, 'completed');
});

test('变化后的模型失败保留旧解释，手动重试必要加工且成功后无变化不重复计算', async t => {
  let text = original; let fail = false;
  const { options } = setup(t, { readCareerOverview: async () => snapshot(text) }, { match: async () => { if (fail) throw new Error('模拟Codex故障'); return output(); } });
  const app = createApplication(options); t.after(() => app.close());
  await app.refreshCareerProfile(); const job = app.createJob({ title: '算法专家', originalText: jobText });
  const previous = await app.matchJob(job.id);
  text += '新增模拟事实：负责模型评测标准。'; fail = true;
  const partial = await app.refreshCareerProfile();
  assert.equal(partial.status, 'partial'); assert.equal(app.getMatch(job.id).previousResult.id, previous.id);
  assert.equal(app.listCareerProfiles().length, 2); assert.equal(app.listJobs().length, 1);
  fail = false;
  const repaired = await app.refreshCareerProfile();
  assert.equal(repaired.change, 'unchanged'); assert.equal(repaired.recomputed[0].status, 'completed');
  const count = app.listMatches(job.id).length;
  await app.refreshCareerProfile(); assert.equal(app.listMatches(job.id).length, count);
});

test('Web手动刷新和检查异常可读，JSON周入口不重复加工且不泄露正文或凭据', async t => {
  const { startServer } = await import('../src/server.mjs');
  let fail = false;
  const { options } = setup(t, { readCareerOverview: async () => { if (fail) throw new Error('私密凭据不可外泄'); return snapshot(original); } });
  const app = createApplication(options); const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = await fetch(base + '/career/refresh', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'trigger=manual', redirect: 'manual' });
  assert.equal(saved.status, 303);
  const view = await (await fetch(base + '/career')).text(); assert.match(view, /检查指定职业概览/); assert.match(view, /初次读取/); assert.doesNotMatch(view, /模拟个人资料/);
  const checks = await (await fetch(base + '/api/career-refresh')).json(); assert.equal(checks[0].status, 'completed'); assert.doesNotMatch(JSON.stringify(checks), /模拟个人资料|token/);
  const early = await fetch(base + '/api/career-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"trigger":"weekly"}' });
  assert.equal(early.status, 200); assert.equal((await early.json()).status, 'not_due');
  fail = true;
  await fetch(base + '/career/refresh', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'trigger=manual' });
  const failure = await (await fetch(base + '/career')).text(); assert.match(failure, /检查失败/); assert.match(failure, /旧档案/); assert.doesNotMatch(failure, /私密凭据/);
});

test('已有旧档案模型等待时资料变化不放行过时解释，完成后可补算新版本', async t => {
  let text = original; let hold = false; let release;
  const { options } = setup(t, { readCareerOverview: async () => snapshot(text) }, { match: () => hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve(output()) });
  const app = createApplication(options); t.after(() => app.close());
  const first = await app.refreshCareerProfile(); const job = app.createJob({ title: '算法专家', originalText: jobText + '硕士及以上', knownConditions: ['硕士及以上'] });
  app.evaluateEligibility(job.id, { profile: { version: first.profileVersion, education: '硕士' } });
  await app.matchJob(job.id); hold = true; const oldPending = app.matchJob(job.id);
  text += '新增模拟事实：负责模型评测标准。';
  const updated = await app.refreshCareerProfile(); assert.equal(updated.status, 'partial'); assert.equal(updated.recomputed[0].status, 'deferred');
  release(output()); await oldPending; hold = false;
  assert.equal(app.getMatch(job.id).qualificationAllowsAction, false); assert.equal(app.getMatch(job.id).profileStale, true);
  const repaired = await app.refreshCareerProfile(); assert.equal(repaired.recomputed[0].status, 'completed');
  assert.equal(app.getMatch(job.id).profileVersion, updated.profileVersion); assert.equal(app.getMatch(job.id).profileStale, false);
});

test('联系方式省略须幂等，重复读取同一正文或旧省略标记不制造实质变化', async t => {
  let text = original + '\n联系方式：simulation@example.org';
  const { options } = setup(t, { readCareerOverview: async () => snapshot(text) });
  const app = createApplication(options); t.after(() => app.close());
  const first = await app.refreshCareerProfile();
  assert.equal((await app.refreshCareerProfile()).change, 'unchanged');
  text = app.getCareerProfile(first.profileId).text;
  assert.equal((await app.refreshCareerProfile()).change, 'unchanged'); assert.equal(app.listCareerProfiles().length, 1);
});
