import { randomUUID, createHash } from 'node:crypto';

const fields = ['title', 'recruitmentUnit', 'contractingEntity', 'department', 'batch', 'location', 'knownConditions', 'unknownFields', 'applicationPath', 'publishedAt'];
const evidenceVersion = job => job.currentVersionId ?? createHash('sha256').update(JSON.stringify({ title: job.title, recruitmentUnit: job.recruitmentUnit, department: job.department, batch: job.batch, conditions: job.knownConditions, location: job.location, applicationPath: job.applicationPath, originalText: job.originalText })).digest('hex');

/** Personal corrections are an overlay; source evidence and source identity remain untouched. */
export function createCorrectionOperations({ db, getSourceJob, normalizeJob, now, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS job_corrections (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL)');
  const requireJob = id => { const job = getSourceJob(id); if (!job) throw new ValidationError('岗位不存在'); return job; };
  const listJobCorrections = jobId => {
    const source = requireJob(jobId);
    const records = db.prepare('SELECT body FROM job_corrections WHERE job_id=? ORDER BY rowid').all(jobId).map(row => JSON.parse(row.body));
    return records.map((record, index) => ({ ...record, superseded: records.slice(index + 1).some(other => other.field === record.field), needsReview: record.applicableEvidenceVersion !== evidenceVersion(source) }));
  };
  const getEffectiveJob = jobId => {
    const source = getSourceJob(jobId);
    if (!source) return null;
    const manualCorrections = listJobCorrections(jobId);
    const job = { ...source, manualCorrections, sourceValues: {} };
    for (const correction of manualCorrections) if (!correction.superseded && !correction.needsReview) {
      job.sourceValues[correction.field] = source[correction.field];
      job[correction.field] = correction.value;
      if (correction.field === 'knownConditions') job.conditions = correction.value.map(text => ({ text, scope: 'manual-correction', evidence: [{ documentId: `manual-correction-${correction.id}`, locator: correction.basis.locator ?? '本人纠正依据', quote: correction.basis.quote ?? correction.basis.reason, sourceUrl: correction.basis.sourceUrl ?? null }] }));
    }
    return job;
  };
  return {
    getEffectiveJob,
    listJobCorrections,
    correctJob(jobId, input) {
      const source = requireJob(jobId);
      if (!input || !fields.includes(input.field)) throw new ValidationError('不支持此纠正字段，原文和来源身份不能覆盖');
      if (!Object.hasOwn(input, 'value') || input.value === undefined) throw new ValidationError('必须明确提供纠正后的值');
      const reason = input.basis?.reason;
      if (typeof reason !== 'string' || !reason.trim()) throw new ValidationError('必须保留明确纠正依据');
      const basis = { reason: reason.trim() };
      for (const field of ['sourceUrl', 'locator', 'quote']) if (input.basis[field] != null) {
        if (typeof input.basis[field] !== 'string') throw new ValidationError('纠正依据字段必须为文本');
        basis[field] = input.basis[field].trim();
      }
      if (basis.sourceUrl) {
        let url;
        try { url = new URL(basis.sourceUrl); } catch { throw new ValidationError('纠正依据链接无效'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ValidationError('纠正依据链接无效');
        basis.sourceUrl = url.href;
      }
      const current = getEffectiveJob(jobId);
      const normalized = normalizeJob({ ...current, [input.field]: input.value });
      const record = { id: randomUUID(), jobId, field: input.field, originalValue: source[input.field], previousValue: current[input.field], value: normalized[input.field], basis, applicableEvidenceVersion: evidenceVersion(source), sourceSnapshot: source, recordedAt: now().toISOString() };
      db.prepare('INSERT INTO job_corrections (id,job_id,body) VALUES (?,?,?)').run(record.id, jobId, JSON.stringify(record));
      return listJobCorrections(jobId).at(-1);
    },
  };
}

export function createApplicationLinkOperations({ db, getApplication, now, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS application_links (application_id TEXT NOT NULL, prior_application_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(application_id,prior_application_id))');
  const requireApplication = id => { const record = getApplication(id); if (!record) throw new ValidationError('投递记录不存在'); return record; };
  return {
    getApplicationLinks(id) {
      requireApplication(id);
      return db.prepare('SELECT body FROM application_links WHERE application_id=? OR prior_application_id=? ORDER BY rowid').all(id, id).map(row => JSON.parse(row.body));
    },
    linkApplication(id, input) {
      const current = requireApplication(id);
      const prior = requireApplication(input?.priorApplicationId);
      const one = current.jobSnapshot;
      const two = prior.jobSnapshot;
      if (current.id === prior.id || current.jobId === prior.jobId || !one.batch || !two.batch || one.batch === two.batch) throw new ValidationError('仅关联不同批次的独立实际申请，未知批次需先核对');
      if (!one.recruitmentUnit || one.recruitmentUnit !== two.recruitmentUnit || one.department !== two.department || one.title !== two.title) throw new ValidationError('招聘主体、部门及岗位不对应，不能强行关联申请');
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw new ValidationError('申请关联需要本人确认依据');
      const existing = db.prepare('SELECT body FROM application_links WHERE application_id=? AND prior_application_id=?').get(id, prior.id);
      if (existing) return JSON.parse(existing.body);
      const link = { id: randomUUID(), applicationId: id, priorApplicationId: prior.id, jobId: current.jobId, priorJobId: prior.jobId, reason: input.reason.trim(), recordedAt: now().toISOString(), type: 'new_batch_application' };
      db.prepare('INSERT INTO application_links (application_id,prior_application_id,body) VALUES (?,?,?)').run(id, prior.id, JSON.stringify(link));
      return link;
    },
  };
}
