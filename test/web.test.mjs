import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
import { startServer } from '../src/server.mjs';

test('通过Web补录、刷新岗位库和详情，安全展示原文及真实查找步骤', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-web-'));
  const app = createApplication({ databasePath: join(directory, 'jobs.sqlite'), now: () => new Date('2026-10-07T02:00:00.000Z') });
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = await fetch(`${base}/jobs/new`);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /原文证据/);
  const response = await fetch(`${base}/jobs`, { method: 'POST', body: new URLSearchParams({
    title: '算法专家<script>alert(1)</script>', recruitmentUnit: '示例研究院', originalText: '<script>原文不得执行</script>\n硕士及以上',
    locationOptions: '北京\n上海', locationNote: '最终城市未确认', knownConditions: '硕士及以上',
    applicationKind: 'steps', applicationUrl: 'https://example.org/jobs', applicationSteps: '登录并搜索编号A100', loginRequired: 'on',
    evidenceUse: 'historical', publishedAt: '2020-06-01',
  }), redirect: 'manual' });
  assert.equal(response.status, 303);
  const detail = await (await fetch(`${base}${response.headers.get('location')}`)).text();
  assert.match(detail, /&lt;script&gt;原文不得执行&lt;\/script&gt;/);
  assert.doesNotMatch(detail, /<script>/);
  assert.match(detail, /最终城市未确认/);
  assert.match(detail, /历史样本/);
  assert.match(detail, /2020-06-01/);
  assert.match(detail, /2026-10-07/);
  assert.match(detail, /登录并搜索编号A100/);
  assert.match(detail, /签约主体[\s\S]*未知/);
  const list = await (await fetch(`${base}/jobs`)).text();
  assert.match(list, /算法专家&lt;script&gt;/);
  assert.equal((await (await fetch(`${base}/api/jobs`)).json()).length, 1);
});
