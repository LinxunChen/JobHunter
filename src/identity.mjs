import { randomUUID, createHash } from 'node:crypto';
import {validRecruitmentUnitEvidence} from './recruitment-unit-evidence.mjs';

export function createIdentityOperations({ db, getJob, buildJob, now, ValidationError }) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_sources (source_id TEXT NOT NULL, external_id TEXT NOT NULL, scope TEXT NOT NULL, job_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(source_id,external_id,scope));
    CREATE TABLE IF NOT EXISTS job_observations (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL, observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_versions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_relations (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL)`);
  const text = (value, field, optional = false) => {
    if (optional && (value == null || value === '')) return null;
    if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field}必须为非空文本`);
    return value.trim();
  };
  const timestamp = value => {
    if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(new Date(value).getTime())) throw new ValidationError('成功检查时间必须含时区');
    return new Date(value).toISOString();
  };
  const parse = row => row ? JSON.parse(row.body) : null;
  const history = id => ({
    versions: db.prepare('SELECT body FROM job_versions WHERE job_id=? ORDER BY rowid').all(id).map(parse),
    observations: db.prepare('SELECT body FROM job_observations WHERE job_id=? ORDER BY rowid').all(id).map(parse),
    relations: db.prepare("SELECT body FROM job_relations WHERE job_id=? OR json_extract(body,'$.priorJobId')=? ORDER BY rowid").all(id, id).map(parse),
  });
  const scopeOf = job => JSON.stringify([job.recruitmentUnit, job.department, job.batch]);
  const material = job => JSON.stringify({
    title: job.title, recruitmentUnit: job.recruitmentUnit, contractingEntity: job.contractingEntity,
    department: job.department, batch: job.batch, duties: job.duties ?? null,
    locations: [...job.location.options].sort(), confirmed: job.location.confirmed,
    conditions: [...job.knownConditions].sort(), applicationPath: job.applicationPath,
    dates: (job.dateEvidence ?? []).filter(date => date.meaning === 'explicit_deadline').map(date => ({ field: date.field, raw: date.raw })),
    recruitmentStatus: job.recruitmentStatus,
  });
  return {
    getJobHistory(id) { if (!getJob(id)) throw new ValidationError('岗位不存在'); return history(id); },
    recordJobRecruitmentUnitEvidence(id,{sourceId,externalId,evidence}) {
      const job=getJob(id);
      if(!job||!validRecruitmentUnitEvidence(evidence,{title:job.title,sourceUrl:job.sourceUrl,checkedAt:evidence?.checkedAt})||!Number.isFinite(Date.parse(evidence.checkedAt))||Date.parse(evidence.checkedAt)>now().getTime()||!job.sourceIdentities?.some(x=>x.sourceId===sourceId&&(x.externalId===externalId||x.externalId===job.sourceUrl)))throw new ValidationError('招聘单位补齐须有同一岗位、来源和可回读的官网证据');
      const supported=[evidence.value,...evidence.aliases];
      if(job.recruitmentUnit&&!supported.includes(job.recruitmentUnit))return {status:'conflict',job};
      if(job.recruitmentUnitEvidence?.checkedAt>evidence.checkedAt)return {status:'historical',job};
      const scope=scopeOf({...job,recruitmentUnit:evidence.value});
      const binding=db.prepare('SELECT job_id FROM job_sources WHERE source_id=? AND external_id=? AND scope=?').get(sourceId,externalId,scope);
      if(binding&&binding.job_id!==id)return {status:'conflict',job};
      const observationId='unit:'+id+':'+createHash('sha256').update(JSON.stringify([sourceId,externalId,evidence.value,evidence.rawHash,evidence.quotes])).digest('hex');
      if(job.recruitmentUnit===evidence.value&&db.prepare('SELECT id FROM job_observations WHERE id=?').get(observationId))return {status:'unchanged',job};
      const ownsTransaction=!db.isTransaction;if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
      try {
        const previousValue=job.recruitmentUnit;
        job.recruitmentUnit=evidence.value;job.recruitmentUnitEvidence=structuredClone(evidence);
        // This corrects a missing field in the extraction. Retain the original
        // JD and its version so matching and manual overlays stay applicable.
        const observation={id:observationId,observedAt:evidence.checkedAt,type:'source_enrichment',field:'recruitmentUnit',previousValue,value:evidence.value,sourceIdentity:{sourceId,externalId},sourceUrl:evidence.sourceUrl,sourceHash:evidence.rawHash,originalText:evidence.text,evidence:structuredClone(evidence),versionId:job.currentVersionId,snapshot:job};
        db.prepare('INSERT INTO job_observations (id,job_id,body,observed_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING').run(observationId,id,JSON.stringify(observation),evidence.checkedAt);
        db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job),id);
        // Keep the prior incomplete binding too: cached extraction can still
        // return null, while a fresh extraction can now return the full name.
        db.prepare('INSERT INTO job_sources (source_id,external_id,scope,job_id,body) VALUES (?,?,?,?,?) ON CONFLICT(source_id,external_id,scope) DO NOTHING').run(sourceId,externalId,scope,id,JSON.stringify({sourceId,externalId,stableCode:null}));
        db.prepare('INSERT INTO job_sources (source_id,external_id,scope,job_id,body) VALUES (?,?,?,?,?) ON CONFLICT(source_id,external_id,scope) DO NOTHING').run(sourceId,externalId,scopeOf({...job,recruitmentUnit:null}),id,JSON.stringify({sourceId,externalId,stableCode:null}));
        if(ownsTransaction)db.exec('COMMIT');return {status:'enriched',job:getJob(id)};
      }catch(error){if(ownsTransaction)db.exec('ROLLBACK');throw error;}
    },
    importJob(input) {
      const identity = input?.sourceIdentity;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new ValidationError('来源身份必须含sourceId和externalId');
      const sourceIdentity = { sourceId: text(identity.sourceId, '来源标识'), externalId: text(identity.externalId, '来源岗位ID'), stableCode: text(identity.stableCode, '稳定编号', true) };
      const metadata = {};
      for (const field of ['announcementId', 'sourceContentVersion', 'processingVersion', 'duties', 'conditions', 'evidence', 'sourceEvidence']) if (input[field] != null) metadata[field] = input[field];
      if (input.dateEvidence != null && (!Array.isArray(input.dateEvidence) || input.dateEvidence.some(date => typeof date?.field !== 'string' || typeof date.raw !== 'string' || !['unverified', 'explicit_publish_date', 'explicit_registration_start', 'explicit_deadline'].includes(date.meaning)))) throw new ValidationError('日期证据需要原值及已知语义');
      metadata.dateEvidence = input.dateEvidence ?? [];
      if (input.recruitmentStatus != null) metadata.recruitmentStatus = text(input.recruitmentStatus, '来源招聘状态');
      const candidate = buildJob(input, metadata);
      if (metadata.recruitmentStatus) candidate.recruitmentStatus = metadata.recruitmentStatus;
      candidate.refreshedAt = text(input.refreshedAt, '平台刷新原值', true);
      const observedAt = timestamp(input.observedAt ?? now().toISOString());
      const scope = scopeOf(candidate);
      const ownsTransaction = !db.isTransaction;
      if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
      try {
        const binding = db.prepare('SELECT job_id FROM job_sources WHERE source_id=? AND external_id=? AND scope=?').get(sourceIdentity.sourceId, sourceIdentity.externalId, scope);
        let existing = binding ? getJob(binding.job_id) : null;
        let association = null;
        if (input.associationEvidence != null) {
          const value = input.associationEvidence;
          const target = getJob(value.jobId);
          let url;
          try { url = new URL(value.url); } catch { throw new ValidationError('关联证据需要完整官方链接'); }
          if (!target || !['official_link', 'platform_migration', 'manual_confirmed'].includes(value.kind) || typeof value.quote !== 'string' || !value.quote.trim() || ![candidate.originalText, target.originalText].some(raw => raw.includes(value.quote)) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ValidationError('关联原文证据无效');
          if (scopeOf(target) !== scope || target.title !== candidate.title || (existing && existing.id !== target.id)) throw new ValidationError('关联证据不能覆盖不同主体、部门、批次或已有关联');
          association = { jobId: target.id, kind: value.kind, url: url.href, quote: value.quote };
          existing = target;
        }
        if(existing?.recruitmentUnitEvidence&&!candidate.recruitmentUnit&&candidate.title===existing.title&&candidate.sourceUrl===existing.sourceUrl)candidate.recruitmentUnit=existing.recruitmentUnit;
        const previousHistory = existing ? history(existing.id) : { versions: [], observations: [], relations: [] };
        let type = existing ? (material(existing) !== material(candidate) && existing.originalText !== candidate.originalText ? 'substantive_change' : (existing.originalText !== candidate.originalText || existing.refreshedAt !== candidate.refreshedAt || material(existing) !== material(candidate) ? 'refresh' : 'unchanged')) : 'new';
        let priorRelation = null;
        if (!existing) {
          const candidates = db.prepare('SELECT body FROM jobs ORDER BY rowid').all().map(parse).filter(job => job.title === candidate.title && job.recruitmentUnit === candidate.recruitmentUnit);
          const batchPrior = candidates.find(job => job.recruitmentUnit && job.department === candidate.department && job.batch && candidate.batch && job.batch !== candidate.batch && job.originalText.includes(job.batch) && candidate.originalText.includes(candidate.batch));
          const possible = candidates.find(job => scopeOf(job) === scope) ?? candidates.find(job => job.department == null || candidate.department == null || job.batch == null || candidate.batch == null);
          if (batchPrior && !candidates.some(job => scopeOf(job) === scope)) { type = 'new_batch'; priorRelation = { priorJobId: batchPrior.id, reason: '具体主体及部门对应，原文明示不同批次', evidence: { before: batchPrior.batch, after: candidate.batch } }; }
          else if (possible) { type = 'possible_relation'; priorRelation = { priorJobId: possible.id, reason: '名称及部分信息相关，但缺少可靠关联证据' }; }
        }
        if (association && !binding) type = 'source_linked';
        const historical = existing?.lastSuccessfullyCheckedAt && observedAt < existing.lastSuccessfullyCheckedAt;
        if (historical && type !== 'source_linked') type = 'historical_observation';
        const job = existing ? { ...existing, ...(type === 'source_linked' || historical ? {} : candidate), id: existing.id, firstDiscoveredAt: existing.firstDiscoveredAt } : { ...candidate, firstDiscoveredAt: observedAt };
        job.sourceIdentities = existing?.sourceIdentities ?? [];
        if (!job.sourceIdentities.some(item => item.sourceId === sourceIdentity.sourceId && item.externalId === sourceIdentity.externalId)) job.sourceIdentities.push(sourceIdentity);
        job.lastSuccessfullyCheckedAt = historical ? existing.lastSuccessfullyCheckedAt : observedAt;
        let versionId = previousHistory.versions.at(-1)?.id;
        if (!versionId || type === 'substantive_change') {
          versionId = randomUUID();
          const version = { id: versionId, observedAt, type, job: { ...job }, originalText: input.originalText };
          db.prepare('INSERT INTO job_versions (id,job_id,body) VALUES (?,?,?)').run(versionId, job.id, JSON.stringify(version));
        }
        job.currentVersionId = versionId;
        if (priorRelation) {
          const relation = { id: randomUUID(), jobId: job.id, observedAt, type, ...priorRelation };
          db.prepare('INSERT INTO job_relations (id,job_id,body) VALUES (?,?,?)').run(relation.id, job.id, JSON.stringify(relation));
        }
        if (association && !binding) {
          const relation = { id: randomUUID(), observedAt, type: 'source_linked', sourceIdentity, evidence: association };
          db.prepare('INSERT INTO job_relations (id,job_id,body) VALUES (?,?,?)').run(relation.id, job.id, JSON.stringify(relation));
        }
        const observation = { id: randomUUID(), observedAt, sourceIdentity, originalText: candidate.originalText, sourceUrl: candidate.sourceUrl, sourceHash: createHash('sha256').update(candidate.originalText).digest('hex'), type, versionId, snapshot: { ...candidate, id: job.id }, associationEvidence: association };
        db.prepare('INSERT INTO job_observations (id,job_id,body,observed_at) VALUES (?,?,?,?)').run(observation.id, job.id, JSON.stringify(observation), observedAt);
        db.prepare('INSERT INTO job_sources (source_id,external_id,scope,job_id,body) VALUES (?,?,?,?,?) ON CONFLICT(source_id,external_id,scope) DO UPDATE SET body=excluded.body').run(sourceIdentity.sourceId, sourceIdentity.externalId, scope, job.id, JSON.stringify(sourceIdentity));
        db.prepare('INSERT INTO jobs (id,body,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(job.id, JSON.stringify(job), job.firstDiscoveredAt);
        if (ownsTransaction) db.exec('COMMIT');
        return { job: getJob(job.id), change: { type, versionId, reason: existing ? '可靠来源身份相同' : '首次取得此来源岗位证据' } };
      } catch (error) { if (ownsTransaction) db.exec('ROLLBACK'); throw error; }
    },
  };
}
