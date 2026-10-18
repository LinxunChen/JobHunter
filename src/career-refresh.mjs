import {beginProcessingOwner,endProcessingOwner} from './processing-owner.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { sanitizeCareerText } from './matching.mjs';
import {jobRelevance,targetLocation} from './job-relevance.mjs';
const materialText = text => sanitizeCareerText(text).replace(/^\s*\{:[^\n]*\}\s*$/gm, '').split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');
const digest = text => createHash('sha256').update(materialText(text)).digest('hex');

export function createCareerRefreshOperations({ db, matching, qualificationProfiles, listJobs, isJobMonitoringEnabled, shouldMatchJob, now, source, getSettings, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS career_refreshes (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const listCareerRefreshes = (limit=-1) => db.prepare('SELECT body FROM career_refreshes ORDER BY rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(row.body));
  const save = record => { db.prepare('INSERT INTO career_refreshes (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id, JSON.stringify(record)); return record; };
  return {
    listCareerRefreshes,
    getCareerRefresh() { return listCareerRefreshes(1)[0] ?? null; },
    async refreshCareerProfile(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('职业资料检查输入必须为对象');
      const { trigger = 'manual' } = input;
      const careerSourceId=getSettings().careerDocumentId;
      if (!['manual', 'weekly'].includes(trigger)) throw new ValidationError('职业资料仅支持手动或周检查');
      if(!careerSourceId)return {status:'disabled',sourceId:null,gaps:[],recomputed:[]};
      const lastSuccess = listCareerRefreshes().find(item => item.sourceId===careerSourceId&&['completed', 'partial'].includes(item.status));
      if (trigger === 'weekly' && lastSuccess && now().getTime() < Date.parse(lastSuccess.checkedAt) + 7 * 86400000) return { status: 'not_due', sourceId: careerSourceId, nextCheckAt: new Date(Date.parse(lastSuccess.checkedAt) + 7 * 86400000).toISOString() };
      const record = { owner:beginProcessingOwner(), id: randomUUID(), sourceId: careerSourceId, trigger, checkedAt: now().toISOString(), status: 'processing', change: null, profileId: null, profileVersion: null, recomputed: [], gaps: [], windows: [] };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (listCareerRefreshes().some(item => item.status === 'processing')) throw new ValidationError('职业资料正在检查，不能重叠启动；中断状态需先恢复');
        save(record); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); endProcessingOwner(record.owner); throw error; }
      try {
        if (!source) throw new Error('指定本地职业概览读取入口不可用');
        const snapshot = await source.readCareerOverview();
        if (snapshot.id !== careerSourceId || !snapshot.complete || typeof snapshot.text !== 'string' || !snapshot.text.trim()) throw new Error('指定职业概览未完整读取，不采用部分或其他文档');
        record.windows = snapshot.windows ?? [];
        const currentMeta = matching.listCareerProfiles().find(profile => profile.sourceId === careerSourceId);
        const current = currentMeta ? matching.getCareerProfile(currentMeta.id) : null;
        const materialHash = digest(snapshot.text);
        let profile = current;
        if (!current || digest(current.text) !== materialHash) {
          profile = matching.saveCareerProfile({ text: snapshot.text, sourceId: careerSourceId, version: `career-${materialHash.slice(0, 16)}`, readAt: record.checkedAt, sourceWindow: record.windows });
          record.change = current ? 'material' : 'initial';
        } else record.change = 'unchanged';
        record.profileId = profile.id; record.profileVersion = profile.version; record.materialHash = materialHash;
        for (const job of listJobs()) {
          if(job.evidenceUse==='historical'||jobRelevance(job).status!=='relevant'||targetLocation(job).status==='excluded')continue;
          if(isJobMonitoringEnabled&&!isJobMonitoringEnabled(job.id))continue;
          const latest = matching.getMatch(job.id);
          const priorAttempt = listCareerRefreshes().flatMap(item => item.recomputed).find(item => item.jobId === job.id);
          const retryDeferred = priorAttempt?.status === 'deferred' && latest?.profileId === priorAttempt.fromProfileId;
          if (!latest || (record.change === 'unchanged' && !(latest.profileId === profile.id && latest.status === 'failed') && !retryDeferred)) continue;
          if(shouldMatchJob&&!shouldMatchJob(job))continue;
          try {
            const result = await matching.matchJob(job.id, { profileId: profile.id });
            record.recomputed.push({ jobId: job.id, matchId: result.id, status: result.status, fromProfileId: latest.profileId });
          } catch { record.recomputed.push({ jobId: job.id, matchId: null, status: 'deferred', fromProfileId: latest.profileId }); }
        }
        record.status = record.recomputed.some(item => item.status !== 'completed') ? 'partial' : 'completed';
        if (record.status === 'partial') record.gaps.push('职业资料已保存，部分岗位匹配未完成；原文及历史结果保留');
        return save(record);
      } catch {
        record.status = 'failed'; record.gaps = ['指定本地职业概览检查失败或未完整取得，旧档案和匹配结果保留'];
        return save(record);
      } finally { endProcessingOwner(record.owner); }
    },
  };
}
