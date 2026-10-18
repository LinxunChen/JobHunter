import * as sqlite from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, lstatSync, readdirSync, renameSync, realpathSync, rmSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync,execFile } from 'node:child_process';
import {promisify} from 'node:util';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from './processing-owner.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { integer: item.toString() } : item instanceof Uint8Array ? { bytes: item.length, sha256: sha(item) } : item);
const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const excluded = ['Codex登录／auth', 'pushplus凭据', '浏览器cookies', '环境及用户／系统配置'];

async function inspect(databasePath,python) {
  const {stdout}=await promisify(execFile)(python,[fileURLToPath(new URL('./inspect-backup.py',import.meta.url)),databasePath],{maxBuffer:2*1024*1024});
  return JSON.parse(stdout);
}
async function fileFingerprint(path,python) {
  const {stdout}=await promisify(execFile)(python,[fileURLToPath(new URL('./inspect-backup.py',import.meta.url)),path,'--fingerprint'],{maxBuffer:4096});
  return JSON.parse(stdout);
}

async function verifyPackage(path,python) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('备份目录无效');
  const names = readdirSync(path).sort();
  if (canonical(names) !== canonical(['business.sqlite', 'manifest.json'])) throw new Error('备份包文件不完整或含未知文件');
  for (const name of names) if (!lstatSync(join(path, name)).isFile() || lstatSync(join(path, name)).isSymbolicLink()) throw new Error('备份包含非法链接');
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || manifest.status !== 'verified' || !ids.test(manifest.id) || manifest.database.path !== 'business.sqlite') throw new Error('备份清单版本或路径无效');
  if (ids.test(basename(path)) && basename(path) !== manifest.id) throw new Error('备份ID与目录不符');
  const fingerprint=await fileFingerprint(join(path,'business.sqlite'),python);
  if (fingerprint.bytes !== manifest.database.bytes || fingerprint.sha256 !== manifest.database.sha256) throw new Error('备份数据库SHA或大小不符');
  const information = await inspect(join(path, 'business.sqlite'),python);
  if (canonical(information) !== canonical(manifest.verification)) throw new Error('备份结构／内容／附件清单校验不符');
  return manifest;
}

const canonicalDatabasePath = databasePath => existsSync(databasePath) ? realpathSync(databasePath) : resolve(databasePath);
const lockPath = databasePath => canonicalDatabasePath(databasePath) + '.backup.lock';
export function recoverBackupLock(databasePath) {
  const path=lockPath(databasePath);if(!existsSync(path))return null;
  try {
    const metadata=lstatSync(path);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||(metadata.mode&0o077)||metadata.size>4096)return null;
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(!ids.test(value.token??'')||!Number.isInteger(value.pid)||value.pid<=0||!Number.isFinite(Date.parse(value.startedAt)))return null;
    if(processingOwnerAlive({...value,id:value.token})!==false)return null;
    if(JSON.parse(readFileSync(path,'utf8')).token!==value.token)return null;
    unlinkSync(path);return {id:randomUUID(),kind:'backup_lock_recovered',at:new Date().toISOString(),ownerPid:value.pid,reason:'备份所属进程已退出，释放中断锁；未完成备份不计成功，原目录保留'};
  }catch{return null;}
}
export function guardBackupWrites(db, databasePath, ValidationError, readOnly = () => false, initializing = () => false) {
  const readStatements=new Map();
  const rawBodies=/\bfrom\s+(?:source_checks|source_health_checks|scheduled_runs|announcements|recruitment_observations)\b/i;
  const preparedRead=sql=>{
    const cacheable=/^\s*select\b/i.test(sql)&&!rawBodies.test(sql);
    if(!cacheable)return db.prepare(sql);
    if(readStatements.has(sql)){const value=readStatements.get(sql);readStatements.delete(sql);readStatements.set(sql,value);return value;}
    const value=db.prepare(sql);readStatements.set(sql,value);if(readStatements.size>256)readStatements.delete(readStatements.keys().next().value);return value;
  };
  const bootDuringBackup = () => initializing() && existsSync(lockPath(databasePath));
  const check = () => { if (readOnly()) throw new ValidationError('恢复核对模式只读，真实抓取／模型／发送和业务写入均停用'); if (existsSync(lockPath(databasePath))) throw new ValidationError('备份进行中或上次备份中断，请稍后重试；中断锁须人工核查'); };
  return new Proxy(db, { get(target, key) {
    if (key === 'exec') return sql => { if(bootDuringBackup())return; check(); return target.exec(sql); };
    if (key === 'prepare') return sql => {
      const statement = preparedRead(sql);
      return new Proxy(statement, { get(item, method) {
        const value = item[method];
        if (typeof value !== 'function') return value;
        return (...args) => { if(method==='iterate')readStatements.delete(sql); if(method==='run'&&bootDuringBackup())return {changes:0,lastInsertRowid:0}; if (method === 'run' || (['all', 'get', 'iterate'].includes(method) && !/^\s*(SELECT|PRAGMA\s+(integrity_check|foreign_key_check))\b/i.test(sql))) check(); return value.apply(item, args); };
      } });
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function acquireLock(databasePath, ValidationError) {
  recoverBackupLock(databasePath);
  const path = lockPath(databasePath),owner=beginProcessingOwner(),token=owner.id;
  try { writeFileSync(path, JSON.stringify({token,pid:owner.pid,processStartedAt:owner.processStartedAt,startedAt:new Date().toISOString()}), { flag: 'wx', mode: 0o600 }); }
  catch {endProcessingOwner(owner);throw new ValidationError('备份进行中或上次备份中断，请稍后重试；中断锁须人工核查'); }
  return () => {try{if(JSON.parse(readFileSync(path,'utf8')).token===token)unlinkSync(path);}finally{endProcessingOwner(owner);} };
}

export function createBackupOperations({ db, backupDb=db, databasePath, now, verificationMode=false, attachmentPython=process.env.JOBHUNTER_ATTACHMENT_PYTHON??'python3', backupRoot = join(dirname(databasePath), 'backups'), ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS backup_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS backup_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const existing = db.prepare("SELECT body FROM backup_settings WHERE id='owner'").get();
  const ownerId = existing ? JSON.parse(existing.body).ownerId : randomUUID();
  if (!existing) db.prepare('INSERT INTO backup_settings (id,body) VALUES (?,?)').run('owner', JSON.stringify({ ownerId, firstSeenAt: now().toISOString() }));
  const firstSeenAt = existing ? JSON.parse(existing.body).firstSeenAt ?? now().toISOString() : now().toISOString();
  const sourceFingerprint = sha(canonicalDatabasePath(databasePath));
  const root = resolve(backupRoot); const dataRoot = realpathSync(dirname(databasePath)); const restoreRoot = join(dataRoot, 'restored');
  const save = record => { backupDb.prepare('INSERT INTO backup_runs(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id, JSON.stringify(record)); return record; };
  const getBackup = id => { const row = db.prepare('SELECT body FROM backup_runs WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; };
  const packagePath = id => { if (!ids.test(id)) throw new ValidationError('备份ID无效'); if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new ValidationError('备份根不能为符号链接'); return join(root, id); };
  const recorded = () => db.prepare('SELECT body FROM backup_runs ORDER BY rowid DESC').all().map(row => JSON.parse(row.body));
  const listBackups = () => {
    const records = recorded(); const known = new Set(records.map(record => record.id));
    if (existsSync(root) && !lstatSync(root).isSymbolicLink()) for (const id of readdirSync(root).filter(id => ids.test(id) && !known.has(id))) {
      try { const path = packagePath(id); const manifestPath = join(path, 'manifest.json'); if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) throw new Error('拒绝链接清单'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); records.push({ id, status: 'available_unverified', kind: manifest.kind === 'pre_upgrade' ? 'pre_upgrade' : 'routine', createdAt: manifest.createdAt, gaps: ['独立目录中的备份，使用前必须完整核验；不纳入本库自动清理'] }); }
      catch { records.push({ id, status: 'invalid', kind: 'unknown', gaps: ['备份包清单无法读取'] }); }
    }
    return records;
  };
  const stagingInfo = record => {
    packagePath(record.id); // Validate the ID and reject a linked backup root.
    const path=join(root,`.staging-${record.id}`);
    if(!existsSync(path))return null;
    const directory=lstatSync(path);
    if(!directory.isDirectory()||directory.isSymbolicLink())throw new ValidationError('备份暂存目录无效，停止清理');
    const allowed=new Set(['business.sqlite','business.sqlite-journal','business.sqlite-wal','business.sqlite-shm','manifest.json']);
    const files=readdirSync(path).sort().map(name=>{
      const file=lstatSync(join(path,name));
      if(!allowed.has(name)||!file.isFile()||file.isSymbolicLink()||file.nlink!==1)throw new ValidationError('备份暂存含未知文件，停止清理');
      return {name,bytes:file.size,modifiedAt:file.mtimeMs,inode:file.ino};
    });
    return {id:record.id,path,reason:'failed_staging',bytes:files.reduce((n,f)=>n+f.bytes,0),files};
  };
  const retentionPlan = async () => {
    const checkpoints = recorded().filter(item => item.status === 'verified' && ['routine','pre_upgrade'].includes(item.kind) && item.ownerId === ownerId && item.sourceFingerprint === sourceFingerprint).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    // A failed or unowned package never counts as one of the recovery checkpoints.
    for (const candidate of checkpoints) {
      const manifest = await verifyPackage(packagePath(candidate.id),attachmentPython);
      if (manifest.ownerId !== ownerId || manifest.sourceFingerprint !== sourceFingerprint || manifest.kind !== candidate.kind || manifest.createdAt !== candidate.createdAt || manifest.database.sha256 !== candidate.manifest?.database.sha256) throw new ValidationError('备份归属或记录不符，停止清理');
    }
    const describe = item => ({id:item.id,kind:item.kind,createdAt:item.createdAt,path:packagePath(item.id),bytes:item.manifest.database.bytes,sha256:item.manifest.database.sha256});
    const keep = checkpoints.slice(0,3).map(describe), remove = checkpoints.slice(3).map(item=>({...describe(item),reason:'checkpoint_limit'}));
    if(keep.length)for(const record of recorded().filter(item=>['failed','creating'].includes(item.status)&&item.ownerId===ownerId&&item.sourceFingerprint===sourceFingerprint)){
      const staging=stagingInfo(record);if(staging)remove.push(staging);
    }
    return {limit:3,keep,remove,planHash:sha(canonical({keep,remove}))};
  };
  const applyRetention = async ({dryRun=true,expectedPlanHash}={}) => {
    const plan=await retentionPlan();
    if(expectedPlanHash!==undefined && expectedPlanHash!==plan.planHash) throw new ValidationError('备份清理计划已变化，请重新预览');
    if(dryRun)return {...plan,dryRun:true};
    const removed=[];
    for(const candidate of plan.remove){
      rmSync(candidate.path,{recursive:true});const previous=getBackup(candidate.id);
      save(candidate.reason==='failed_staging'?{...previous,status:'failed',artifactsRemovedAt:now().toISOString(),...(previous.status==='creating'?{gaps:['备份进程中断，未发布成功包；暂存已清理，已有成功包保留']}:{} )}:{...previous,status:'pruned',prunedAt:now().toISOString()});
      removed.push(candidate.id);
    }
    return {...plan,dryRun:false,removed};
  };
  return {
    getBackup, listBackups,
    async pruneBackups({dryRun=true,expectedPlanHash}={}) {
      if(dryRun)return applyRetention({dryRun:true,expectedPlanHash});
      if(verificationMode)throw new ValidationError('恢复核对模式只读，不清理备份');
      const release=acquireLock(databasePath,ValidationError);
      try{return await applyRetention({dryRun,expectedPlanHash});}finally{release();}
    },
    async verifyBackup(id) {
      try { const manifest = await verifyPackage(packagePath(id),attachmentPython); return { valid: true, id, verification: manifest.verification, credentialsRestored: false }; }
      catch { return { valid: false, id, gaps: ['备份包损坏、不完整或结构／附件校验失败'] }; }
    },
    async createBackup({ trigger = 'manual' } = {}) {
      if(verificationMode)throw new ValidationError('恢复核对模式只读，不创建备份记录');
      if (databasePath === ':memory:') throw new ValidationError('完整备份需要持久SQLite路径');
      if (!['manual', 'scheduled', 'upgrade'].includes(trigger)) throw new ValidationError('备份仅支持手动、计划或升级前入口');
      if (trigger === 'scheduled') {
        const local = new Date(now().getTime() + 8 * 3600000);
        const sunday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - local.getUTCDay()) - 8 * 3600000;
        const success = listBackups().find(item => ['verified', 'pruned'].includes(item.status) && item.kind === 'routine' && item.ownerId === ownerId && item.sourceFingerprint === sourceFingerprint && Date.parse(item.createdAt) >= sunday);
        if (sunday < Date.parse(firstSeenAt) || success) return { status: 'not_due', nextSundayCheck: true };
      }
      const release = acquireLock(databasePath, ValidationError);
      let reservation;
      const id = randomUUID(); const record = { id, trigger, kind: trigger === 'upgrade' ? 'pre_upgrade' : 'routine', createdAt: now().toISOString(), status: 'creating', ownerId, sourceFingerprint, gaps: [] };
      let stage='snapshot',stagingCreated=false;
      try {
        save(record);
        reservation = new sqlite.DatabaseSync(databasePath); reservation.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
        if (typeof sqlite.backup !== 'function') throw new Error('当前Node缺少SQLite backup能力');
        mkdirSync(root, { recursive: true, mode: 0o700 }); if (lstatSync(root).isSymbolicLink()) throw new Error('备份根不能为符号链接'); chmodSync(root, 0o700);
        const staging = join(root, `.staging-${id}`); mkdirSync(staging, { mode: 0o700 }); stagingCreated=true;
        const destination = join(staging, 'business.sqlite');
        await sqlite.backup(backupDb, destination); chmodSync(destination, 0o600);
        const snapshot = new sqlite.DatabaseSync(destination); snapshot.exec('PRAGMA journal_mode=DELETE'); snapshot.close();
        stage='fingerprint';const fingerprint=await fileFingerprint(destination,attachmentPython);
        stage='data_validation';const verification=await inspect(destination,attachmentPython);
        const workingDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
        let gitVersion = 'unverified', gitDirty = null;
        try { gitVersion = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory, encoding: 'utf8' }).trim(); gitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: workingDirectory, encoding: 'utf8' }).trim()); } catch {}
        const manifest = { ...record, status: 'verified', formatVersion: 1, timezone: 'Asia/Shanghai', appVersion: '0.1.0', appGitVersion: gitVersion, appGitDirty: gitDirty, nodeVersion: process.version, schemaVersion: verification.schemaHash, database: { path: 'business.sqlite', ...fingerprint }, verification, credentialsExcluded: excluded };
        writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        stage='package_validation';await verifyPackage(staging,attachmentPython);
        stage='publish';
        for (const path of [destination, join(staging, 'manifest.json'), staging]) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
        renameSync(staging, packagePath(id));
        const rootFd = openSync(root, 'r'); try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
        reservation.exec('COMMIT'); reservation.close(); reservation = null;
        record.status = 'verified'; record.manifest = manifest; save(record);
        const owned=recorded().filter(item=>item.ownerId===ownerId&&item.sourceFingerprint===sourceFingerprint);
        try { if(owned.filter(item=>item.status==='verified').length>3||owned.some(item=>['failed','creating'].includes(item.status)&&existsSync(join(root,`.staging-${item.id}`))))await applyRetention({dryRun:false}); }
        catch { record.gaps.push('新备份完整；旧包核验或归属异常，停止保留池清理'); }
        return save({...getBackup(id),gaps:record.gaps});
      } catch(error) { if (reservation) { try { reservation.exec('ROLLBACK'); } catch {} reservation.close(); reservation = null; } record.status = 'failed';
        // Do not persist arbitrary subprocess output or private field values.
        const detail=String(error.stderr??'');
        const code=detail.includes('业务关联缺失')?'business_reference':detail.includes('SQLite结构或外键校验失败')?'database_integrity':detail.includes('已取得附件缺失或SHA不符')?'attachment_integrity':'execution';
        record.failure={stage,code};
        const stages={snapshot:'创建快照',fingerprint:'计算文件校验',data_validation:'核验业务数据',package_validation:'复核完整备份包',publish:'发布备份包'};
        const causes={business_reference:'内部业务关联缺失',database_integrity:'SQLite结构或外键异常',attachment_integrity:'原始附件缺失或哈希不符',execution:'执行失败'};
        record.gaps = [`备份${stages[stage]}失败：${causes[code]}；未发布成功包，已有备份和业务原文保留`];
        if(stagingCreated)try{const staging=stagingInfo(record);if(staging){rmSync(staging.path,{recursive:true});record.artifactsRemovedAt=now().toISOString();}}catch{record.gaps.push('失败暂存清理未完成，保留目录供核查');}
        return save(record); } finally { release(); }
    },
    async restoreBackup(id, { directoryName = `restore-${randomUUID()}`, destination } = {}) {
      if(verificationMode)throw new ValidationError('恢复核对模式只读，不创建恢复目录');
      const release = acquireLock(databasePath, ValidationError);
      try {
      let manifest; try { manifest = await verifyPackage(packagePath(id),attachmentPython); } catch { throw new ValidationError('备份损坏或不完整，拒绝恢复'); }
      if (typeof directoryName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(directoryName)) throw new ValidationError('恢复目录名称无效');
      const target = destination ? resolve(destination) : join(restoreRoot, directoryName);
      const rel = relative(restoreRoot, target);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || existsSync(target)) throw new ValidationError('只允许恢复到隔离的新空路径，不覆盖现用或已有数据');
      mkdirSync(restoreRoot, { recursive: true, mode: 0o700 }); if (lstatSync(restoreRoot).isSymbolicLink()) throw new ValidationError('恢复根不能为符号链接'); chmodSync(restoreRoot, 0o700);
      if (dirname(target) !== restoreRoot) throw new ValidationError('恢复目标须直接位于隔离恢复目录');
      mkdirSync(target, { mode: 0o700 }); const restoredPath = join(target, 'business.sqlite');
      copyFileSync(join(packagePath(id), 'business.sqlite'), restoredPath, 1); chmodSync(restoredPath, 0o600);
      const verification=await inspect(restoredPath,attachmentPython);
      if (canonical(verification) !== canonical(manifest.verification)) throw new ValidationError('恢复后数据核验不符，不采用此目录');
      writeFileSync(join(target, 'restore-verification.json'), JSON.stringify({ backupId: id, verificationMode: true, credentialsRestored: false }) + '\n', { flag: 'wx', mode: 0o600 });
      return { backupId: id, directory: target, databasePath: restoredPath, verified: true, verification, credentialsRestored: false, verificationMode: true };
      } finally { release(); }
    },
  };
}
