import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
import { startServer } from '../src/server.mjs';
const profileText = '模拟本人事实：负责推荐排序研发和技术路线设计。';
const duties = '模拟岗位职责：负责推荐排序研发和技术路线设计。';
const pair = { profileQuote: '负责推荐排序研发和技术路线设计', jobQuote: '负责推荐排序研发和技术路线设计', explanation: '可核对的模拟直接研发经历' };
const dimension = { shortReason: '直接研发职责相符', level: 'high', explanation: '模拟直接职责对应', directExperiences: [pair], transferableAbilities: [], gaps: [], jobQuotes: [pair.jobQuote] };
async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jh-priority-views-'));
  const blocked = async () => { throw Error('本票禁止真实外部接入'); };
  const options = { databasePath: join(directory, 'jobs.sqlite'), now: () => new Date('2026-10-08T01:00:00Z'),
    announcementProcessor: null, matchingProcessor: { match: async ({ job }) => ({ technical: dimension, scope: dimension,
      business: job.title.includes('迁移') ? { ...dimension, level: 'low', directExperiences: [], gaps: ['模拟行业业务知识仍需补齐'] } : dimension,
      recommendation: {level: job.title.includes('迁移') ? 'consider' : 'priority', reason: job.title.includes('迁移') ? '技术可迁移，业务需补齐' : '有直接职责经历'}, routeEvidence: [pair.jobQuote], route: 'expert', routeExplanation: '负责技术路线及核心模型研发', uncertainties: [] }) },
    careerSource: null, notificationTransport: null, sourceFetch: blocked, ccbSourceFetch: blocked,
    icbcFetch: blocked, cmriFetch: blocked, sasacFetch: blocked };
  let app = createApplication(options), server = await startServer({ app, port: 0 });
  app.saveCareerProfile({ text: profileText, version: '模拟推荐v1', sourceId: 'manual' });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); rmSync(directory, { recursive: true, force: true }); });
  const seed = async (title, { conditions = ['硕士及以上'], historical = false, assess = true } = {}) => {
    const { job } = app.importJob({ title, recruitmentUnit: '模拟推荐研究院', contractingEntity: '模拟已知签约主体', duties,
      originalText: duties + conditions.join('；'), knownConditions: conditions, location: { options: ['北京'] },
      sourceIdentity: { sourceId: 'simulated-priority-source', externalId: title }, sourceUrl: 'https://example.invalid/' + encodeURIComponent(title),
      sourceEvidence: { listed: true, checkedAt: '2026-10-08T01:00:00Z' }, observedAt: '2026-10-08T01:00:00Z',
      evidenceUse: historical ? 'historical' : 'current', recruitmentStatus: 'publicly_listed_open',
      applicationPath: { kind: 'steps', url: 'https://example.invalid/apply', steps: '搜索模拟岗位编号再申请' } });
    if (assess) { app.evaluateEligibility(job.id, { profile: { version: '模拟推荐v1', education: '硕士' } }); assert.equal((await app.matchJob(job.id)).status, 'completed'); }
    return job;
  };
  // Insert the direct extension first: later entries currently sort before it by creation order.
  const direct = await seed('模拟优先直接延伸');
  const transfer = await seed('模拟可考虑迁移');
  const historical = await seed('模拟历史保留', { historical: true });
  const pending = await seed('模拟关键待核', { conditions: ['硕士及以上', '计算机专业'] });
  const ineligible = await seed('模拟明确不符', { conditions: ['博士学历'] });
  const unassessed = await seed('模拟尚未评估', { assess: false });
  return { get app() { return app; }, get base() { return `http://127.0.0.1:${server.address().port}`; },
    jobs: { direct, transfer, historical, pending, ineligible, unassessed },
    async restart() { await new Promise(resolve => server.close(resolve)); app.close(); app = createApplication(options); server = await startServer({ app, port: 0 }); } };
}

test('表格按当前直接延伸和迁移优先，关键待核独立展示具体缺口，保留历史与未评估', async t => {
  const s = await setup(t), j = s.jobs;
  assert.equal(s.app.getEligibility(j.pending.id).status, 'pending');
  assert.equal(s.app.getEligibility(j.ineligible.id).status, 'ineligible');
  const html = await (await fetch(s.base + '/jobs')).text();
  const position = job => html.indexOf(`>${job.title}</a>`);
  assert.ok(position(j.direct) < position(j.transfer), '直接经历延伸应先于后来入库的迁移岗');
  assert.ok(position(j.pending) < position(j.transfer), '资格未知仍可保留高匹配推荐');
  for (const job of [j.historical, j.ineligible, j.unassessed]) assert.ok(position(j.pending) < position(job));
  assert.match(html, /优先考虑/);
  assert.match(html, /专业未确认/);
  assert.match(html, /排除与历史/);
  assert.equal(new Set((await (await fetch(s.base + '/api/jobs')).json()).map(job => job.id)).size, 6);
  const opportunities = s.app.prepareDailyActions().opportunities;
  assert.deepEqual(new Set(opportunities.map(item => item.jobId)), new Set([j.direct.id, j.transfer.id, j.pending.id]));
  assert.ok(opportunities.findIndex(item => item.jobId === j.direct.id) < opportunities.findIndex(item => item.jobId === j.transfer.id));
  assert.equal(opportunities.find(item => item.jobId === j.pending.id).registrationAllowed, false);
  assert.equal(s.app.getMatch(j.pending.id).qualificationAllowsAction, false);
  for (const job of [j.ineligible, j.historical, j.unassessed]) assert.ok(!opportunities.some(item => item.jobId === job.id));
});

test('三页分层只重排当前集合，完整公开字段和筛选／重启保留；个人门禁仍限制通知', async t => {
  const s = await setup(t), j = s.jobs;
  for (const job of [j.direct, j.transfer, j.pending]) s.app.setPersonalState(job.id, { followed: true });
  for (const job of [j.direct, j.pending]) s.app.setApplied(job.id, true);
  const all = await (await fetch(s.base + '/api/jobs')).json();
  for (const [path, api, expected] of [['/jobs', '/api/jobs', Object.values(j)],
    ['/followed', '/api/followed', [j.direct, j.transfer, j.pending]], ['/applications', '/api/applied-jobs', [j.direct, j.pending]]]) {
    const subset = await (await fetch(s.base + api)).json();
    assert.deepEqual(new Set(subset.map(job => job.id)), new Set(expected.map(job => job.id)));
    for (const job of subset) assert.deepEqual(job, all.find(item => item.id === job.id));
    const html = await (await fetch(s.base + path)).text();
    for (const job of expected) assert.ok(html.includes(`>${job.title}</a>`));
    assert.match(html, /搜索模拟岗位编号再申请/);
    assert.match(html, /优先考虑/);
  }
  const filtered = await (await fetch(s.base + '/followed?eligibility=pending')).text();
  assert.match(filtered, /模拟关键待核/);
  assert.match(filtered, /专业未确认/);
  assert.doesNotMatch(filtered, /模拟优先直接延伸|模拟可考虑迁移|模拟尚未评估/);
  assert.deepEqual(s.app.prepareDailyActions().opportunities.map(item => item.jobId), [j.transfer.id]);
  s.app.setPersonalState(j.transfer.id, { notInterested: true });
  assert.equal(s.app.prepareDailyActions().opportunities.length, 0);
  const before = s.app.listJobView('all');
  await s.restart();
  assert.deepEqual(s.app.listJobView('all'), before);
  assert.deepEqual(new Set(s.app.listJobView('applied').map(job => job.id)), new Set([j.direct.id, j.pending.id]));
});

test('个人排除可撤销，三页保留关注投递与匹配事实，重启后只排除当前岗位', async t => {
  const s=await setup(t), job=s.jobs.transfer;
  s.app.setPersonalState(job.id,{followed:true});s.app.setApplied(job.id,true);
  const originalMatch=s.app.getMatch(job.id),originalApplications=s.app.listApplications(job.id);
  const response=await fetch(s.base+`/api/jobs/${job.id}/personal`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notInterested:true})});
  assert.equal(response.status,200);
  for(const view of ['all','followed','applied']) {
    const current=s.app.listJobView(view).find(x=>x.id===job.id);
    assert.equal(current.display.group,'history');assert.equal(current.display.recommendation.label,'个人排除');
  }
  assert.deepEqual(s.app.getMatch(job.id),originalMatch);assert.deepEqual(s.app.listApplications(job.id),originalApplications);
  s.app.importJob({...s.app.getSourceJob(job.id),sourceIdentity:{sourceId:'simulated-priority-source',externalId:job.title}});assert.equal(s.app.getPersonalState(job.id).notInterested,true);
  const nextBatch=s.app.importJob({...s.app.getSourceJob(job.id),batch:'模拟新批次',sourceIdentity:{sourceId:'simulated-priority-source',externalId:'新批次'}}).job;assert.notEqual(nextBatch.id,job.id);assert.equal(s.app.getPersonalState(nextBatch.id).notInterested,false);
  for(const route of ['/jobs','/followed','/applications']) {
    const html=await(await fetch(s.base+route)).text();
    assert.match(html,/data-action="notInterested"/);assert.match(html,/个人排除/);
    assert.doesNotMatch(html,/data-job-column="detail"/);
    const row=html.match(new RegExp(`<tr data-job-row data-job-id="${job.id}">([\\s\\S]*?)</tr>`))[1];
    const title=row.match(/<td data-job-column="title">([\s\S]*?)<\/td>/)[1];
    assert.doesNotMatch(title,/subline|job-records/);assert.equal((title.match(/<a /g)??[]).length,1);assert.match(title,/href="https:\/\/example.invalid\/apply" target="_blank"/);
  }
  assert.equal((await(await fetch(s.base+'/api/jobs?recommendation=excluded')).json()).length,1);
  await s.restart();assert.equal(s.app.listJobView().find(x=>x.id===job.id).display.recommendation.label,'个人排除');
  assert.equal(s.app.getPersonalState(s.jobs.direct.id).notInterested,false);
  s.app.setPersonalState(job.id,{notInterested:false});
  assert.equal(s.app.listJobView().find(x=>x.id===job.id).display.group,'active');
  assert.equal(s.app.listJobView().find(x=>x.id===job.id).display.recommendation.label,'可以考虑');
  assert.deepEqual(s.app.listApplications(job.id),originalApplications);
});
