import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

const sample = {
  title: '算法专家', recruitmentUnit: '示例研究院', department: '技术部', batch: '2026第一批',
  originalText: '示例研究院技术部2026第一批算法专家，硕士及以上。', knownConditions: ['硕士及以上'],
  sourceUrl: 'https://example.org/jobs/A100', sourceIdentity: { sourceId: 'official-example', externalId: 'A100' },
  publishedAt: '2026-06-01', observedAt: '2026-10-07T09:00:00+08:00',
};
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, 'data.sqlite'), now: () => new Date('2026-10-07T02:00:00Z'), announcementProcessor: null };
}

test('同来源同岗位再次检查不新增，保留独立发布日期、首次发现和检查证据并可重启读取', t => {
  const options = setup(t);
  const app = createApplication(options);
  const first = app.importJob(sample);
  const next = app.importJob({ ...sample, observedAt: '2026-10-08T09:00:00+08:00' });
  assert.equal(first.change.type, 'new');
  assert.equal(next.change.type, 'unchanged');
  assert.equal(first.job.id, next.job.id);
  assert.equal(app.listJobs().length, 1);
  assert.equal(next.job.firstDiscoveredAt, '2026-10-07T01:00:00.000Z');
  assert.equal(next.job.publishedAt, '2026-06-01');
  assert.equal(next.job.lastSuccessfullyCheckedAt, '2026-10-08T01:00:00.000Z');
  assert.equal(app.getJobHistory(first.job.id).observations.length, 2);
  app.close();
  const restarted = createApplication(options);
  t.after(() => restarted.close());
  assert.equal(restarted.getJobHistory(first.job.id).observations[0].originalText, sample.originalText);
  assert.equal(restarted.getJob(first.job.id).lastSuccessfullyCheckedAt, '2026-10-08T01:00:00.000Z');
});

test('页面刷新保留原文版本而不算新增；实质学历变更保留前后要求及独立日期原值', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  const first = app.importJob(sample);
  const refresh = app.importJob({ ...sample, originalText: sample.originalText + '\n网页模板已改版', refreshedAt: '2026-07-30 23:17:57', observedAt: '2026-10-08T09:00:00+08:00', dateEvidence: [{ field: 'publishFirstDate', raw: '2020-02-13 00:00:00', meaning: 'unverified' }, { field: 'endDate', raw: '2030-12-31 23:59:59', meaning: 'unverified' }] });
  assert.equal(refresh.change.type, 'refresh');
  assert.equal(refresh.job.id, first.job.id);
  assert.equal(refresh.job.refreshedAt, '2026-07-30 23:17:57');
  assert.equal(refresh.job.dateEvidence[1].meaning, 'unverified');
  assert.equal(refresh.job.publishedAt, '2026-06-01');
  assert.equal(refresh.job.deadline, undefined);
  const changed = app.importJob({ ...sample, originalText: sample.originalText.replace('硕士', '博士'), knownConditions: ['博士及以上'], observedAt: '2026-10-09T09:00:00+08:00' });
  assert.equal(changed.change.type, 'substantive_change');
  const history = app.getJobHistory(first.job.id);
  assert.equal(history.versions.length, 2);
  assert.deepEqual(history.versions[0].job.knownConditions, ['硕士及以上']);
  assert.deepEqual(history.versions[1].job.knownConditions, ['博士及以上']);
  assert.equal(history.observations[1].originalText, sample.originalText + '\n网页模板已改版');
  assert.equal(app.listJobs().length, 1);
});

test('官方关联和平台迁移证据关联同岗，原始多源及投递历史不覆盖', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  const first = app.importJob(sample).job;
  app.setApplied(first.id, true);
  const raw = sample.originalText + '\n官网指定招聘平台，旧ID A100迁移为Z900。';
  const linked = app.importJob({ ...sample, originalText: raw, sourceIdentity: { sourceId: 'designated-platform', externalId: 'Z900', stableCode: 'REC001' }, sourceUrl: 'https://platform.example.org/Z900', associationEvidence: { jobId: first.id, kind: 'platform_migration', url: sample.sourceUrl, quote: '旧ID A100迁移为Z900' } });
  assert.equal(linked.job.id, first.id);
  assert.equal(linked.change.type, 'source_linked');
  assert.equal(app.listJobs().length, 1);
  assert.equal(app.getJobHistory(first.id).observations.length, 2);
  assert.equal(app.getJobHistory(first.id).relations[0].evidence.quote, '旧ID A100迁移为Z900');
  assert.equal(app.listApplications(first.id)[0].jobSnapshot.originalText, sample.originalText);
  assert.equal(app.getPersonalState(first.id).applied, true);
  assert.throws(() => app.importJob({ ...sample, sourceIdentity: { sourceId: 'other', externalId: 'X' }, associationEvidence: { jobId: first.id, kind: 'official_link', url: sample.sourceUrl, quote: '不存在的关联原文' } }), /关联.*证据/);
});

test('不同主体部门和批次独立，未知不是通配符，无关联依据的ID迁移只保留可能关系', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  const original = app.importJob(sample).job;
  app.setApplied(original.id, true);
  const newBatch = app.importJob({ ...sample, batch: '2026第二批', originalText: sample.originalText.replace('第一批', '第二批') });
  assert.notEqual(newBatch.job.id, original.id);
  assert.equal(newBatch.change.type, 'new_batch');
  assert.equal(app.getJobHistory(newBatch.job.id).relations[0].priorJobId, original.id);
  for (const changes of [{ recruitmentUnit: '另一研究院' }, { department: '另一部门' }, { department: null }]) {
    const separate = app.importJob({ ...sample, ...changes });
    assert.notEqual(separate.job.id, original.id);
  }
  const possible = app.importJob({ ...sample, sourceIdentity: { sourceId: 'official-example', externalId: 'migrated-unknown', stableCode: 'REC001' } });
  assert.notEqual(possible.job.id, original.id);
  assert.equal(possible.change.type, 'possible_relation');
  assert.equal(app.getJobHistory(possible.job.id).relations[0].priorJobId, original.id);
  assert.equal(app.listApplications(original.id).length, 1);
  assert.equal(app.listApplications(newBatch.job.id).length, 0);
});

test('公告加工直接按验证的来源身份导入，同岗位新公告不产生影子岗位且保留条件定位', async t => {
  const output = { commonConditions: [], inputGaps: [], jobs: [{ title: '算法专家', recruitmentUnit: '示例研究院', department: '技术部', batch: '2026第一批', contractingEntity: null, locations: [], duties: null, conditions: [{ text: '硕士及以上', evidence: [{ documentId: 'announcement', locator: '正文', quote: '硕士及以上' }] }], evidence: [{ documentId: 'announcement', locator: '正文', quote: '算法专家' }], applicationPath: null, unknownFields: [], dateEvidence: [] }] };
  const app = createApplication({ ...setup(t), announcementProcessor: { process: async () => structuredClone(output) } });
  t.after(() => app.close());
  const jobIdentities = [{ title: sample.title, recruitmentUnit: sample.recruitmentUnit, department: sample.department, batch: sample.batch, sourceIdentity: sample.sourceIdentity, sourceEvidence: { listed: true, checkedAt: sample.observedAt }, recruitmentStatus: 'publicly_listed_open', observedAt: sample.observedAt }];
  const first = await app.createAnnouncement({ title: '官方公告模拟1', originalText: sample.originalText, jobIdentities });
  const one = await app.processAnnouncement(first.id);
  const second = await app.createAnnouncement({ title: '官方公告模拟2', originalText: sample.originalText + '\n网页模板改版', jobIdentities });
  const two = await app.processAnnouncement(second.id);
  assert.equal(one.status, 'processed');
  assert.equal(two.status, 'processed');
  assert.equal(one.jobIds[0], two.jobIds[0]);
  assert.equal(app.listJobs().length, 1);
  const job = app.getJob(one.jobIds[0]);
  assert.equal(job.recruitmentStatus, 'publicly_listed_open');
  assert.equal(job.conditions[0].evidence[0].documentId, 'announcement');
  assert.equal(app.getJobHistory(job.id).observations[1].snapshot.announcementId, second.id);
});

test('Web显示可追溯原文与变化历史，来源公开状态不冒充内部名额', async t => {
  const { startServer } = await import('../src/server.mjs');
  const app = createApplication(setup(t));
  const imported = app.importJob({ ...sample, recruitmentStatus: 'publicly_listed_open', sourceEvidence: { listed: true, canDelivery: true } });
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = await fetch(base + `/api/jobs/${imported.job.id}/history`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).observations[0].originalText, sample.originalText);
  const history = await (await fetch(base + `/jobs/${imported.job.id}/history`)).text();
  assert.match(history, /版本历史/);
  assert.match(history, /2026-06-01/);
  assert.match(history, /硕士及以上/);
  const detail = await (await fetch(base + `/jobs/${imported.job.id}`)).text();
  assert.match(detail, /当前公开列示开放/);
  assert.match(detail, /不代表内部名额/);
});


test('较早采集结果补入只留证据，不回退最新要求或最近成功检查时间', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  const latest = app.importJob({ ...sample, originalText: sample.originalText.replace('硕士', '博士'), knownConditions: ['博士及以上'], observedAt: '2026-10-09T09:00:00+08:00' });
  const older = app.importJob(sample);
  assert.equal(older.job.id, latest.job.id);
  assert.deepEqual(older.job.knownConditions, ['博士及以上']);
  assert.equal(older.job.lastSuccessfullyCheckedAt, '2026-10-09T01:00:00.000Z');
  const history = app.getJobHistory(latest.job.id);
  assert.equal(history.observations.length, 2);
  assert.equal(history.observations[1].originalText, sample.originalText);
  assert.equal(history.versions.length, 1);
  assert.equal(older.change.type, 'historical_observation');
});
