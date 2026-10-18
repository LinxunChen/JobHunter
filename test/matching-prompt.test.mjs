import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
import { createMatchingProcessor } from '../src/matching-codex.mjs';

const profileText = '模拟职业事实：负责推荐排序模型开发。推荐排序算法模型。负责排序。';
const jobText = '模拟岗位负责推荐排序模型开发，制定技术路线。';
const direct = { profileQuote: '负责推荐排序模型开发', jobQuote: '负责推荐排序模型开发', explanation: '模拟直接职责依据' };
const dimension = () => ({ level: 'high', explanation: '模拟已有直接研发职责', directExperiences: [direct],
  transferableAbilities: [], gaps: [], jobQuotes: ['负责推荐排序模型开发'] });
const matching = () => ({ technical: dimension(), business: dimension(), scope: dimension(), route: 'expert',
  routeExplanation: '模拟按研发职责识别专家路线', uncertainties: [] });

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jh-matching-prompt-'));
  const command = join(directory, 'synthetic-codex');
  const fixture = join(directory, 'output-fixture.json');
  const promptFile = join(directory, 'captured-prompt.txt');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(promptFile)}, fs.readFileSync(0, 'utf8'));
fs.copyFileSync(${JSON.stringify(fixture)}, args[args.indexOf('--output-last-message') + 1]);
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o700 });
  const unavailable = async () => { throw new Error('本票禁止真实来源读取'); };
  const app = createApplication({ databasePath: join(directory, 'jobs.sqlite'), announcementProcessor: null,
    matchingProcessor: createMatchingProcessor({ workingRoot: directory, command }), careerSource: null,
    sourceFetch: unavailable, ccbSourceFetch: unavailable, icbcFetch: unavailable, cmriFetch: unavailable,
    sasacFetch: unavailable, notificationTransport: null });
  t.after(() => { app.close(); rmSync(directory, { recursive: true, force: true }); });
  app.saveCareerProfile({ text: profileText, version: '模拟v1', sourceId: 'manual' });
  const job = app.createJob({ title: '模拟算法专家', originalText: jobText });
  return { app, job, promptFile, setOutput: output => writeFileSync(fixture, JSON.stringify(output)) };
}

test('公共匹配入口传给受控CLI的指令明确每个高维度的每条直接引文门槛及证据不足回退', async t => {
  const { app, job, promptFile, setOutput } = setup(t);
  setOutput(matching());
  const result = await app.matchJob(job.id);
  assert.equal(result.status, 'completed', result.gaps.join('；'));
  const prompt = readFileSync(promptFile, 'utf8');
  const instructions = prompt.split('岗位及职业资料（JSON数据）：')[0];
  assert.match(instructions, /每个[^\n]*high[^\n]*维度/);
  assert.match(instructions, /每条[^\n]*directExperiences[^\n]*profileQuote/);
  assert.match(instructions, /至少8个字符/);
  assert.match(instructions, /负责、主导、开发、建设、设计、优化、落地、制定、统筹、带领、项目、经历/);
  assert.match(instructions, /不足[^\n]*medium[^\n]*unknown[^\n]*gaps/);
  assert.match(instructions, /不得[^\n]*补写[^\n]*拼接/);
  const payload=JSON.parse(prompt.split('岗位及职业资料（JSON数据）：')[1]);assert.equal(payload.profile.text,profileText);assert.equal(payload.job.originalText,jobText);assert.equal(Object.hasOwn(payload.profile,'sourceWindow'),false);assert.equal(Object.hasOwn(payload.job,'currentVersionId'),false);assert.equal(result.output.technical.directExperiences[0].profileQuote, direct.profileQuote);
});

test('高匹配中的一条合格直接经历不能放行另一条过短或只有技能标签的引文', async t => {
  const { app, job, setOutput } = setup(t);
  setOutput(matching());
  const completed = await app.matchJob(job.id);
  assert.equal(completed.status, 'completed');
  for (const profileQuote of ['负责排序', '推荐排序算法模型']) {
    const output = matching();
    output.technical.directExperiences.push({ ...direct, profileQuote });
    setOutput(output);
    const rejected = await app.matchJob(job.id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.output, null);
    assert.match(rejected.gaps.join('；'), /高匹配缺少直接项目或职责事实/);
    assert.equal(rejected.qualificationAllowsAction, false);
    assert.equal(rejected.previousResult.id, completed.id);
  }
});

test('受控CLI声称高匹配但职业或岗位引文不可逐字定位时仍拒绝且保留原文', async t => {
  const { app, job, setOutput } = setup(t);
  for (const changed of [{ profileQuote: '负责金融监管系统开发' }, { jobQuote: '负责金融监管系统开发' }]) {
    const output = matching();
    output.technical.directExperiences = [{ ...direct, ...changed }];
    setOutput(output);
    const rejected = await app.matchJob(job.id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.output, null);
    assert.match(rejected.gaps.join('；'), /匹配引文无法在岗位或职业资料定位/);
    assert.equal(app.getJob(job.id).originalText, jobText);
  }
});

test('直接证据不足时中等迁移及未知维度保留具体缺口可以完成解释，不能冒充资格放行', async t => {
  const { app, job, setOutput } = setup(t);
  const output = matching();
  output.technical = { ...dimension(), level: 'medium', directExperiences: [], transferableAbilities: [direct],
    gaps: ['模拟岗位要求的具体专业项目未经职业资料证明'] };
  output.business = { ...dimension(), level: 'unknown', directExperiences: [],
    gaps: ['模拟目标业务领域的直接项目事实缺少'] };
  setOutput(output);
  const result = await app.matchJob(job.id);
  assert.equal(result.status, 'completed', result.gaps.join('；'));
  assert.equal(result.output.technical.level, 'medium');
  assert.equal(result.output.business.level, 'unknown');
  assert.match(result.output.business.gaps[0], /直接项目事实缺少/);
  assert.equal(result.qualificationAllowsAction, false);
});

test('自定义目标进入受控匹配提示，模型不再沿用固定城市或个人背景',async t=>{
 const {app,job,promptFile,setOutput}=setup(t);
 app.saveLocalSettings({targetCities:['上海','杭州'],roleKeywords:['人力资源'],recruitmentType:'all',preferences:'关注组织发展与劳动关系',excludedKeywords:['销售']});
 setOutput(matching());assert.equal((await app.matchJob(job.id)).status,'completed');
 const prompt=readFileSync(promptFile,'utf8'),payload=JSON.parse(prompt.split('岗位及职业资料（JSON数据）：')[1]);
 assert.deepEqual(payload.preferences.targetCities,['上海','杭州']);
 assert.deepEqual(payload.preferences.roleKeywords,['人力资源']);
 assert.match(prompt,/目标城市为上海、杭州/);
 assert.equal(payload.preferences.recruitmentType,'all');assert.equal(payload.preferences.preferences,'关注组织发展与劳动关系');
 assert.match(prompt,/岗位核心专业能力/);assert.match(prompt,/人力岗例如招聘渠道/);
 assert.doesNotMatch(prompt.split('岗位及职业资料（JSON数据）：')[0],/公开工作地点明确不包含北京/);
});
