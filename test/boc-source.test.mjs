import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';

const indexUrl = 'https://www.boc.cn/aboutboc/bi4/';
const sampleUrl = indexUrl + '202605/t20260511_25666277.html';
const platformUrl = 'https://chrcmp.chinahr.com/pages/boc-social/';
const pdfUrl = 'https://pic.bankofchina.com/bocappd/appform/202605/P020260511535213767088.pdf';
const page = (current, title = '中国银行社会招聘公告') => `<script>createPageHTML(2, ${current}, "index", "html");</script><a href="./202605/t20260511_2566627${current}.html" title="${title}">${title}</a>`;
function setup(t, sourceFetch, announcementProcessor = null) {
  const dir = mkdtempSync(join(tmpdir(), 'job-hunter-boc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { databasePath: join(dir, 'test.sqlite'), now: () => new Date('2026-10-07T15:00:00Z'), sourceFetch, announcementProcessor };
}

test('中行栏目逐页自动获取、区分校招与社招线索，动态失败保存实际覆盖及原文，重启可读', async t => {
  const options = setup(t, async url => {
    if (url === indexUrl) return new Response(page(0), { status: 200 });
    if (url === indexUrl + 'index_1.html') return new Response(page(1, '中国银行校园招聘公告'), { status: 200 });
    return new Response('动态平台暂无法取得', { status: 503 });
  });
  let app = createApplication(options);
  t.after(() => app.close());
  const run = await app.checkBocSource({ announcementUrls: [], postIds: [] });
  assert.equal(run.catalogComplete, true);
  assert.equal(run.catalogCount, 2);
  assert.equal(run.catalog[0].kind, 'social');
  assert.equal(run.catalog[1].kind, 'campus');
  assert.equal(run.catalogPages.length, 2);
  assert.match(run.catalogPages[0].raw, /社会招聘/);
  assert.equal(run.platformListComplete, false);
  assert.equal(run.status, 'partial');
  assert.match(run.gaps.join('\n'), /平台.*503/);
  app.close();
  app = createApplication(options);
  assert.equal(app.getBocSourceCoverage().history[0].catalogCount, 2);
  assert.equal(app.listJobs().length, 0);
});

test('Web及HTTP读取中行覆盖和缺口，检查失败不覆盖既有岗位或个人操作', async t => {
  const { startServer } = await import('../src/server.mjs');
  let unavailable = false;
  const app = createApplication(setup(t, url => unavailable ? Promise.resolve(new Response('临时来源失败', { status: 503 })) : dynamicFetch(url)));
  const retained = app.createJob({ title: '模拟旧岗位', originalText: '本人保留的原文' });
  app.setPersonalState(retained.id, { followed: true });
  const server = await startServer({ app, port: 0 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = await fetch(base + '/api/sources/boc/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ announcementUrls: [], postIds: [], platformPageSize: 1 }) });
  assert.equal(post.status, 200);
  const run = await post.json();
  assert.equal(run.platformListComplete, true);
  const coverage = await (await fetch(base + '/api/sources/boc')).json();
  assert.equal(coverage.latest.id, run.id);
  const overview = await (await fetch(base + '/api/sources')).json();
  const boc = overview.sources.find(source => source.id === 'boc-social');
  assert.equal(boc.implemented, true);
  assert.equal(boc.latest.id, run.id);
  assert.equal(boc.latest.status, 'success');
  assert.equal(boc.health.consecutiveScheduledFailures, 0);
  const html = await (await fetch(base + '/sources/boc')).text();
  assert.match(html, /中国银行/);
  assert.match(html, /当前有用机会未验证/);
  assert.match(html, /2.*公告/);
  assert.match(html, /33|2.*平台/);
  unavailable = true;
  const failure = await (await fetch(base + '/api/sources/boc/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ announcementUrls: [], postIds: [] }) })).json();
  assert.equal(failure.catalogComplete, false);
  assert.match(failure.gaps.join('\n'), /503/);
  assert.equal(app.getBocSourceCoverage().history[1].platformListComplete, true);
  assert.equal(app.getJob(retained.id).originalText, '本人保留的原文');
  assert.equal(app.getPersonalState(retained.id).followed, true);
});

test('自动取官方公告及真实PDF，公共条件与附件定位合并，历史标记且相同内容不重复加工', async t => {
  const html = readFileSync(new URL('./fixtures/boc-source/overseas-20260511.html', import.meta.url), 'utf8');
  const pdf = readFileSync(new URL('./fixtures/boc-source/overseas-20260511.pdf', import.meta.url));
  const fetchSource = async url => {
    if (url === indexUrl) return new Response(page(0).replace('t20260511_25666270', 't20260511_25666277'));
    if (url === sampleUrl) return new Response(html);
    if (url === pdfUrl) return new Response(pdf);
    return dynamicFetch(url);
  };
  const processor = { process: async ({ documents }) => {
    const attachment = documents.find(document => document.id === 'attachment-1');
    const quote = '国际知名院校博士学历 （学位）';
    assert.match(attachment.segments[1].text, /人工智能规划与研究岗/);
    return { commonConditions: [{ text: '诚实守信', evidence: [{ documentId: 'announcement', locator: '正文', quote: '诚实守信' }] }], inputGaps: ['此测试的模型替身仅提取AI样本，未验证公告全部岗位'], jobs: [{ title: '人工智能规划与研究岗', recruitmentUnit: '中国银行股份有限公司', department: '总行金融科技部', batch: '2026年高层次海外人才招聘', contractingEntity: null, locations: ['北京'], duties: '负责全行人工智能应用发展的设计与规划', conditions: [{ text: '博士学历', evidence: [{ documentId: 'attachment-1', locator: 'page:2', quote }] }], evidence: [{ documentId: 'attachment-1', locator: 'page:2', quote: '人工智能规划与研究岗' }], applicationPath: { kind: 'steps', url: 'http://chrcmp.chinahr.com/pages/boc-social', email: null, steps: '于北京时间2026年5月25日24时前填写并提交简历。', loginRequired: true }, unknownFields: [], dateEvidence: [] }] };
  } };
  const options = { ...setup(t, fetchSource, processor), attachmentPython: process.env.JOBHUNTER_ATTACHMENT_PYTHON ?? new URL('../.runtime/attachment-venv/bin/python',import.meta.url).pathname };
  const app = createApplication(options);
  t.after(() => app.close());
  const first = await app.checkBocSource({ announcementUrls: [sampleUrl], postIds: [] });
  assert.equal(first.announcements.length, 1);
  assert.equal(first.announcements[0].attachments[0].status, 200);
  const announcement = app.getAnnouncement(first.announcements[0].announcementId);
  assert.notEqual(announcement.status, 'failed', announcement.error);
  assert.equal(announcement.evidenceUse, 'historical');
  assert.equal(announcement.attachments[0].segments.length, 3);
  assert.deepEqual(app.getAnnouncementAttachment(announcement.id, 'attachment-1'), pdf);
  const job = app.getJob(announcement.jobIds[0]);
  assert.deepEqual(job.conditions.map(condition => condition.scope), ['common', 'job']);
  assert.equal(job.conditions[1].evidence[0].locator, 'page:2');
  assert.equal(job.evidenceUse, 'historical');
  assert.equal(job.applicationPath.loginRequired, true);
  const again = await app.checkBocSource({ announcementUrls: [sampleUrl], postIds: [] });
  assert.equal(again.announcements[0].announcementId, announcement.id);
  assert.equal(again.announcements[0].cached, true);
  assert.equal(app.listJobs().length, 1);
  assert.equal(app.listAnnouncements().length, 1);
  assert.match(first.officialChain.find(link => link.fromUrl === sampleUrl).quote, /boc-social/);
});

test('真实中行HTML合并单元格保存地点与岗位关联，完整原文本保留，回放模型经公共加工取得AI北京', async t => {
  const html = readFileSync(new URL('./fixtures/boc-source/overseas-20260511.html', import.meta.url), 'utf8');
  const pdf = readFileSync(new URL('./fixtures/boc-source/overseas-20260511.pdf', import.meta.url));
  const accepted = JSON.parse(readFileSync(new URL('./fixtures/boc-source/actual-model-retry-raw.json', import.meta.url)));
  const sourceFetch = async url => {
    if (url === indexUrl) return new Response(page(0).replace('t20260511_25666270', 't20260511_25666277'));
    if (url === sampleUrl) return new Response(html);
    if (url === pdfUrl) return new Response(pdf);
    return dynamicFetch(url);
  };
  const expandedRow = '总行金融科技部 | 人工智能规划与研究岗 | 总行高级经理层级 | 北京 | 1';
  const announcementProcessor = { process: async ({ documents }) => {
    const output = structuredClone(accepted.output);
    const job = output.jobs.find(job => job.title === '人工智能规划与研究岗');
    output.jobs = [job];
    if (documents[0].text.includes(expandedRow)) {
      job.locations = ['北京'];
      job.evidence.push({ documentId: 'announcement', locator: '正文', quote: expandedRow });
      job.unknownFields = job.unknownFields.filter(field => !field.startsWith('locations'));
      output.inputGaps = output.inputGaps.filter(gap => !gap.includes('合并单元格'));
    }
    return { output, receipt: { verification: 'SIMULATED replay of accepted output plus HTML row association; not a new real model call' } };
  } };
  const options = { ...setup(t, sourceFetch, announcementProcessor), attachmentPython: process.env.JOBHUNTER_ATTACHMENT_PYTHON ?? new URL('../.runtime/attachment-venv/bin/python',import.meta.url).pathname };
  let app = createApplication(options);
  t.after(() => app.close());
  const run = await app.checkBocSource({ announcementUrls: [sampleUrl] });
  const announcement = app.getAnnouncement(run.announcements[0].announcementId);
  assert.notEqual(announcement.status, 'failed', announcement.error);
  const job = app.getJob(announcement.jobIds[0]);
  assert.deepEqual(job.location.options, ['北京']);
  const entry = run.announcements[0];
  assert.equal(entry.response.raw, html);
  assert.ok(announcement.originalText.startsWith(entry.originalPlainText));
  const table = entry.tables[0];
  assert.deepEqual(table.rows[0].cells.map(cell => cell.text), ['招聘单位', '招聘岗位', '对应层级', '工作地点', '招聘人数']);
  assert.equal(table.rows.length, 23);
  const ai = table.rows.find(row => row.cells[1].text === '人工智能规划与研究岗');
  assert.equal(ai.cells[0].text, '总行金融科技部');
  assert.equal(ai.cells[3].text, '北京');
  assert.equal(ai.cells[3].originRow, 2);
  assert.equal(ai.cells[3].rowSpan, 12);
  assert.equal(ai.cells[3].inherited, true);
  assert.match(ai.cells[3].rawHtml, /rowspan="12"/);
  assert.equal(entry.response.raw.slice(ai.cells[3].sourceStart, ai.cells[3].sourceEnd), ai.cells[3].rawHtml);
  assert.equal(table.rows.find(row => row.cells[1].text === '金融研究岗').cells[3].text, '上海');
  assert.equal(table.rows.find(row => row.cells[1].text === '跨境并购岗').cells[3].text, '深圳');
  assert.equal(table.rows.find(row => row.cells[1].text === '全球资产配置研究岗').cells[3].text, '上海');
  assert.equal(job.conditions.filter(condition => condition.scope === 'job')[0].evidence[0].locator, 'page:2');
  app.close(); app = createApplication(options);
  assert.equal(app.getBocSourceCoverage().latest.announcements[0].tables[0].rows[11].cells[3].text, '北京');
  assert.deepEqual(app.getJob(job.id).location.options, ['北京']);
});

test('其他公告的多级表头colspan与分组rowspan=0按范围展开，结构异常保留原HTML不覆盖旧证据', async t => {
  let oversized = false;
  const table = () => `<table><thead><tr><th colspan="${oversized ? 101 : 2}">招聘信息</th><th rowspan='2'>工作地点</th></tr><tr><th>招聘单位</th><th>招聘岗位</th></tr></thead><tbody><tr><td data-rowspan="9999" rowspan=0>模拟单位</td><td>模拟算法岗</td><td>北京</td></tr><tr><td>模拟治理岗</td><td>上海</td></tr></tbody></table>`;
  const html = () => `<h2 class="title">模拟多级表头公告</h2><div class="trs_editor_view">${table()}<p>模拟公共原文</p></div>`;
  const app = createApplication(setup(t, async url => {
    if (url === indexUrl) return new Response(page(0).replace('t20260511_25666270', 't20260511_25666277'));
    if (url === sampleUrl) return new Response(html());
    return dynamicFetch(url);
  }));
  t.after(() => app.close());
  const first = await app.checkBocSource({ announcementUrls: [sampleUrl], processAnnouncements: false });
  const entry = first.announcements[0];
  assert.deepEqual(entry.tables[0].headers, [['招聘信息', '招聘单位'], ['招聘信息', '招聘岗位'], ['工作地点']]);
  assert.deepEqual(entry.tables[0].rows[3].cells.map(cell => cell.text), ['模拟单位', '模拟治理岗', '上海']);
  assert.equal(entry.tables[0].rows[3].cells[0].originRow, 3);
  assert.equal(entry.tables[0].rows[3].cells[0].rowSpan, 2);
  assert.equal(entry.tables[0].rows[3].cells[0].inherited, true);
  assert.match(app.getAnnouncement(entry.announcementId).originalText, /模拟单位 \| 模拟算法岗 \| 北京/);
  oversized = true;
  const second = await app.checkBocSource({ announcementUrls: [sampleUrl], processAnnouncements: false });
  assert.match(second.gaps.join('\n'), /表格跨度越界/);
  assert.equal(second.announcements[0].response.raw, html());
  assert.match(second.announcements[0].originalPlainText, /模拟治理岗/);
  assert.equal(second.announcements[0].announcementId, null);
  assert.match(app.getAnnouncement(entry.announcementId).originalText, /模拟单位 \| 模拟治理岗 \| 上海/);
  assert.equal(app.listAnnouncements().length, 1);
});

const campaign = 'public-fixture-campaign';
const companyId = 'company-example';
const jsonp = data => new Response('/**/bocReadOnly(' + JSON.stringify(data) + ');', { status: 200 });
const dynamicFetch = async url => {
  if (url === indexUrl) return new Response(page(0), { status: 200 });
  if (url === indexUrl + 'index_1.html') return new Response(page(1, '中国银行校园招聘公告'), { status: 200 });
  if (url === platformUrl) return new Response('<link href="//j1.58cdn.com.cn/git/hrg-fe/chinahr-fe/chinahr-cmp/boc-social/js/job.fixture.js" rel="prefetch"><script>window.chinahr_cmp_json_data = {"extendSubToken":[]}</script>', { status: 200 });
  if (url.includes('job.fixture.js')) return new Response(`token:"${campaign}";var path="http://applyjob.chinahr.com/apply/job/wish/"`, { status: 200 });
  if (url.startsWith('https://ats.chinahr.com/api/company/list')) return jsonp({ code: 1, totalCount: 1, retMsg: [{ id: companyId, name: '示例中行机构' }] });
  if (url.startsWith('https://rms.chinahr.com/api/job/wxz/list')) {
    const current = Number(new URL(url).searchParams.get('page'));
    return jsonp({ code: 1, totalCount: 2, retMsg: [{ id: String(current).repeat(24), name: '算法专家', companyId, companyName: '示例中行机构', jobDesc: '<p>硕士及以上，算法研究。</p>', isShow: 1, isStart: 1, applyEndTime: 1786291500000 }] });
  }
  return new Response('未取得', { status: 404 });
};

test('指定平台公开项目逐页对总数，保留原始状态和日期不把过期列示当当前开放', async t => {
  const app = createApplication(setup(t, dynamicFetch));
  t.after(() => app.close());
  const run = await app.checkBocSource({ announcementUrls: [], postIds: [], platformPageSize: 1 });
  assert.equal(run.platformListComplete, true);
  assert.equal(run.platformPages.length, 2);
  assert.equal(run.platformJobs.length, 2);
  assert.equal(run.platformJobs[0].isStart, 1);
  assert.equal(run.platformJobs[0].applyEndTime, 1786291500000);
  assert.equal(run.currentOpportunityConfirmedCount, 0);
  assert.match(run.businessGaps.join('\n'), /当前.*未验证/);
  assert.equal(run.status, 'success');
  assert.equal(app.listJobs().length, 0);
});

test('选中公开岗位的申请直达经登录跳转可复核，分页重复或申请失败不洗成完整接入', async t => {
  let duplicate = false;
  const sourceFetch = async url => {
    if (url.startsWith('https://rms.chinahr.com/api/job/wxz/list') && duplicate) return jsonp({ code: 1, totalCount: 2, retMsg: [{ id: '1'.repeat(24), name: '算法专家', companyId, companyName: '示例中行机构', jobDesc: '<p>硕士及以上</p>', isShow: 1, isStart: 1 }] });
    if (url === 'https://applyjob.chinahr.com/apply/job/wish/' + '1'.repeat(24)) return new Response('', { status: 302, headers: { location: 'https://user.chinahr.com/cppt/open/page/login' } });
    if (url === 'https://user.chinahr.com/cppt/open/page/login') return new Response('<form>登录后填简历</form>');
    return dynamicFetch(url);
  };
  const app = createApplication(setup(t, sourceFetch));
  t.after(() => app.close());
  const first = await app.checkBocSource({ announcementUrls: [], postIds: ['1'.repeat(24)], platformPageSize: 1 });
  assert.equal(first.applicationPaths.length, 1);
  assert.equal(first.applicationPaths[0].verified, true);
  assert.equal(first.applicationPaths[0].loginRequired, true);
  assert.equal(first.applicationPaths[0].responses[0].status, 302);
  assert.equal(first.currentOpportunityConfirmedCount, 0);
  duplicate = true;
  const again = await app.checkBocSource({ announcementUrls: [], postIds: ['1'.repeat(24)], platformPageSize: 1 });
  assert.equal(again.platformListComplete, false);
  assert.match(again.gaps.join('\n'), /跨页重复|数量不符/);
  assert.equal(app.getBocSourceCoverage().history.length, 2);
  assert.equal(app.getBocSourceCoverage().history[1].platformListComplete, true);
});

test('选中平台岗位经公共公告加工稳定入库，未知开放状态与原值观察可重启读取，失败不下线', async t => {
  let unavailable = false;
  let calls = 0;
  const sourceFetch = async url => {
    if (unavailable) return new Response('模拟临时故障', { status: 503 });
    if (url.startsWith('https://applyjob.chinahr.com/apply/job/wish/')) return new Response('', { status: 302, headers: { location: 'https://user.chinahr.com/cppt/open/page/login' } });
    if (url === 'https://user.chinahr.com/cppt/open/page/login') return new Response('<form>登录</form>');
    return dynamicFetch(url);
  };
  const processor = { process: async ({ documents, targetJobs }) => {
    calls++;
    assert.deepEqual(targetJobs, [{ title: '算法专家', recruitmentUnit: '示例中行机构', department: null, batch: null }]);
    assert.match(documents[0].text, /硕士及以上，算法研究/);
    return { commonConditions: [], inputGaps: ['模拟加工，不是真实Codex'], jobs: [{ ...targetJobs[0], contractingEntity: null, locations: [], duties: '算法研究', conditions: [{ text: '硕士及以上', evidence: [{ documentId: 'announcement', locator: '正文', quote: '硕士及以上' }] }], evidence: [{ documentId: 'announcement', locator: '正文', quote: '算法专家' }], applicationPath: { kind: 'direct', url: 'https://applyjob.chinahr.com/apply/job/wish/' + '1'.repeat(24), email: null, steps: '注册登录后依该岗位官方流程填写并提交。', loginRequired: true }, unknownFields: ['部门及批次未知'], dateEvidence: [] }] };
  } };
  const options = setup(t, sourceFetch, processor);
  let app = createApplication(options);
  t.after(() => app.close());
  const first = await app.checkBocSource({ announcementUrls: [], postIds: ['1'.repeat(24)], platformPageSize: 1 });
  assert.equal(first.jobIds.length, 1, first.gaps.join("\n"));
  const job = app.getJob(first.jobIds[0]);
  assert.equal(job.sourceIdentities[0].externalId, '1'.repeat(24));
  assert.equal(job.applicationPath.loginRequired, true);
  assert.equal(job.dateEvidence.find(item => item.field === 'applyEndTime').meaning, 'unverified');
  assert.equal(app.getRecruitmentState(job.id).status, 'unverified');
  assert.equal(app.getRecruitmentState(job.id).history[0].listed, true);
  app.setPersonalState(job.id, { followed: true });
  await app.checkBocSource({ announcementUrls: [], postIds: ['1'.repeat(24)], platformPageSize: 1 });
  assert.equal(calls, 1);
  assert.equal(app.listJobs().length, 1);
  unavailable = true;
  await app.checkBocSource({ announcementUrls: [], postIds: ['1'.repeat(24)], platformPageSize: 1 });
  assert.equal(app.getRecruitmentState(job.id).history.at(-1).acquisition, 'failed');
  app.close(); app = createApplication(options);
  assert.equal(app.getPersonalState(job.id).followed, true);
  assert.equal(app.getJob(job.id).recruitmentStatus, 'unverified');
  assert.match(app.getAnnouncement(job.announcementId).originalText, /硕士及以上/);
});

test('公告显式单岗与附件范围参与缓存，默认检查不加工旧大公告，越界选择不创建岗位', async t => {
  const html = '<h2 class="title">模拟社招</h2><div class="trs_editor_view"><p>模拟单位，模拟算法岗，模拟治理岗；公共条件。</p></div>';
  let calls = 0;
  const processor = { process: async ({ targetJobs }) => {
    calls++;
    const targets = targetJobs ?? [{ title: '模拟算法岗', recruitmentUnit: '模拟单位', department: null, batch: null }, { title: '模拟治理岗', recruitmentUnit: '模拟单位', department: null, batch: null }];
    return { commonConditions: [{ text: '公共条件', evidence: [{ documentId: 'announcement', locator: '正文', quote: '公共条件' }] }], inputGaps: [], jobs: targets.map(target => ({ ...target, contractingEntity: null, locations: [], duties: null, conditions: [], evidence: [{ documentId: 'announcement', locator: '正文', quote: target.title }], applicationPath: null, unknownFields: [], dateEvidence: [] })) };
  } };
  const options = setup(t, async url => url === sampleUrl ? new Response(html) : url === indexUrl ? new Response(page(0).replace('t20260511_25666270', 't20260511_25666277')) : dynamicFetch(url), processor);
  const app = createApplication(options); t.after(() => app.close());
  const old = await app.checkBocSource({ announcementUrls: [sampleUrl] });
  const original = app.getAnnouncement(old.announcements[0].announcementId);
  assert.equal(original.jobIds.length, 2);
  const targetJob = { title: '模拟算法岗', recruitmentUnit: '模拟单位', department: null, batch: null };
  const scope = { [sampleUrl]: { targetJob } };
  const selected = await app.checkBocSource({ announcementUrls: [sampleUrl], announcementScopes: scope });
  const scoped = app.getAnnouncement(selected.announcements[0].announcementId);
  assert.notEqual(scoped.id, original.id);
  assert.deepEqual(scoped.targetJobs, [targetJob]);
  assert.equal(scoped.jobIds.length, 1);
  assert.equal(scoped.jobIds[0], original.jobIds[0]);
  assert.equal(app.getAnnouncement(original.id).jobIds.length, 2);
  const cached = await app.checkBocSource({ announcementUrls: [sampleUrl], announcementScopes: scope });
  assert.equal(cached.announcements[0].announcementId, scoped.id);
  assert.equal(calls, 2);
  const defaultCheck = await app.checkBocSource();
  assert.equal(defaultCheck.announcements.length, 0);
  assert.equal(calls, 2);
  await assert.rejects(app.checkBocSource({ announcementUrls: [sampleUrl], announcementScopes: { [sampleUrl]: { targetJob: { ...targetJob, title: '原文不存在岗' } } } }).then(run => { if (run.gaps.some(gap => gap.includes('不存在'))) throw new Error('原文不存在'); }), /不存在/);
  assert.equal(app.listJobs().length, 2);
});

test('单岗PDF范围改变重算而保留完整原件，跨岗模型结果保存前拒绝', async t => {
  const html = readFileSync(new URL('./fixtures/boc-source/overseas-20260511.html', import.meta.url), 'utf8');
  const pdf = readFileSync(new URL('./fixtures/boc-source/overseas-20260511.pdf', import.meta.url));
  const accepted = JSON.parse(readFileSync(new URL('./fixtures/boc-source/actual-model-retry-raw.json', import.meta.url)));
  const targetJob = { title: '人工智能规划与研究岗', recruitmentUnit: '总行金融科技部', department: null, batch: null };
  let calls = 0; let wrong = false;
  const options = { ...setup(t, async url => url === sampleUrl ? new Response(html) : url === pdfUrl ? new Response(pdf) : url === indexUrl ? new Response(page(0).replace('t20260511_25666270', 't20260511_25666277')) : dynamicFetch(url), { process: async ({ documents, targetJobs }) => {
    calls++;
    assert.deepEqual(targetJobs, [targetJob]);
    assert.equal(documents[1].segments.length, calls === 1 ? 3 : 1);
    const output = structuredClone(accepted.output); output.jobs = [output.jobs.find(job => job.title === targetJob.title)];
    if (wrong) output.jobs[0].title = '技术标准研究及标准化管理岗';
    return { output, receipt: { verification: 'SIMULATED accepted output replay' } };
  } }), attachmentPython: process.env.JOBHUNTER_ATTACHMENT_PYTHON ?? new URL('../.runtime/attachment-venv/bin/python',import.meta.url).pathname };
  const app = createApplication(options); t.after(() => app.close());
  const first = await app.checkBocSource({ announcementUrls: [sampleUrl], announcementScopes: { [sampleUrl]: { targetJob } } });
  assert.equal(first.jobIds.length, 1, first.gaps.join('\n'));
  const second = await app.checkBocSource({ announcementUrls: [sampleUrl], announcementScopes: { [sampleUrl]: { targetJob, documentScopes: [{ documentId: 'attachment-1', locators: ['page:2'] }] } } });
  assert.notEqual(second.announcements[0].announcementId, first.announcements[0].announcementId);
  assert.equal(second.jobIds[0], first.jobIds[0]);
  const announcement = app.getAnnouncement(second.announcements[0].announcementId);
  assert.equal(announcement.attachments[0].segments.length, 3);
  assert.deepEqual(app.getAnnouncementAttachment(announcement.id, 'attachment-1'), pdf);
  wrong = true;
  const rejected = await app.checkBocSource({ announcementUrls: [sampleUrl], announcementScopes: { [sampleUrl]: { targetJob, documentScopes: [{ documentId: 'attachment-1', locators: ['page:1'] }] } } });
  assert.equal(rejected.jobIds.length, 0);
  assert.match(rejected.gaps.join('\n'), /加工失败/);
  assert.equal(app.listJobs().length, 1);
});

test('Web选择平台岗和公告单岗共享应用入口，完整列表缺失仅疑似，计划时刻不冻结', async t => {
  const { startServer } = await import('../src/server.mjs');
  let missing = false;
  const options = setup(t, async url => {
    if (url.startsWith('https://applyjob.chinahr.com/')) return new Response('', {status:302,headers:{location:'https://user.chinahr.com/cppt/open/page/login'}});
    if (url.startsWith('https://user.chinahr.com/')) return new Response('<form>登录</form>');
    if (missing && url.startsWith('https://rms.chinahr.com/')) return jsonp({code:1,totalCount:0,retMsg:[]});
    return dynamicFetch(url);
  }, {process:async({documents,targetJobs})=>({commonConditions:[],inputGaps:['模拟处理'],jobs:[{...targetJobs[0],contractingEntity:null,locations:[],duties:null,conditions:[],evidence:[{documentId:'announcement',locator:'正文',quote:'算法专家'}],applicationPath:null,unknownFields:[],dateEvidence:[]}]})});
  const app=createApplication(options),server=await startServer({app,port:0});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();});
  // Explicit controlled replay seeds the old incomplete fixture; the Web check reuses it without another model call.
  await app.checkBocSource({postIds:['1'.repeat(24)]});
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/sources/boc/check',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({postIds:'1'.repeat(24)})});
  assert.equal(response.status,303);
  assert.equal(app.listJobs().length,1);
  const job=app.listJobs()[0];
  const html=await(await fetch(base+'/sources/boc')).text();
  assert.match(html,/默认不加工历史大公告/);
  assert.match(html,/选中平台岗位加工/);
  assert.match(html,new RegExp('/announcements/'+job.announcementId));
  missing=true;
  const run=await app.checkBocSource({postIds:['1'.repeat(24)],trigger:'scheduled',scheduledFor:'2026-10-08T09:00:00+08:00'});
  assert.equal(run.trigger,'scheduled');
  assert.equal(run.scheduledFor,'2026-10-08T09:00:00+08:00');
  assert.equal(run.platformListComplete,true);
  assert.equal(app.getJob(job.id).recruitmentStatus,'suspected_offline');
  assert.equal(app.getRecruitmentState(job.id).history.at(-1).applicationOpen,null);
  assert.equal(app.getRecruitmentState(job.id).history.at(-1).trigger,'scheduled');
  assert.equal(app.getSourcesOverview().sources.find(source=>source.id==='boc-social').health.consecutiveScheduledFailures,0);
});

const commonUrl = indexUrl + '202607/t20260721_25680323.html';
const commonClauses = ['政治素质良好', '安全意识和责任心强', '相关任职经历及能力', '正常履职身体条件', '亲属回避规定', '信息严格保密', '填报真实性完整性负责', '招聘调整取消终止权利'];
const associationRule = { id: 'fixture-special', announcementUrl: commonUrl, platformUrl, scopeQuote: '模拟境内机构算法岗位。', jobTitle: '算法专家', label: '模拟专项', projectId: 'fixture-project', institutionRoots: [{ id: 'fixture-root', name: '示例机构' }] };
function associationFixture({noticeFails=false,label='模拟专项',parentId='fixture-root',projectId='fixture-project',linked=true}={}) {
  return async url => {
    if (url === indexUrl) return new Response(page(0) + '<a href="./202607/t20260721_25680323.html" title="模拟专项社会招聘公告">模拟专项社会招聘公告</a>');
    if (url === commonUrl) return new Response(`<h2 class="title">模拟专项公告</h2><div class="trs_editor_view"><p>模拟境内机构算法岗位。</p>${commonClauses.map(text=>'<p>'+text+'</p>').join('')}${linked ? '<a href="http://chrcmp.chinahr.com/pages/boc-social">平台</a>' : '<a href="https://example.org/">其他站点</a>'}</div>`,{status:noticeFails?503:200});
    if (url.startsWith('https://ats.chinahr.com/')) return jsonp({code:1,totalCount:2,retMsg:[{id:companyId,name:'示例中行机构',parentId,projectId,token:campaign},{id:'fixture-root',name:'示例机构',parentId:null,projectId,token:campaign}]});
    if (url.startsWith('https://rms.chinahr.com/')) {const response=await dynamicFetch(url),raw=await response.text();const data=JSON.parse(raw.match(/bocReadOnly\((.*)\);/)[1]);data.retMsg=data.retMsg.map(post=>({...post,jobLabel:[label]}));return jsonp(data);}
    if (url.startsWith('https://applyjob.chinahr.com/')) return new Response('',{status:302,headers:{location:'https://user.chinahr.com/cppt/open/page/login'}});
    if (url.startsWith('https://user.chinahr.com/')) return new Response('<form>登录</form>');
    return dynamicFetch(url);
  };
}
function associationProcessor(onInput=()=>{}) {return {process:async({documents,targetJobs})=>{
  onInput(documents);
  const complete=commonClauses.every(clause=>documents[0].text.includes(clause));
  return {commonConditions:complete?commonClauses.map(text=>({text,evidence:[{documentId:'announcement',locator:'正文',quote:text}]})):[],inputGaps:[],jobs:[{...targetJobs[0],contractingEntity:null,locations:[],duties:'算法研究',conditions:[{text:'硕士及以上',evidence:[{documentId:'announcement',locator:'正文',quote:'硕士及以上'}]}],evidence:[{documentId:'announcement',locator:'正文',quote:'算法专家'}],applicationPath:null,unknownFields:['批次和签约主体未披露'],dateEvidence:[]}]};
}};}

test('官方明确适用范围＋标签／机构树／项目／平台链关联公共原文，八条条件入同岗且scope缓存可重启', async t => {
  let calls=0;
  const options={...setup(t,associationFixture(),associationProcessor(documents=>{calls++;assert.match(documents[0].text,/招聘调整取消终止权利/);})),bocAssociationRules:[associationRule]};
  let app=createApplication(options);t.after(()=>app.close());
  const run=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  assert.equal(run.jobIds.length,1,run.gaps.join('\n'));
  const job=app.getJob(run.jobIds[0]);
  assert.deepEqual(job.conditions.filter(item=>item.scope==='common').map(item=>item.text),commonClauses);
  assert.equal(job.batch,null);assert.equal(job.contractingEntity,null);
  assert.equal(job.sourceEvidence.relatedAnnouncements[0].scope.ruleId,'fixture-special');
  assert.equal(job.sourceEvidence.relatedAnnouncements[0].response.status,200);
  assert.equal(job.recruitmentStatus,'unverified');
  app.setPersonalState(job.id,{followed:true});
  await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  assert.equal(calls,1);
  app.close();app=createApplication(options);
  assert.equal(app.getPersonalState(job.id).followed,true);
  assert.match(app.getAnnouncement(job.announcementId).originalText,/招聘调整取消终止权利/);
  assert.equal(app.getSourceJob(job.id).sourceEvidence.relatedAnnouncements[0].scope.ancestors[0].id,companyId);
});

test('标签／机构根／项目或准确官方平台链不符不得套用公告，失败保留旧版本及本人记录', async t => {
  let scenario={};let calls=0;
  const options={...setup(t,url=>associationFixture(scenario)(url),associationProcessor(()=>{calls++;})),bocAssociationRules:[associationRule]};
  const app=createApplication(options);t.after(()=>app.close());
  const first=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  const job=app.getJob(first.jobIds[0]);app.setPersonalState(job.id,{followed:true});
  scenario={noticeFails:true};
  const failed=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  assert.match(failed.gaps.join('\n'),/503/);
  assert.deepEqual(failed.platformDetails[0].retainedJobIds,[job.id]);
  assert.equal(app.getJob(job.id).conditions.filter(item=>item.scope==='common').length,8);
  assert.equal(app.getPersonalState(job.id).followed,true);
  assert.equal(calls,1);
  scenario={linked:false};
  const badLink=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  assert.match(badLink.gaps.join('\n'),/平台链/);
  assert.equal(app.getJob(job.id).conditions.filter(item=>item.scope==='common').length,8);
  assert.equal(calls,1);
  for(const state of [{label:'其他专项'},{parentId:'unknown-root'},{projectId:'other-project'}]){
    scenario=state;
    const negativeApp=createApplication({...options,databasePath:options.databasePath+'.'+calls});
    try{const run=await negativeApp.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});const candidate=negativeApp.getJob(run.jobIds[0]);assert.equal(candidate.conditions.filter(item=>item.scope==='common').length,0);assert.equal(candidate.sourceEvidence.commonAnnouncementOriginalComplete,false);assert.equal(run.platformDetails[0].relatedAnnouncements.length,0);}finally{negativeApp.close();}
  }
});

test('完整来源与加工的普通未知不记网站失败，真实加工无岗位／获取失败仍记录缺口', async t => {
  let empty=false;
  const base=associationProcessor();
  const options={...setup(t,associationFixture(),{process:async input=>{const output=await base.process(input);output.inputGaps=['部门、签约主体和当前报名状态未明确披露'];if(empty)output.jobs=[];return output;}}),bocAssociationRules:[associationRule]};
  const app=createApplication(options);t.after(()=>app.close());
  const run=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1,trigger:'scheduled',scheduledFor:'2026-10-08T09:00:00+08:00'});
  assert.equal(run.status,'success');
  assert.equal(run.gaps.length,0);
  assert.match(run.businessGaps.join('\n'),/未验证|未确认/);
  assert.equal(run.jobIds.length,0);assert.equal(app.listAnnouncements()[0].status,'scope_pending');
  assert.equal(app.getSourcesOverview().sources.find(source=>source.id==='boc-social').health.consecutiveScheduledFailures,0);
  empty=true;
  const secondApp=createApplication({...options,databasePath:options.databasePath+'.empty'});
  try {const failure=await secondApp.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});assert.equal(failure.status,'partial');assert.match(failure.gaps.join('\n'),/未识别到.*具体岗位|未保存.*岗位|拒绝保存岗位/);}finally{secondApp.close();}
});

test('公共公告模板刷新仅保存原SHA新读取，正文scope未变不重复模型', async t => {
  let refreshed=false,calls=0;
  const sourceFetch=async url=>{const response=await associationFixture()(url);if(url!==commonUrl)return response;return new Response((await response.text())+(refreshed?'<!--模拟模板刷新-->':''),{status:200});};
  const app=createApplication({...setup(t,sourceFetch,associationProcessor(()=>calls++)),bocAssociationRules:[associationRule]});t.after(()=>app.close());
  const first=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  const firstSha=first.platformDetails[0].relatedAnnouncements[0].response.rawHash;
  refreshed=true;
  const second=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  assert.notEqual(second.platformDetails[0].relatedAnnouncements[0].response.rawHash,firstSha);
  assert.equal(second.platformDetails[0].cached,true);
  assert.equal(second.jobIds[0],first.jobIds[0]);
  assert.equal(calls,1);
});

test('非数组标签字符串包含专项名称不作为确切专项关系', async t => {
  const sourceFetch=async url=>{const response=await associationFixture()(url);if(!url.startsWith('https://rms.chinahr.com/'))return response;const raw=await response.text(),data=JSON.parse(raw.match(/bocReadOnly\((.*)\);/)[1]);data.retMsg=data.retMsg.map(post=>({...post,jobLabel:'其他模拟专项说明'}));return jsonp(data);};
  const app=createApplication({...setup(t,sourceFetch,associationProcessor()),bocAssociationRules:[associationRule]});t.after(()=>app.close());
  const run=await app.checkBocSource({postIds:['1'.repeat(24)],platformPageSize:1});
  assert.equal(run.platformDetails[0].relatedAnnouncements.length,0);
  assert.equal(app.getJob(run.jobIds[0]).conditions.filter(item=>item.scope==='common').length,0);
});

test('已保存同公告两岗按具体scope周复查，重启不整篇加工且未选scope延后可见',async t=>{
 let time='2026-10-08T01:00:00Z',changed=false;const seen=[];const targetJobs=[{title:'模拟算法岗',recruitmentUnit:'模拟单位',department:null,batch:null},{title:'模拟治理岗',recruitmentUnit:'模拟单位',department:null,batch:null}];
 const options={...setup(t,async url=>{
  if(url===sampleUrl)return new Response('<h2 class="title">模拟公告</h2><div class="trs_editor_view">工作地点：北京<br>报名截止时间：2026-12-31<br>模拟单位<br>岗位名称：模拟算法岗<br>岗位职责：负责软件算法研发及数据治理<br>岗位名称：模拟治理岗<br>岗位职责：负责软件算法研发及数据治理<br>公共条件：<br>'+(changed?'博士学历':'硕士学历')+'</div>');
  if(url===indexUrl)return new Response(page(0).replace('t20260511_25666270','t20260511_25666277'));
  if(url.startsWith('https://rms.chinahr.com/api/job/wxz/list'))return jsonp({code:1,totalCount:0,retMsg:[]});return dynamicFetch(url);
 },{process:async({targetJobs,documents})=>{assert.equal(targetJobs.length,1);seen.push(targetJobs[0].title);const clause=documents[0].text.includes('博士学历')?'博士学历':'硕士学历',ref=quote=>({documentId:'announcement',locator:'正文',quote});return {commonConditions:[{text:clause,evidence:[ref(clause)]}],inputGaps:[],jobs:[{...targetJobs[0],contractingEntity:null,locations:['北京'],duties:'负责软件算法研发及数据治理',conditions:[],evidence:[ref(targetJobs[0].title),ref('负责软件算法研发及数据治理')],applicationPath:null,unknownFields:[],dateEvidence:[]}]};}}),now:()=>new Date(time)};
 let app=createApplication(options);for(const targetJob of targetJobs)await app.checkBocSource({announcementUrls:[sampleUrl],announcementScopes:{[sampleUrl]:{targetJob}}});assert.equal(app.listJobs().length,2);const ids=app.listJobs().map(job=>job.id);app.setApplied(ids[0],true);app.close();time='2026-10-16T01:00:00Z';changed=true;app=createApplication(options);t.after(()=>app.close());
 const run=await app.runSourceCheck('boc-social',{scheduledFor:time});assert.equal(run.announcements.filter(item=>item.url===sampleUrl).length,1);assert.equal(run.announcements.find(item=>item.url===sampleUrl).processingScope.targetJob.title,'模拟算法岗');assert.equal(run.reviewDeferred.some(item=>item.jobId&&item.jobId!==run.reviewSelected.find(item=>item.jobId).jobId),true);assert.equal(app.getJob(run.reviewSelected.find(item=>item.jobId).jobId).knownConditions.includes('博士学历'),true);assert.equal(app.getRecruitmentState(run.reviewDeferred.find(item=>item.jobId).jobId).review.due,true);assert.equal(app.getPersonalState(ids[0]).applied,true);assert.equal(seen.length,3);
});

test('新完整单岗位公告无需人工scope，发现持久化后次日自动有界加工',async t=>{
 let time='2026-10-08T01:00:00Z',models=0,changed=false;const options={...setup(t,async url=>{
  if(url===indexUrl)return new Response(page(0).replace('t20260511_25666270','t20260511_25666277'));
  if(url===sampleUrl)return new Response('<h2 class="title">模拟新公告</h2><div class="trs_editor_view">工作地点：北京<br>报名截止时间：2026-12-31<br>模拟单位 社会招聘<br>岗位名称：模拟新算法岗<br>岗位职责：负责算法开发<br>公共条件：<br>'+(changed?'博士学历':'硕士学历')+'</div>');
  if(url.startsWith('https://rms.chinahr.com/api/job/wxz/list'))return jsonp({code:1,totalCount:0,retMsg:[]});return dynamicFetch(url);
 },{process:async({targetJobs,documents})=>{models++;assert.equal(targetJobs?.[0]?.title??'模拟新算法岗','模拟新算法岗');const clause=documents[0].text.includes('博士学历')?'博士学历':'硕士学历',ref=quote=>({documentId:'announcement',locator:'正文',quote});return {commonConditions:[{text:clause,evidence:[ref(clause)]}],inputGaps:[],jobs:[{title:'模拟新算法岗',recruitmentUnit:'模拟单位',department:null,batch:null,contractingEntity:null,locations:['北京'],duties:'负责算法开发',conditions:[],evidence:[ref('模拟新算法岗'),ref('模拟单位'),ref('负责算法开发')],applicationPath:null,unknownFields:[],dateEvidence:[]}]};}}),now:()=>new Date(time)};let app=createApplication(options);
 const first=await app.runSourceCheck('boc-social',{scheduledFor:time});assert.equal(first.announcements.length,0);assert.equal(models,0);assert.equal(app.listSourceCandidates('boc-social').some(item=>item.externalId===sampleUrl),true);app.close();time='2026-10-09T01:00:00Z';app=createApplication(options);t.after(()=>app.close());
 const run=await app.runSourceCheck('boc-social',{scheduledFor:time});assert.equal(run.announcements.length,1);assert.equal(models,1);assert.equal(app.listJobs().length,1);assert.equal(app.listSourceCandidates('boc-social').find(item=>item.externalId===sampleUrl).status,'processed');assert.equal(app.listJobs()[0].sourceIdentities[0].externalId.startsWith(sampleUrl+'#'),true);assert.equal(app.listJobs()[0].recruitmentStatus,'unverified');
 const id=app.listJobs()[0].id,externalId=app.listJobs()[0].sourceIdentities[0].externalId;app.setPersonalState(id,{followed:true});app.setApplied(id,true);app.close();changed=true;time='2026-10-10T01:00:00Z';app=createApplication(options);
 const refreshed=await app.runSourceCheck('boc-social',{scheduledFor:time});assert.equal(refreshed.announcements.find(item=>item.url===sampleUrl).processingScope.targetJob.title,'模拟新算法岗');assert.equal(app.listJobs().length,1);assert.equal(app.getJob(id).knownConditions.includes('博士学历'),true);assert.equal(app.getPersonalState(id).followed,true);assert.equal(app.getPersonalState(id).applied,true);assert.equal(app.getJob(id).sourceIdentities.some(item=>item.externalId===externalId),true);assert.equal(models,2);
});

test('原文确认纯校招时保留来源证据并退出社招加工队列，不把大公告超时反复重试',async t=>{
 let calls=0;
 const campus='<h2 class="title">模拟银行春季招聘公告</h2><div class="trs_editor_view">本次面向国内外院校招收应届毕业生。官方校园招聘网站：https://campus.chinahr.com/pages/example</div>';
 const app=createApplication(setup(t,async url=>url===indexUrl?new Response(page(0).replace('t20260511_25666270','t20260511_25666277')):url===sampleUrl?new Response(campus):dynamicFetch(url),{process:async()=>{calls++;throw Error('纯校招不应调用模型');}}));t.after(()=>app.close());
 const run=await app.checkBocSource({announcementUrls:[sampleUrl],postIds:[]});
 assert.equal(run.status,'success',run.gaps.join(' '));assert.equal(calls,0);assert.equal(app.listAnnouncements().length,0);assert.match(run.announcements[0].processingSkipped,/校招/);assert.equal(app.listSourceCandidates('boc-social').find(x=>x.externalId===sampleUrl).status,'excluded');assert.equal(app.listRecruitmentReviewPlan().some(x=>x.selectionId===sampleUrl),false);
});
