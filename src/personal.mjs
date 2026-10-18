import { randomUUID } from 'node:crypto';

/** Personal facts are stored separately from source-derived job evidence. */
export function createPersonalOperations({ db, getJob, now, ValidationError }) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_states (job_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL, recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_mark_events (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
  const recordMarks=(jobId,current,state)=>{
    const actions=['followed','notInterested'].filter(field=>current[field]!==state[field]).map(field=>({field,before:current[field],after:state[field]}));
    if(!actions.length)return;
    const event={id:randomUUID(),jobId,at:now().toISOString(),actions};
    db.prepare('INSERT INTO personal_mark_events VALUES(?,?)').run(event.id,JSON.stringify(event));
  };
  const requireJob = jobId => {
    const job = getJob(jobId);
    if (!job) throw new ValidationError('岗位不存在');
    return job;
  };
  const getApplication = id => {
    const row = db.prepare('SELECT body FROM applications WHERE id = ?').get(id);
    return row ? JSON.parse(row.body) : null;
  };
  const listApplications = jobId => {
    const rows = jobId == null ? db.prepare('SELECT body FROM applications ORDER BY recorded_at DESC, rowid DESC').all() : db.prepare('SELECT body FROM applications WHERE job_id = ? ORDER BY recorded_at DESC, rowid DESC').all(jobId);
    return rows.map(row => JSON.parse(row.body));
  };
  const getPersonalState = jobId => {
    requireJob(jobId);
    const row = db.prepare('SELECT body FROM personal_states WHERE job_id = ?').get(jobId);
    const stored = row ? JSON.parse(row.body) : {};
    const active = listApplications(jobId).find(application => !application.corrected);
    return {
      followed: false, viewed: false, remindersPaused: false, notInterested: false, preparing: false,
      ...stored,
      applied: Boolean(active),
      activeApplicationId: active?.id ?? null,
      applicationProgress: active ? (active.events.filter(event => ['applied', 'interview', 'ended'].includes(event.type)).at(-1)?.type ?? 'applied') : (stored.preparing ? 'preparing' : 'none'),
      registrationRemindersSuppressed: Boolean(active || stored.remindersPaused || stored.notInterested),
    };
  };
  const saveApplication = application => {
    db.prepare('INSERT INTO applications (id, job_id, body, recorded_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(application.id, application.jobId, JSON.stringify(application), application.recordedAt);
    return getApplication(application.id);
  };
  const requireApplication = id => {
    const application = getApplication(id);
    if (!application) throw new ValidationError('投递记录不存在');
    return application;
  };
  const timestamp = (value, label) => {
    if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(new Date(value).getTime())) throw new ValidationError(`${label}需要含时区的有效时间`);
    return new Date(value).toISOString();
  };
  const text = (value, label) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw new ValidationError(`${label}必须为文本`);
    return value.trim() || null;
  };
  return {
    listPersonalMarkEvents() { return db.prepare('SELECT body FROM personal_mark_events ORDER BY rowid').all().map(row=>JSON.parse(row.body)); },
    getPersonalState,
    getApplication,
    listApplications,
    setPersonalState(jobId, changes) {
      requireJob(jobId);
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ValidationError('个人状态必须为对象');
      const current = getPersonalState(jobId);
      const state = {};
      for (const field of ['followed', 'viewed', 'remindersPaused', 'notInterested', 'preparing']) {
        if (changes[field] != null && typeof changes[field] !== 'boolean') throw new ValidationError('个人状态必须为布尔值');
        state[field] = changes[field] ?? current[field];
      }
      db.exec('SAVEPOINT personal_mark');
      try {
        db.prepare('INSERT INTO personal_states (job_id, body) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET body = excluded.body').run(jobId, JSON.stringify(state));
        recordMarks(jobId,current,state);db.exec('RELEASE personal_mark');
      }catch(error){db.exec('ROLLBACK TO personal_mark; RELEASE personal_mark');throw error;}
      return getPersonalState(jobId);
    },
    updateApplication(id, changes) {
      const application = requireApplication(id);
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ValidationError('投递补充必须为对象');
      const updates = {};
      if (Object.hasOwn(changes, 'appliedAt')) updates.appliedAt = timestamp(changes.appliedAt, '投递时间');
      for (const field of ['notes', 'resumeVersion']) if (Object.hasOwn(changes, field)) updates[field] = text(changes[field], field === 'notes' ? '备注' : '实际简历版本');
      const details = {};
      for (const [field, value] of Object.entries(updates)) if (application[field] !== value) details[field] = { before: application[field], after: value };
      if (!Object.keys(details).length) return application;
      Object.assign(application, updates);
      const recordedAt = now().toISOString();
      application.events.push({ id: randomUUID(), type: 'updated', occurredAt: recordedAt, recordedAt, changes: details, note: '本人补充或纠正投递信息' });
      return saveApplication(application);
    },
    recordApplicationEvent(id, event) {
      const application = requireApplication(id);
      if (!event || !['interview', 'ended'].includes(event.type)) throw new ValidationError('仅记录本人确认的面试或申请结束事件');
      const recordedAt = now().toISOString();
      application.events.push({ id: randomUUID(), type: event.type, occurredAt: event.occurredAt == null || event.occurredAt === '' ? recordedAt : timestamp(event.occurredAt, '事件时间'), recordedAt, note: text(event.note, '事件说明') });
      return saveApplication(application);
    },
    setApplied(jobId, applied) {
      const job = requireJob(jobId);
      if (typeof applied !== 'boolean') throw new ValidationError('已投递必须为布尔值');
      const existing = listApplications(jobId).find(application => !application.corrected);
      if (existing) {
        if (applied) return existing;
        existing.corrected = true;
        const recordedAt = now().toISOString();
        existing.events.push({ id: randomUUID(), type: 'correction', occurredAt: recordedAt, recordedAt, note: '撤销误勾，不代表撤回真实申请' });
        return saveApplication(existing);
      }
      if (!applied) return null;
      const timestamp = now().toISOString();
      return saveApplication({
        id: randomUUID(), jobId, jobSnapshot: job, recordedAt: timestamp, appliedAt: timestamp,
        notes: null, resumeVersion: null, corrected: false,
        events: [{ id: randomUUID(), type: 'applied', occurredAt: timestamp, recordedAt: timestamp, note: null }],
      });
    },
  };
}
