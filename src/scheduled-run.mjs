import {updateNecessaryJobs,pendingAutomaticMatches} from './necessary-jobs.mjs';
import { beijingDay as day } from './beijing-time.mjs';
import { sourceCapabilities } from './source-capabilities.mjs';
import { beginProcessingOwner, endProcessingOwner, processingOwnerAlive } from './processing-owner.mjs';
import { randomUUID } from 'node:crypto';
import {runCheckpoint,stepResult} from './run-checkpoint.mjs';

export function createScheduledRunOperations({ db, application, now, verificationMode, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS scheduled_lock (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS scheduled_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS run_checkpoints(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const parse = row => row ? JSON.parse(row.body) : null;
  const stamp = () => now().toISOString();
  const runs = (options={}) => application.listRunSummaries(options);
  const save = run => {
    const value=runCheckpoint(run),body=JSON.stringify(value);
    db.exec('SAVEPOINT run_checkpoint');
    try {
      // Old snapshots are immutable; resumed state lives beside them under the same run ID.
      if(value.legacySnapshot)db.prepare('INSERT OR IGNORE INTO scheduled_runs VALUES(?,?)').run(value.id,body);
      else db.prepare('INSERT INTO scheduled_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,body);
      db.prepare('INSERT INTO run_checkpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,body);db.exec('RELEASE run_checkpoint');
    }catch(error){db.exec('ROLLBACK TO run_checkpoint; RELEASE run_checkpoint');throw error;}
    return value;
  };
  const notifications = async ({ allowDrafts }) => {
    const recovery = application.recoverNotificationAttempts(), results = [];
    const capability = application.getNotificationStatus();
    for (const delivery of application.listNotificationWork()) {
      if (capability.queryEnabled && ['accepted', 'unknown'].includes(delivery.status) && delivery.shortCode) results.push({ id: delivery.id, kind: 'query', result: await application.queryNotificationResult(delivery.id) });
      if (capability.sendEnabled && delivery.status === 'retry_wait' && day(delivery.createdAt) === day(stamp())) results.push({ id: delivery.id, kind: 'retry', result: await application.sendNotification(delivery.id) });
    }
    // Verification drafts require an explicit human action; daily work never sends them.
    if (allowDrafts && capability.sendEnabled) {
      const content = application.prepareDailyActionsIfNeeded();
      for (const draft of [content.dailyDigest, content.importantDraft].filter(Boolean)) results.push({ id: draft.id, kind: 'send', result: await application.sendNotification(draft.id) });
    }
    return { recovery, results, capability: application.getNotificationStatus() };
  };
  return {
    listScheduledRuns: runs,
    getScheduledRun: id => application.getRunCheckpoint(id),
    getScheduledStatus() { const lock = parse(db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle')); return { latest: runs({limit:1})[0] ?? null, lock: lock ? { runId: lock.runId, active: processingOwnerAlive(lock.owner), needsManualReview: processingOwnerAlive(lock.owner) === null } : null, notification: application.getNotificationStatus(), schedule: '北京时间每日09:00，离线恢复只补当前；职业资料满7日检查，例行备份周日／离线恢复补执行', sourceContracts: application.getSourcesOverview({historyLimit:1}).sources.filter(x => x.implemented).map(x => ({ sourceId: x.id, method: typeof application[sourceCapabilities[x.id]?.method] === 'function' ? sourceCapabilities[x.id]?.method : null })) }; },
    async runScheduledCycle({ trigger = 'scheduled' } = {}) {
      if (verificationMode) throw new ValidationError('恢复核对模式不运行检查或发送');
      if (!['scheduled', 'manual'].includes(trigger)) throw new ValidationError('运行触发方式无效');
      if(application.hasFutureRun(stamp()))return {status:'historical',gaps:['过时调度时刻不回退已保存的当前事实，不生成旧周期或摘要']};
      const date = day(stamp()), scheduledFor = date + 'T01:00:00.000Z';
      const lock = parse(db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle'));
      if (lock && processingOwnerAlive(lock.owner) !== false) return { status: 'busy', runId: lock.runId };
      const owner = beginProcessingOwner();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = parse(db.prepare('SELECT body FROM scheduled_lock WHERE id=?').get('cycle'));
        if (current && processingOwnerAlive(current.owner) !== false) { db.exec('ROLLBACK'); endProcessingOwner(owner); return { status: 'busy', runId: current.runId }; }
        db.prepare('INSERT INTO scheduled_lock VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run('cycle', JSON.stringify({ owner, runId: null }));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); endProcessingOwner(owner); throw error; }
      let run;
      try {
        const recovery = application.recoverProcessingOperations();
        for (const old of application.listActiveOperationIds('scheduled_runs',['running']).map(id=>application.getRunCheckpoint(id)).filter(x => x.date !== date && processingOwnerAlive(x.owner) === false)) save({ ...old, status: 'interrupted', finishedAt: stamp(), gaps: [...old.gaps, '跨日中断记录保留，旧步骤及摘要不回放；补查当前状态'] });
        const latestToday = runs({fromDate:date,toDate:date,limit:1})[0];
        const retryDue = latestToday?.status === 'partial' && (latestToday.cycleAttempts ?? 1) < 2 && Date.parse(stamp()) >= Date.parse(latestToday.retryAt);
        const completedToday = latestToday && ['completed', 'partial'].includes(latestToday.status) && !retryDue;
        if (trigger === 'scheduled' && (stamp() < scheduledFor || completedToday)) {
          const nextCheckAt = completedToday ? latestToday.retryAt ?? new Date(Date.parse(scheduledFor) + 86400000).toISOString() : scheduledFor;
          return { status: 'not_due', nextCheckAt, recovery, notifications: await notifications({ allowDrafts: stamp() >= scheduledFor }) };
        }
        application.recordOperationalChanges();
        const prior = retryDue ? latestToday : application.listActiveOperationIds('scheduled_runs',['running']).map(id=>application.getRunCheckpoint(id)).find(x=>x.date===date);
        run = prior ? { ...prior, owner, resumedAt: stamp(), resumeCount: (prior.resumeCount ?? 0) + 1 } : { owner, id: randomUUID(), date, scheduledFor, trigger, status: 'running', startedAt: stamp(), steps: [], sources: [], gaps: [] };
        run.status = 'running';run.cycleAttempts = prior?.status === 'running' ? (prior.cycleAttempts ?? 1) : (prior?.cycleAttempts ?? 0) + 1;
        run.recovery = recovery;
        db.prepare('UPDATE scheduled_lock SET body=? WHERE id=?').run(JSON.stringify({ owner, runId: run.id }), 'cycle'); save(run);
        const step = async (key, fn) => {
          const previous = run.steps.find(x => x.key === key);
          // Sources can produce new jobs during a resumed cycle after an earlier
          // empty matching step completed. Its checkpoint is not a queue snapshot.
          const matchingDue=key==='jobs'&&pendingAutomaticMatches(application).length>0;
          if (previous?.status === 'completed' && !matchingDue && !(retryDue && ['failed','partial','unavailable','pending'].includes(previous.result?.status))) return previous.result;
          const entry = { key, status: 'started', startedAt: stamp(), attempts: (previous?.attempts ?? 0) + 1, history: [...(previous?.history ?? []), ...(previous ? [{startedAt:previous.startedAt,finishedAt:previous.finishedAt??null,status:previous.status,result:previous.result??null}] : [])] };
          run.steps = run.steps.filter(x => x.key !== key); run.steps.push(entry); save(run);
          let result;
          try { result = await fn(); }
          catch { result = { status: 'failed', gaps: ['步骤未完成，原文及历史结果保留；具体失败原因需检查该步骤记录'] }; }
          result=stepResult(result);Object.assign(entry, { status: 'completed', finishedAt: stamp(), result }); save(run); return result;
        };
        const career = await step('career', () => application.refreshCareerProfile({ trigger: 'weekly' }));
        for (const item of application.getSourcesOverview({historyLimit:1}).sources.filter(x => x.implemented)) {
          const method = sourceCapabilities[item.id]?.method;
          const result = await step('source:' + item.id, () => typeof application[method] === 'function' ? application.withSourceCheckOwner(owner,()=>application.runSourceCheck(item.id,{ trigger, scheduledFor })) : { status: 'unavailable', gaps: ['当前来源没有已集成的计划检查入口，不能计作检查成功'] });
          run.sources = run.sources.filter(x => x.sourceId !== item.id);
          run.sources.push({ name:item.name,sourceId: item.id, status: result?.status ?? 'unavailable', checkId: result?.id ?? null, gaps: result?.gaps ?? [], error: result?.error ?? null }); save(run);
        }
        run.jobs = await step('jobs', async () => {
          return updateNecessaryJobs(application);
        });
        run.today = application.prepareDailyActions(); run.coverage = application.getSourcesOverview();
        run.notifications = await step('notifications', () => notifications({ allowDrafts: true }));
        const backup = await step('backup', () => application.createBackup({ trigger: 'scheduled' }));
        run.status = run.sources.some(x => !['success','paused','unsupported_type'].includes(x.status)) || ['failed', 'partial'].includes(career.status) || run.jobs.status !== 'completed' || backup.status === 'failed' ? 'partial' : 'completed';
        run.finishedAt = stamp();run.retryAt = run.status === 'partial' && run.cycleAttempts < 2 ? new Date(Date.parse(stamp())+900000).toISOString() : null; return save(run);
      } catch (error) {
        if (run) save({ ...run, status: 'failed', finishedAt: stamp(), gaps: [...run.gaps, '周期未完成，保留步骤和个人记录；等待当前补查'] });
        throw error;
      } finally { try { if(run)application.recordOperationalChanges(); } finally { db.prepare('DELETE FROM scheduled_lock WHERE id=?').run('cycle'); endProcessingOwner(owner); } }
    },
  };
}
