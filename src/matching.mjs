import {currentLocalSettings,matchingScopeKey,matchesMatchingScope} from './local-settings.mjs';
import { beginProcessingOwner, endProcessingOwner } from './processing-owner.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { validateMatching } from './matching-validation.mjs';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const jobHash = job => hash({ originalText: job.originalText, duties: job.duties, conditions: job.conditions, knownConditions: job.knownConditions, location: job.location });
export const sanitizeCareerText = text => text.replace(/\[*\[联系方式省略\]\]*/g, '\u0000CONTACT\u0000').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '\u0000CONTACT\u0000').replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, '\u0000CONTACT\u0000').replace(/(?:联系方式|手机号|电子邮箱|详细地址|家庭住址)[^\n]*/g, '\u0000CONTACT\u0000').replace(/\u0000CONTACT\u0000/g, '[联系方式省略]');

export function createMatchingOperations({ db, getJob, eligibility, now, processor, assertEnabled, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS career_profiles (id TEXT PRIMARY KEY, body TEXT NOT NULL, saved_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS matching_results (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL, recorded_at TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS matching_by_job_time ON matching_results(job_id,recorded_at DESC)');
  const requireJob = id => { const job = getJob(id); if (!job) throw new ValidationError('岗位不存在'); return job; };
  const getCareerProfile = id => { const row = db.prepare('SELECT body FROM career_profiles WHERE id = ?').get(id); return row ? JSON.parse(row.body) : null; };
  const profiles = (limit=-1) => db.prepare('SELECT body FROM career_profiles ORDER BY saved_at DESC,rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(row.body));
  const scopeStale=item=>!matchesMatchingScope(item.targetScopeKey);
  const listMatches = (jobId,limit=-1) => {
    const job = requireJob(jobId);
    return db.prepare('SELECT body FROM matching_results WHERE job_id = ? ORDER BY recorded_at DESC,rowid DESC LIMIT ?').all(jobId,limit).map(row => { const item = JSON.parse(row.body); return { ...item, stale: item.jobHash !== jobHash(job)||scopeStale(item), profileStale: profiles(1)[0]?.hash !== item.profileHash }; });
  };
  const getMatch = jobId => {
    const all = listMatches(jobId,1);
    const latest = all[0];
    if (!latest) return null;
    const currentQualification = eligibility.getEligibility(jobId);
    const priorId=latest.status==='completed'?null:db.prepare("SELECT id FROM history_records WHERE kind='matching_results' AND subject_id=? AND status='completed' ORDER BY ordinal DESC LIMIT 1").get(jobId)?.id;
    const prior=priorId?JSON.parse(db.prepare('SELECT body FROM matching_results WHERE id=?').get(priorId).body):null;
    const previousResult=prior?{...prior,stale:prior.jobHash!==jobHash(requireJob(jobId))||scopeStale(prior),profileStale:profiles(1)[0]?.hash!==prior.profileHash}:null;
    return { ...latest, currentQualification, qualificationAllowsAction: latest.status === 'completed' && !latest.stale && !latest.profileStale && currentQualification?.status === 'verified' && !currentQualification.stale && (currentQualification.profileSource?.kind === 'qualification' || currentQualification.profileVersion === latest.profileVersion), previousResult };
  };
  const save = result => { db.prepare('INSERT INTO matching_results (id,job_id,body,recorded_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(result.id, result.jobId, JSON.stringify(result), result.recordedAt); return getMatch(result.jobId); };
  return {
    getCareerProfile,
    getQualificationProfileContext(profile, savedSource = null, careerProfileId = null) {
      const all = profiles();
      const matchesFacts = item => item.version === profile.version && item.qualificationFacts &&
        Object.keys(item.qualificationFacts).every(key => JSON.stringify(item.qualificationFacts[key]) === JSON.stringify(profile[key])) &&
        Object.keys(profile).filter(key => !['version','source'].includes(key)).every(key => Object.hasOwn(item.qualificationFacts, key));
      const candidates = all.filter(matchesFacts);
      const ambiguous = !savedSource && !careerProfileId && !profile.source && new Set(candidates.map(item => item.sourceId)).size > 1;
      const linked = savedSource?.kind === 'career' ? all.find(item => item.id === savedSource.careerProfileId) :
        careerProfileId ? all.find(item => item.id === careerProfileId && matchesFacts(item)) :
        savedSource?.kind === 'manual' || profile.source || ambiguous ? null : candidates[0];
      if (careerProfileId && !linked) throw new ValidationError('资格事实及版本必须与指定职业档案一致');
      const profileSource = savedSource ?? (ambiguous ? {kind:'unresolved',version:profile.version} : linked ? {kind:'career',careerProfileId:linked.id,sourceId:linked.sourceId,version:linked.version} : {kind:'manual',source:profile.source ?? 'manual',version:profile.version});
      // A text-only refresh supplies no replacement qualification facts.
      const current = linked && all.find(item => item.qualificationFacts);
      return {profileSource, profileStale: profileSource.kind === 'unresolved' || profileSource.kind === 'career' && (!linked || current?.id !== linked.id)};
    },
    listCareerProfiles() { return profiles().map(({ text, qualificationFacts, ...metadata }) => metadata); },
    saveCareerProfile(input) {
      if (!input || typeof input.text !== 'string' || !input.text.trim() || typeof input.version !== 'string' || !input.version.trim()) throw new ValidationError('职业资料正文及明确版本不能为空');
      if (!['manual',currentLocalSettings().careerDocumentId].filter(Boolean).includes(input.sourceId)) throw new ValidationError('职业资料只允许手动档案或已授权的指定职业概览');
      const text = sanitizeCareerText(input.text.trim());
      const digest = hash({ text, qualificationFacts: input.qualificationFacts ?? null, sourceId: input.sourceId });
      const existing = profiles().find(item => item.hash === digest && item.version === input.version);
      if (existing) return existing;
      const profile = { id: randomUUID(), version: input.version, hash: digest, text, qualificationFacts: input.qualificationFacts ?? null, sourceId: input.sourceId, readAt: input.readAt ?? now().toISOString(), sourceWindow: input.sourceWindow ?? null, savedAt: now().toISOString() };
      db.prepare('INSERT INTO career_profiles (id,body,saved_at) VALUES (?,?,?)').run(profile.id, JSON.stringify(profile), profile.savedAt);
      return getCareerProfile(profile.id);
    },
    listMatches,
    getMatch,
    async matchJob(jobId, { profileId, revalidateSavedOutput = false } = {}) {
      const job = requireJob(jobId);
      assertEnabled?.(jobId);
      const profile = profileId ? getCareerProfile(profileId) : profiles(1)[0];
      if (!profile) throw new ValidationError('尚未保存明确版本的职业资料');
      const previous=revalidateSavedOutput?listMatches(jobId)[0]:null;
      if(revalidateSavedOutput&&(!previous?.rejectedMatching?.output||previous.status!=='failed'||previous.failureStage!=='validation'||previous.receipt?.completed!==true||previous.receipt.model!=='gpt-6.1-sol'||previous.jobHash!==jobHash(job)||previous.jobVersion!==(job.sourceContentVersion??jobHash(job))||previous.profileHash!==profile.hash||previous.profileVersion!==profile.version||!matchesMatchingScope(previous.targetScopeKey)||previous.matchVersion!=='career-match-v2'))throw new ValidationError('仅可复验同一岗位和职业资料版本、相同目标且已完成模型调用的保存匹配输出');
      const result = { owner: beginProcessingOwner(), id: randomUUID(), jobId, profileId: profile.id, profileVersion: profile.version, profileHash: profile.hash, jobSnapshot: job, jobHash: jobHash(job), jobVersion: job.sourceContentVersion ?? jobHash(job), matchVersion: 'career-match-v2', targetScopeKey:matchingScopeKey(), recordedAt: now().toISOString(), status: 'processing', output: null, receipt: null, gaps: [], qualificationAllowsAction: false, qualification: eligibility.getEligibility(jobId), stale: false };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (listMatches(jobId).some(item => item.status === 'processing')) throw new ValidationError('该岗位正在匹配，不能重复启动；中断状态需先恢复');
        save(result); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); endProcessingOwner(result.owner); throw error; }
      let rawOutput,failureStage='model';
      try {
        if (!processor&&!revalidateSavedOutput) throw new Error('Codex匹配入口未配置');
        assertEnabled?.(jobId);
        const processed = revalidateSavedOutput?{output:previous.rejectedMatching.output,receipt:previous.receipt}:await processor.match({ job, profile });
        assertEnabled?.(jobId);
        result.receipt = processed.receipt ?? { model: 'gpt-6.1-sol', simulated: true };
        rawOutput=structuredClone(processed.output??processed);failureStage='validation';
        if(revalidateSavedOutput)result.revalidation={matchId:previous.id,newModelCall:false};
        result.output = validateMatching(rawOutput, { job, profile });
        if (result.receipt.model !== 'gpt-6.1-sol') throw new Error('匹配只允许Codex GPT，不采用其他模型结果');
        result.status = 'completed';
        result.qualification = eligibility.getEligibility(jobId);
        result.qualificationAllowsAction = result.qualification?.status === 'verified' && !result.qualification.stale && (result.qualification.profileSource?.kind === 'qualification' || result.qualification.profileVersion === profile.version);
        return save(result);
      } catch (error) {
        result.failureStage=failureStage;
        if(failureStage==='validation'&&rawOutput&&result.receipt?.completed===true&&result.receipt.model==='gpt-6.1-sol')result.rejectedMatching={output:rawOutput,jobHash:result.jobHash,profileHash:result.profileHash,error:error.message};
        if(error.validationEvidence)result.validationFailure=error.validationEvidence;
        result.status = ['batch_deferred','budget_deferred'].includes(error.receipt?.failureCategory)?'deferred':'failed'; result.output = null;
        result.gaps = [error.message || 'Codex匹配失败'];
        result.receipt = error.receipt ?? result.receipt ?? { model: 'gpt-6.1-sol', completed: false };
        return save(result);
      } finally { endProcessingOwner(result.owner); }
    },
  };
}
