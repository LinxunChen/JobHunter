import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

const sample = {
  title: '算法专家（历史回放）',
  recruitmentUnit: '示例研究院',
  originalText: '历史测试原文：硕士及以上；工作地点北京或上海，最终工作地待确认。',
  sourceUrl: 'https://example.org/history/2020',
  location: { options: ['北京', '上海'], confirmed: null, note: '最终城市未确认' },
  knownConditions: ['硕士及以上'],
  applicationPath: { kind: 'steps', url: 'https://example.org/jobs', steps: '登录后搜索岗位编号A100', loginRequired: true },
  evidenceUse: 'historical',
  publishedAt: '2020-06-01',
};

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, 'jobs.sqlite'), now: () => new Date('2026-10-07T02:00:00.000Z') };
}

function assertSavedFields(actual, saved) {
  assert.deepEqual(Object.fromEntries(Object.keys(saved).map(key => [key, actual[key]])), saved);
}

test('补录有原文证据的岗位，岗位库与详情保留未知字段及发现时间', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  const job = app.createJob(sample);
  assert.equal(job.title, '算法专家（历史回放）');
  assert.equal(job.firstDiscoveredAt, '2026-10-07T02:00:00.000Z');
  assert.equal(job.publishedAt, '2020-06-01');
  assert.equal(job.contractingEntity, null);
  assert.equal(job.location.confirmed, null);
  assert.deepEqual(job.location.options, ['北京', '上海']);
  assert.equal(job.evidenceUse, 'historical');
  assert.equal(job.recruitmentStatus, 'unverified');
  assertSavedFields(app.getJob(job.id), job);
  const listed = app.listJobs();
  assert.equal(listed.length, 1);
  assertSavedFields(listed[0], job);
});

test('刷新和应用重启后原文、岗位及真实投递步骤仍可读取', t => {
  const options = setup(t);
  const app = createApplication(options);
  const job = app.createJob(sample);
  assert.equal(app.getJob(job.id).originalText, sample.originalText);
  const snapshot = app.getJob(job.id);
  assertSavedFields(snapshot, job);
  app.close();
  const restarted = createApplication(options);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.getJob(job.id), snapshot);
  assert.deepEqual(restarted.listJobs(), [snapshot]);
  assert.equal(restarted.listJobs()[0].applicationPath.steps, '登录后搜索岗位编号A100');
});

test('没有岗位标题或原文证据时拒绝补录，缺少普通字段则保留未知', t => {
  const app = createApplication(setup(t));
  t.after(() => app.close());
  assert.throws(() => app.createJob({ title: '无依据岗位' }), /原文/);
  assert.throws(() => app.createJob({ originalText: '原文' }), /标题/);
  assert.throws(() => app.createJob({ ...sample, applicationPath: { kind: 'direct', url: 'javascript:alert(1)' } }), /入口/);
  assert.equal(app.listJobs().length, 0);
  const job = app.createJob({ title: '待补字段岗位', originalText: '人工保存的可核对原文' });
  assert.equal(job.recruitmentUnit, null);
  assert.equal(job.evidenceUse, 'unverified');
  assert.deepEqual(job.location, { options: [], confirmed: null, note: null });
  assert.equal(job.applicationPath, null);
  assert.deepEqual(job.knownConditions, []);
});
