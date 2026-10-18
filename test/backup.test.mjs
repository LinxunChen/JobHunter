import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/application.mjs';
const originalText = '模拟：示例研究院第一批算法专家，北京，负责推荐模型开发，硕士及以上。';
const attachmentText = '附件原文：硕士及以上。';
const extraction = { commonConditions: [{ text: '硕士及以上', evidence: [{ documentId: 'attachment-1', locator: '全文', quote: '硕士及以上' }] }], jobs: [{ title: '算法专家', recruitmentUnit: '示例研究院', contractingEntity: null, department: null, batch: '第一批', locations: ['北京'], duties: '负责推荐模型开发', conditions: [], evidence: [{ documentId: 'announcement', locator: '正文', quote: originalText }], applicationPath: null, unknownFields: [], dateEvidence: [] }], inputGaps: [] };
const dimension = { level: 'medium', explanation: '模拟匹配', directExperiences: [], transferableAbilities: [], gaps: ['模拟能力待核验'], jobQuotes: ['负责推荐模型开发'] };
const matchOutput = { technical: dimension, business: dimension, scope: dimension, route: 'expert', routeExplanation: '实际职责', uncertainties: ['模拟输出'] };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'job-hunter-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = new Date('2026-10-07T02:00:00Z');
  return { dir, options: { databasePath: join(dir, 'business.sqlite'), announcementProcessor: { process: async () => extraction }, matchingProcessor: { match: async () => matchOutput }, careerSource: null, now: () => clock }, at: value => { clock = new Date(value); } };
}
async function seed(app) {
  const ann = await app.createAnnouncement({ title: '模拟公告', originalText, attachments: [{ name: '条件.txt', mediaType: 'text/plain', contentBase64: Buffer.from(attachmentText).toString('base64') }], jobIdentities: [{ title: '算法专家', recruitmentUnit: '示例研究院', department: null, batch: '第一批', sourceIdentity: { sourceId: 'simulation-official', externalId: 'job-1' } }] });
  const processed = await app.processAnnouncement(ann.id); assert.equal(processed.status, 'processed');
  const job = app.getJob(processed.jobIds[0]); app.setPersonalState(job.id, { followed: true });
  const application = app.setApplied(job.id, true); app.updateApplication(application.id, { notes: '本人模拟备注', resumeVersion: '实际提交-模拟v1' }); app.recordApplicationEvent(application.id, { type: 'interview', note: '模拟面试' }); app.setApplied(job.id, false);
  app.correctJob(job.id, { field: 'location', value: { options: ['北京'], confirmed: '北京' }, basis: { reason: '模拟本人确认' } });
  const profile = app.saveCareerProfile({ text: '模拟职业资料：负责推荐模型开发。', version: '模拟职业v1', sourceId: 'manual' });
  app.evaluateEligibility(job.id, { profile: { version: profile.version, education: '硕士' } }); await app.matchJob(job.id);
  return { ann, job, application };
}

test('完整SQLite备份恢复新空路径，岗位版本、申请纠正面试、资格匹配与附件关系可读', async t => {
  const { options } = setup(t); const app = createApplication(options); t.after(() => app.close());
  const { ann, job, application } = await seed(app);
  const saved = await app.createBackup({ trigger: 'manual' }); assert.equal(saved.status, 'verified');
  assert.equal((await app.verifyBackup(saved.id)).valid, true);
  const restored = await app.restoreBackup(saved.id, { directoryName: 'restore-a' });
  assert.notEqual(restored.databasePath, options.databasePath);
  const { DatabaseSync } = await import('node:sqlite');
  const tableSnapshot = path => { const db = new DatabaseSync(path, { readOnly: true }); try { return JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replace(/"/g, '""') + '"').all()])); } finally { db.close(); } };
  const beforeStartup = tableSnapshot(restored.databasePath);
  const copy = createApplication({ databasePath: restored.databasePath, announcementProcessor: null, matchingProcessor: null, careerSource: null }); t.after(() => copy.close());
  assert.equal(tableSnapshot(restored.databasePath), beforeStartup);
  await assert.rejects(copy.createBackup(),/核对模式/);await assert.rejects(copy.restoreBackup(saved.id),/核对模式/);
  assert.deepEqual(copy.getSourcesOverview(), app.getSourcesOverview()); assert.deepEqual(copy.getSourceSettings('efunds-social'), app.getSourceSettings('efunds-social'));
  assert.deepEqual(copy.getJobHistory(job.id), app.getJobHistory(job.id));
  assert.deepEqual(copy.getApplication(application.id), app.getApplication(application.id));
  assert.equal(copy.getApplication(application.id).events.at(-2).type, 'interview'); assert.equal(copy.getApplication(application.id).resumeVersion, '实际提交-模拟v1');
  assert.deepEqual(copy.getPersonalState(job.id), app.getPersonalState(job.id)); assert.deepEqual(copy.listJobCorrections(job.id), app.listJobCorrections(job.id));
  assert.deepEqual(copy.getEligibility(job.id), app.getEligibility(job.id)); assert.deepEqual(copy.getMatch(job.id), app.getMatch(job.id));
  assert.equal(copy.getAnnouncementAttachment(ann.id, 'attachment-1').toString(), attachmentText); assert.equal(copy.getAnnouncement(ann.id).jobIds[0], job.id);
  assert.equal(app.listJobs().length, 1); assert.equal(restored.credentialsRestored, false);
});

test('周日、手动、升级合计最近3份完整快照，失败与未知目录不挤掉成功包', async t => {
  const { dir, options, at } = setup(t); const app = createApplication(options); t.after(() => app.close());
  await seed(app);
  assert.equal((await app.createBackup({ trigger: 'scheduled' })).status, 'not_due');
  at('2026-10-11T01:00:00Z'); const sunday = await app.createBackup({ trigger: 'scheduled' });
  assert.equal(sunday.status, 'verified');
  assert.equal((await app.createBackup({ trigger: 'scheduled' })).status, 'not_due');
  at('2026-10-11T01:01:00Z'); const upgrade = await app.createBackup({ trigger: 'upgrade' });
  for (let i = 0; i < 2; i++) { at(`2026-10-11T02:0${i}:00Z`); assert.equal((await app.createBackup()).status,'verified'); }
  assert.equal(app.listBackups().filter(item => item.status === 'verified').length, 3);
  assert.equal((await app.verifyBackup(upgrade.id)).valid, true);
  assert.equal(app.getBackup(sunday.id).status, 'pruned');
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  mkdirSync(join(dir, 'backups', 'not-owned')); writeFileSync(join(dir, 'backups', 'not-owned', 'original.txt'), '非本轮历史文件');
  at('2026-10-11T03:00:00Z'); await app.createBackup();
  assert.equal(app.getBackup(upgrade.id).status,'pruned');
  assert.equal(existsSync(join(dir, 'backups', 'not-owned', 'original.txt')), true);
  assert.equal((await app.createBackup({ trigger: 'scheduled' })).status,'not_due');
  at('2026-10-19T01:00:00Z'); const catchup = await app.createBackup({ trigger: 'scheduled' }); assert.equal(catchup.status, 'verified');
  assert.equal((await app.createBackup({ trigger: 'scheduled' })).status, 'not_due');
  assert.equal(app.listBackups().filter(item=>item.status==='verified').length,3);assert.equal(app.listJobs().length, 1);
});

test('动态全表快照含未来流程数据，SQL完整不替代业务ID／原文附件关系完整', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { options } = setup(t); const app = createApplication(options); t.after(() => app.close());
  const { job } = await seed(app);
  const fixture = new DatabaseSync(options.databasePath); t.after(() => fixture.close());
  fixture.exec('CREATE TABLE future_workflow (id TEXT PRIMARY KEY, body TEXT NOT NULL)'); fixture.prepare('INSERT INTO future_workflow VALUES (?,?)').run('future-1', JSON.stringify({ id: 'future-1', jobId: job.id, original: '模拟流程原始证据', status: 'completed' }));
  const saved = await app.createBackup(); assert.equal(saved.status, 'verified'); assert.equal(saved.manifest.verification.tables.future_workflow.count, 1);
  const restored = await app.restoreBackup(saved.id, { directoryName: 'future-restored' }); assert.deepEqual(restored.verification.tables.future_workflow, saved.manifest.verification.tables.future_workflow);
  fixture.exec("UPDATE applications SET job_id='missing-job'");
  const rejected = await app.createBackup(); assert.equal(rejected.status, 'failed'); assert.equal((await app.verifyBackup(saved.id)).valid, true);
});

test('流式备份校验保持既有清单哈希合同，旧包不需要重写',async t=>{
 const {DatabaseSync}=await import('node:sqlite'),{createHash}=await import('node:crypto');
 const {dir,options}=setup(t),app=createApplication(options);t.after(()=>app.close());await seed(app);
 const saved=await app.createBackup();assert.equal(saved.status,'verified');
 const db=new DatabaseSync(join(dir,'backups',saved.id,'business.sqlite'),{readOnly:true});
 const canonical=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{integer:item.toString()}:item instanceof Uint8Array?{bytes:item.length,sha256:createHash('sha256').update(item).digest('hex')}:item);
 const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
 try{
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.equal(saved.manifest.verification.schemaHash,digest(schema));
  for(const {name}of schema.filter(item=>item.type==='table')){
   const statement=db.prepare('SELECT * FROM "'+name.replace(/"/g,'""')+'"');statement.setReadBigInts(true);const rows=statement.all();
   assert.deepEqual(saved.manifest.verification.tables[name],{count:rows.length,sha256:digest(rows)},name);
  }
 }finally{db.close();}
});

test('异步快照期间同库应用写入与第二份备份受控，完成后恢复写入', async t => {
  const { options } = setup(t); const app = createApplication(options); const other = createApplication(options); t.after(() => { other.close(); app.close(); });
  const { job } = await seed(app);
  const pending = app.createBackup();
  assert.throws(() => other.setPersonalState(job.id, { followed: false }), /备份进行中/);
  await assert.rejects(other.createBackup(), /备份进行中/);
  assert.equal((await pending).status, 'verified');
  other.setPersonalState(job.id, { followed: false }); assert.equal(app.getPersonalState(job.id).followed, false);
});

test('独立空数据库也可定位既有包恢复；包损坏、附件SHA或缺关联拒绝，旧异常包不被清理', async t => {
  const { readFileSync, writeFileSync, existsSync, statSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { dir, options, at } = setup(t); const app = createApplication(options); t.after(() => app.close());
  await seed(app); const saved = await app.createBackup();
  const clean = createApplication({ databasePath: join(dir, 'blank', 'new.sqlite'), backupRoot: join(dir, 'backups'), announcementProcessor: null, matchingProcessor: null, careerSource: null }); t.after(() => clean.close());
  assert.equal(clean.listBackups().some(item => item.id === saved.id), true);
  const restored = await clean.restoreBackup(saved.id, { directoryName: 'independent' }); assert.equal(restored.verified, true);
  await assert.rejects(app.restoreBackup(saved.id, { destination: options.databasePath }), /不覆盖/);
  await assert.rejects(clean.restoreBackup(saved.id, { directoryName: 'independent' }), /不覆盖/);
  assert.equal(statSync(join(dir, 'backups', saved.id)).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'backups', saved.id, 'business.sqlite')).mode & 0o777, 0o600);
  const damaged = join(dir, 'backups', saved.id, 'business.sqlite'); const intact = readFileSync(damaged); writeFileSync(damaged, Buffer.from('损坏模拟'));
  assert.equal((await app.verifyBackup(saved.id)).valid, false); await assert.rejects(app.restoreBackup(saved.id), /损坏/);
  for (let i = 0; i < 3; i++) { at(`2026-10-11T04:${String(i).padStart(2, '0')}:00Z`); await app.createBackup(); }
  assert.equal(existsSync(damaged), true); assert.equal(app.listBackups().filter(item => item.status === 'verified').length, 4);
  writeFileSync(damaged, intact); assert.equal((await app.verifyBackup(saved.id)).valid, true);
  const fixture = new DatabaseSync(options.databasePath); fixture.exec("UPDATE announcement_attachments SET content=x'00'"); fixture.close();
  assert.equal((await app.createBackup()).status, 'failed'); assert.equal((await app.verifyBackup(saved.id)).valid, true);
});

test('HTTP手动备份与隔离恢复后重启Web可读，恢复核对模式拒绝写入和外部接入', async t => {
  const { startServer } = await import('../src/server.mjs');
  const { options } = setup(t); const app = createApplication(options); t.after(() => app.close()); const { job } = await seed(app);
  const server = await startServer({ app, port: 0 }); t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, input) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const created = await request(base + '/api/backups', { trigger: 'manual' }); assert.equal(created.status, 201); const saved = await created.json();
  assert.match(await (await fetch(base + '/backups')).text(), /完整备份/);
  const response = await request(base + `/api/backups/${saved.id}/restore`, { directoryName: 'http-restored' }); assert.equal(response.status, 201); const restored = await response.json();
  const copy = createApplication({ databasePath: restored.databasePath }); t.after(() => copy.close());
  const copyServer = await startServer({ app: copy, port: 0 }); t.after(() => new Promise(resolve => copyServer.close(resolve))); const second = `http://127.0.0.1:${copyServer.address().port}`;
  const restoredDetail = await (await fetch(second + `/jobs/${job.id}`)).text();
  assert.match(restoredDetail, /算法专家/);
  assert.match(restoredDetail, /本人模拟备注/);
  assert.match(restoredDetail, /模拟面试/);
  assert.match(restoredDetail, /撤销误勾/);
  assert.doesNotMatch(await (await fetch(second + '/applications')).text(), /算法专家/);

  assert.equal((await request(second + '/api/sources/efunds/check', {})).status, 400);
  assert.throws(() => copy.setPersonalState(job.id, { followed: false }), /恢复核对模式/);
  await assert.rejects(copy.pruneBackups({dryRun:false}),/恢复核对模式/);
  assert.equal(app.getPersonalState(job.id).followed, true);
});

test('中断锁不自动强删，恢复拒绝符号链接，未完成staging不算成功版本', async t => {
  const { mkdirSync, writeFileSync, unlinkSync, symlinkSync, existsSync } = await import('node:fs');
  const { dir, options } = setup(t); const app = createApplication(options); t.after(() => app.close()); await seed(app);
  const saved = await app.createBackup();
  mkdirSync(join(dir, 'backups', '.staging-interrupted')); writeFileSync(join(dir, 'backups', '.staging-interrupted', 'original.txt'), '模拟中断原文');
  writeFileSync(options.databasePath + '.backup.lock', JSON.stringify({ pid: -1, token: 'simulated-interrupted' }));
  await assert.rejects(app.createBackup(), /上次备份中断/); assert.equal(existsSync(options.databasePath + '.backup.lock'), true); assert.equal(app.listBackups().filter(item => item.status === 'verified').length, 1);
  unlinkSync(options.databasePath + '.backup.lock'); // 唯一删除本测试自建的模拟锁，不代表自动中断恢复。
  symlinkSync(join(dir, 'backups'), join(dir, 'restored'));
  await assert.rejects(app.restoreBackup(saved.id), /符号链接/);
  assert.equal(existsSync(join(dir, 'backups', '.staging-interrupted', 'original.txt')), true); assert.equal((await app.verifyBackup(saved.id)).valid, true);
});

test('独立包扫描及核验拒绝包目录和manifest链接，不读取包根外清单', async t => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
  const { dir, options } = setup(t); const app = createApplication(options); t.after(() => app.close()); await seed(app);
  const saved = await app.createBackup();
  const external = join(dir, 'simulated-external'); mkdirSync(external); writeFileSync(join(external, 'manifest.json'), JSON.stringify({ createdAt: 'outside-package-sentinel', kind: 'routine' }));
  const id = '00000000-0000-4000-8000-000000000001'; symlinkSync(external, join(dir, 'backups', id));
  assert.equal(app.listBackups().find(item => item.id === id).status, 'invalid');
  assert.equal((await app.verifyBackup(id)).valid, false);
  const other = '00000000-0000-4000-8000-000000000002'; mkdirSync(join(dir, 'backups', other)); symlinkSync(join(external, 'manifest.json'), join(dir, 'backups', other, 'manifest.json'));
  assert.equal(app.listBackups().find(item => item.id === other).status, 'invalid'); assert.equal((await app.verifyBackup(saved.id)).valid, true);
});

test('官方快照中的外部job_id不冒作内部岗位关联，原件完整备份且内部悬空引用仍拒绝',async t=>{
 const {options}=setup(t),app=createApplication({...options,expandedSources:true});t.after(()=>app.close());
 await seed(app);
 app.recordSourceCheck({id:'external-role',sourceId:'unicom-digital-social',status:'success',checkedAt:'2026-10-07T02:00:00Z',expandedSource:true,listComplete:true,listings:[{externalId:'205272759062758303',title:'算法开发岗',raw:{job_id:'205272759062758303',jobIds:['vendor-role']}}],reviewSelected:[{candidate:{raw:{raw:{job_id:'205272759062758303'}}}}],jobIds:[]});
 const saved=await app.createBackup();assert.equal(saved.status,'verified',JSON.stringify(saved.gaps));
 const restored=await app.restoreBackup(saved.id,{directoryName:'external-role'});assert.equal(restored.verified,true);
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(options.databasePath);t.after(()=>db.close());
 db.exec('CREATE TABLE future_evidence (id TEXT PRIMARY KEY,body TEXT NOT NULL)');db.prepare('INSERT INTO future_evidence VALUES(?,?)').run('broken',JSON.stringify({nested:{jobId:'missing-internal-job'}}));
 const rejected=await app.createBackup();assert.equal(rejected.status,'failed');assert.deepEqual(rejected.failure,{stage:'data_validation',code:'business_reference'});assert.match(rejected.gaps[0],/内部业务关联缺失/);assert.doesNotMatch(JSON.stringify(rejected.failure),/missing-internal-job/);
 db.prepare('UPDATE future_evidence SET body=? WHERE id=?').run(JSON.stringify({'metadata.raw':{jobId:'missing-internal-job'}}),'broken');
 assert.equal((await app.createBackup()).status,'failed','字段名中的点不是raw子树边界');
});

test('已有备份可先预览再清理至3份，计划变化拒绝执行且原成功/失败记录保留',async t=>{
 const {dir,options,at}=setup(t),app=createApplication(options);t.after(()=>app.close());await seed(app);
 const {readFileSync,writeFileSync,existsSync}=await import('node:fs');
 const first=await app.createBackup();const path=join(dir,'backups',first.id,'business.sqlite');const intact=readFileSync(path);writeFileSync(path,'模拟损坏');
 for(let i=0;i<3;i++){at(`2026-10-11T05:0${i}:00Z`);await app.createBackup();}
 writeFileSync(path,intact);
 const preview=await app.pruneBackups();assert.equal(preview.dryRun,true);assert.equal(preview.keep.length,3);assert.deepEqual(preview.remove.map(x=>x.id),[first.id]);
 assert.equal(existsSync(path),true);assert.equal(app.getBackup(first.id).status,'verified');
 await assert.rejects(app.pruneBackups({dryRun:false,expectedPlanHash:'changed'}),/计划已变化/);assert.equal(existsSync(path),true);
 const result=await app.pruneBackups({dryRun:false,expectedPlanHash:preview.planHash});assert.equal(result.removed.length,1);
 assert.equal(app.getBackup(first.id).status,'pruned');assert.equal(existsSync(path),false);
 assert.equal(app.listBackups().filter(x=>x.status==='verified').length,3);assert.equal(app.listJobs().length,1);
});

test('失败备份不淘汰成功包，清理本轮临时副本；历史失败暂存仅在有完整可恢复包时清理',async t=>{
 const {dir,options,at}=setup(t),app=createApplication(options);t.after(()=>app.close());await seed(app);
 for(let i=0;i<3;i++){at(`2026-10-11T06:0${i}:00Z`);await app.createBackup();}
 const {DatabaseSync}=await import('node:sqlite');const fixture=new DatabaseSync(options.databasePath);t.after(()=>fixture.close());
 fixture.exec('CREATE TABLE missing_reference (id TEXT PRIMARY KEY, body TEXT NOT NULL)');fixture.prepare('INSERT INTO missing_reference VALUES (?,?)').run('bad',JSON.stringify({jobId:'nonexistent-job'}));
 const failed=await app.createBackup();assert.equal(failed.status,'failed');
 const {existsSync,mkdirSync,writeFileSync,symlinkSync,readFileSync}=await import('node:fs');const staging=join(dir,'backups',`.staging-${failed.id}`);
 assert.equal(existsSync(staging),false);assert.equal(app.listBackups().filter(x=>x.status==='verified').length,3);
 mkdirSync(staging);writeFileSync(join(staging,'business.sqlite'),'模拟旧失败快照');
 const unknown=join(dir,'backups','.staging-unknown');mkdirSync(unknown);writeFileSync(join(unknown,'original.txt'),'未知文件不能清理');
 fixture.exec('DROP TABLE missing_reference');
 const plan=await app.pruneBackups();assert.equal(existsSync(staging),true);assert.deepEqual(plan.remove.map(x=>x.reason),['failed_staging']);
 await app.pruneBackups({dryRun:false,expectedPlanHash:plan.planHash});assert.equal(existsSync(staging),false);assert.equal(existsSync(join(unknown,'original.txt')),true);
 assert.equal(app.getBackup(failed.id).status,'failed');assert.ok(app.getBackup(failed.id).artifactsRemovedAt);assert.equal(app.listBackups().filter(x=>x.status==='verified').length,3);
 const outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'business.sqlite'),'外部保留');symlinkSync(outside,staging);
 await assert.rejects(app.pruneBackups(),/暂存目录无效/);assert.equal(readFileSync(join(outside,'business.sqlite'),'utf8'),'外部保留');
});
