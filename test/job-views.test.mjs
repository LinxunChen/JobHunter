import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
import { startServer } from '../src/server.mjs';

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jh-job-views-'));
  const noExternal = async () => { throw Error('本票验证禁止外部接入'); };
  const options = { databasePath: join(directory, 'jobs.sqlite'), announcementProcessor: null,
    matchingProcessor: null, careerSource: null, sourceFetch: noExternal, ccbSourceFetch: noExternal,
    icbcFetch: noExternal, cmriFetch: noExternal, sasacFetch: noExternal, notificationTransport: null,
    now: () => new Date('2026-10-08T01:00:00Z') };
  let app = createApplication(options);
  let server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get app() { return app; }, get base() { return `http://127.0.0.1:${server.address().port}`; },
    async restart() { await new Promise(resolve => server.close(resolve)); app.close(); app = createApplication(options); server = await startServer({ app, port: 0 }); } };
}

test('四页导航默认岗位库，旧今日书签兼容跳转且只读通知API仍可用', async t => {
  const s = await setup(t);
  const root = await fetch(s.base + '/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/jobs');
  const legacy = await fetch(s.base + '/today', { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/jobs');
  const html = await (await fetch(s.base + '/jobs')).text();
  const nav = html.match(/<nav>(.*?)<\/nav>/s)[1];
  assert.equal((nav.match(/<a /g) ?? []).length, 4);
  assert.match(nav, /岗位库.*我的关注.*我的投递.*来源与设置/);
  assert.doesNotMatch(nav, /今日待处理/);
  assert.match(nav, /href="\/followed"/);
  assert.match(html, /尚未入库/);
  const today = await fetch(s.base + '/api/today');
  assert.equal(today.status, 200);
  assert.ok((await today.json()).notificationPolicy);
  assert.equal(s.app.getActionEvents().length, 0);
});

test('关注与投递形成完整岗位子集，五维筛选一致；撤销误勾退出投递并保留申请事件，重启可读', async t => {
  const s = await setup(t);
  const first = s.app.createJob({ title: '模拟大模型算法专家', recruitmentUnit: '模拟甲院', contractingEntity: '模拟签约主体',
    department: '算法部', batch: '模拟2026', originalText: '模拟原文：大模型算法研发，硕士及以上。', knownConditions: ['硕士及以上'],
    location: { options: ['北京', '上海'], note: '最终城市待确认' }, unknownFields: ['薪资未披露'],
    applicationPath: { kind: 'steps', url: 'https://example.invalid/jobs', steps: '搜索编号V08', loginRequired: true } });
  const other = s.app.createJob({ title: '模拟数据工程师', recruitmentUnit: '模拟甲院', originalText: '模拟数据工程岗位原文。' });
  const appliedOnly = s.app.createJob({ title: '模拟大模型负责人', recruitmentUnit: '模拟乙院', originalText: '模拟大模型岗位原文。' });
  s.app.setPersonalState(first.id, { followed: true });
  s.app.setPersonalState(other.id, { followed: true });
  const application = s.app.setApplied(first.id, true);
  s.app.setApplied(appliedOnly.id, true);
  const all = s.app.listJobView('all');
  assert.equal(all.length, 3);
  assert.deepEqual(new Set(s.app.listJobView('followed').map(job => job.id)), new Set([first.id, other.id]));
  assert.deepEqual(new Set(s.app.listJobView('applied').map(job => job.id)), new Set([first.id, appliedOnly.id]));
  const original = all.find(job => job.id === first.id);
  assert.equal(original.personal.followed, true);
  assert.equal(original.personal.applied, true);
  assert.equal(original.contractingEntity, '模拟签约主体');
  assert.deepEqual(original.knownConditions, ['硕士及以上']);
  assert.equal(original.applicationPath.steps, '搜索编号V08');
  assert.ok(original.recruitment.dates);
  assert.equal(original.eligibility, null);
  assert.equal(original.matching, null);
  const query = '?unit=模拟甲院&direction=大模型&level=unknown&eligibility=unassessed&status=unverified';
  for (const [route, view] of [['/jobs', 'all'], ['/followed', 'followed'], ['/applications', 'applied']]) {
    const html = await (await fetch(s.base + route + query)).text();
    assert.match(html, /<table/);
    assert.match(html, /模拟大模型算法专家/);
    assert.doesNotMatch(html, /模拟数据工程师|模拟大模型负责人/);
    assert.match(html, /选择显示列/);
    assert.match(html, /搜索编号V08/);
    for (const name of ['unit', 'direction', 'level', 'eligibility', 'status']) assert.ok(html.includes(`name="${name}"`));
    assert.deepEqual(s.app.listJobView(view, { unit: '模拟甲院', direction: '大模型', level: 'unknown', eligibility: 'unassessed', status: 'unverified' }), [original]);
  }
  for (const path of ['/api/jobs', '/api/followed', '/api/applied-jobs']) {
    const response = await fetch(s.base + path + query);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [original]);
  }
  assert.deepEqual(await (await fetch(s.base + '/api/jobs/' + first.id)).json(), original);
  s.app.updateApplication(application.id, { notes: '模拟本人备注', resumeVersion: '实际模拟v1' });
  s.app.recordApplicationEvent(application.id, { type: 'interview', note: '模拟本人面试事实' });
  const undo = await fetch(s.base + '/api/jobs/' + first.id + '/applied', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"applied":false}' });
  assert.equal(undo.status, 200);
  assert.equal((await undo.json()).personal.applied, false);
  const appliedHtml = await (await fetch(s.base + '/applications')).text();
  assert.doesNotMatch(appliedHtml, /模拟大模型算法专家/);
  assert.match(appliedHtml, /模拟大模型负责人/);
  assert.ok((await (await fetch(s.base + '/api/followed')).json()).some(job => job.id === first.id));
  const history = await (await fetch(s.base + '/api/applications')).json();
  const corrected = history.find(record => record.id === application.id);
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.notes, '模拟本人备注');
  assert.equal(corrected.events.filter(event => event.type === 'interview').length, 1);
  await s.restart();
  assert.deepEqual(s.app.listJobView('applied').map(job => job.id), [appliedOnly.id]);
  assert.ok(s.app.listJobView('followed').some(job => job.id === first.id));
  const detail = await (await fetch(s.base + '/jobs/' + first.id)).text();
  assert.match(detail, /投递记录与补充信息/);
  assert.match(detail, /模拟本人面试事实/);
  assert.match(detail, /模拟本人备注/);
  assert.equal(s.app.getApplication(application.id).resumeVersion, '实际模拟v1');
  assert.throws(() => s.app.listJobView('invented'), /岗位视图/);
  assert.equal((await fetch(s.base + '/api/followed?level=high')).status, 400);
});
