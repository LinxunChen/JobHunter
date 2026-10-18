import {targetScopeKey} from './local-settings.mjs';
import { beginProcessingOwner, endProcessingOwner } from './processing-owner.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { validateExtraction } from './extraction.mjs';
import { readAttachment } from './attachments.mjs';
import {announcementRelevance} from './job-relevance.mjs';
import {targetLocation,jobRelevance} from './job-relevance.mjs';
import {discoveryProcessingDocuments} from './discovery-scope.mjs';
import {processingScope,processingDocuments} from './processing-scope.mjs';
import {officialRoleIdentity} from './processing-handoff.mjs';
import {validRecruitmentUnitEvidence} from './recruitment-unit-evidence.mjs';

export function createAnnouncementOperations({ db, now, buildJob, saveJob, saveDerivedJob, processor, assertEnabled, isAutomatic, recordProcessing, attachmentPython, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS announcement_attachments (announcement_id TEXT NOT NULL, id TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(announcement_id,id))');
  const getAnnouncement = id => {
    const row = db.prepare('SELECT body FROM announcements WHERE id = ?').get(id);
    return row ? JSON.parse(row.body) : null;
  };
  const save = announcement => {
    db.prepare('INSERT INTO announcements (id,body,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(announcement.id, JSON.stringify(announcement), announcement.createdAt);
    recordProcessing?.(announcement);
    return getAnnouncement(announcement.id);
  };
  return {
    getAnnouncement,
    listAnnouncements() { return db.prepare('SELECT body FROM announcements ORDER BY created_at DESC,rowid DESC').all().map(row => JSON.parse(row.body)); },
    recordAnnouncementProcessingObservation(id,{sourceUrl,title,checkedAt,applicationOpen,locations,recruitmentUnitEvidence}) {
      const item=getAnnouncement(id);
      if(!item||item.sourceUrl!==sourceUrl||item.title!==title?.trim()||!Number.isFinite(Date.parse(checkedAt))||Date.parse(checkedAt)>now().getTime()||![true,false,null,undefined].includes(applicationOpen)||locations!=null&&(!Array.isArray(locations)||locations.some(x=>typeof x!=='string')))throw new ValidationError('加工范围观察必须对应同一官方原文与岗位');
      if(recruitmentUnitEvidence&&(!validRecruitmentUnitEvidence(recruitmentUnitEvidence,{title,sourceUrl,checkedAt:recruitmentUnitEvidence.checkedAt})||!Number.isFinite(Date.parse(recruitmentUnitEvidence.checkedAt))||Date.parse(recruitmentUnitEvidence.checkedAt)>now().getTime()))throw new ValidationError('官网招聘单位证据无法对应岗位及原文');
      item.processingObservation={sourceUrl,title,checkedAt,applicationOpen:applicationOpen??null,locations:locations??null,recruitmentUnitEvidence:recruitmentUnitEvidence??null};
      return save(item);
    },
    screenAnnouncementForAutomaticProcessing(id) {
      const item=getAnnouncement(id);if(!item)throw new ValidationError('公告不存在');
      if(['processed','partial','processing','reading_attachments'].includes(item.status))return item;
      const decision=processingScope(item,now());if(!decision)return item;
      item.sourceProcessingDecision=decision;
      if(decision.status!=='eligible'){
        item.status=decision.status==='excluded'?'scope_excluded':'scope_pending';item.processingSkipped=decision.reason;item.error=null;
        item.steps.push({step:'scope_checked',at:now().toISOString(),contentVersion:item.contentVersion,decision:decision.status});
      }
      return save(item);
    },
    recordAnnouncementSourceDecision(id,decision) {
      const announcement=getAnnouncement(id);
      if(!announcement?.sourceIdentityContext||!['excluded','needs_material','eligible'].includes(decision?.status)||typeof decision.reason!=='string')throw new ValidationError('公告来源范围判断无效');
      if(JSON.stringify(announcement.sourceProcessingDecision)===JSON.stringify(decision))return announcement;
      announcement.sourceProcessingDecision={...structuredClone(decision),targetScopeKey:targetScopeKey()};
      if(decision.deadline?.status==='expired')announcement.evidenceUse='historical';
      return save(announcement);
    },
    getAnnouncementAttachment(id, attachmentId) {
      const row = db.prepare('SELECT content FROM announcement_attachments WHERE announcement_id=? AND id=?').get(id, attachmentId);
      return row ? Buffer.from(row.content) : null;
    },
    async retryAnnouncementAttachments(id) {
      const announcement=getAnnouncement(id);
      if(!announcement||!['saved','failed','scope_excluded','scope_pending'].includes(announcement.status)||announcement.jobIds.length)throw new ValidationError('仅重新读取尚未派生岗位的已保存原件；进行中的公告不可重叠');
      const owner=beginProcessingOwner();
      try{
        for(const item of announcement.attachments){
          if(item.status==='read'&&!(item.reader==='macOS Vision OCR'&&!item.imageFrames))continue;
          const row=db.prepare('SELECT content FROM announcement_attachments WHERE announcement_id=? AND id=?').get(id,item.id);
          if(!row)continue;
          const prior={status:item.status,error:item.error??null,reader:item.reader??null};
          try{Object.assign(item,await readAttachment(item,Buffer.from(row.content),attachmentPython));item.status='read';delete item.error;announcement.gaps=announcement.gaps.filter(gap=>!gap.startsWith(item.name+'：'));}
          catch(error){item.status='failed';item.error=error.message;announcement.gaps=announcement.gaps.filter(gap=>!gap.startsWith(item.name+'：'));announcement.gaps.push(item.name+'：'+error.message);}
          item.readHistory=[...(item.readHistory??[]),{at:now().toISOString(),prior,result:item.status}];save(announcement);
        }
        announcement.contentVersion=createHash('sha256').update(announcement.originalText+JSON.stringify(announcement.attachments.map(item=>({id:item.id,hash:item.sha256,status:item.status})))).digest('hex');
        return save(announcement);
      }finally{endProcessingOwner(owner);}
    },
    async createAnnouncement(input) {
      if (!input || typeof input.originalText !== 'string' || !input.originalText.trim() || typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('公告标题及原文不能为空');
      const reference = buildJob({ title: input.title, originalText: input.originalText, sourceUrl: input.sourceUrl, evidenceUse: input.evidenceUse, publishedAt: input.publishedAt });
      if (!Array.isArray(input.attachments ?? []) || (input.attachments ?? []).length > 20) throw new ValidationError('附件必须为不超过20项的列表');
      let totalBytes = 0;
      const attachments = (input.attachments ?? []).map((attachment, index) => {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) || typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 240 || (attachment.mediaType != null && typeof attachment.mediaType !== 'string')) throw new ValidationError('附件名称或类型无效');
        let bytes = null;
        if (attachment.contentBase64 != null) {
          // A repeated four-character group exhausts V8's regexp stack on
          // valid multi-megabyte originals. Validate the alphabet linearly.
          if (typeof attachment.contentBase64 !== 'string' || attachment.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.contentBase64)) throw new ValidationError('附件内容需要有效base64');
          bytes = Buffer.from(attachment.contentBase64, 'base64');
          totalBytes += bytes.length;
          if (totalBytes > 8 * 1024 * 1024) throw new ValidationError('附件总大小超过8MiB');
        }
        return { bytes, item: { id: `attachment-${index + 1}`, name: attachment.name.trim(), mediaType: attachment.mediaType || 'application/octet-stream', status: bytes ? 'pending' : 'missing', text: null, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null } };
      });
      if (input.jobIdentities != null && (!Array.isArray(input.jobIdentities) || input.jobIdentities.some(item => !item || typeof item.title !== 'string' || !item.sourceIdentity))) throw new ValidationError('公告来源身份映射无效');
      if (input.targetJobs != null && (!Array.isArray(input.targetJobs) || input.targetJobs.length !== 1 || input.jobIdentities?.length !== 1 || input.targetJobs.some(item => !item || !['title','recruitmentUnit','department','batch'].every(field => (item[field] ?? null) === (input.jobIdentities[0][field] ?? null))))) throw new ValidationError('选中岗位加工范围必须与唯一来源身份对应');
      let sourceIdentityContext = null;
      if (input.sourceIdentityContext != null) {
        const value = input.sourceIdentityContext;
        let url; try { url = new URL(value.externalId); } catch { throw new ValidationError('公告来源上下文需要公开原文URL'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.sourceId !== 'string' || !value.sourceId.trim() || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || value.externalId !== reference.sourceUrl || typeof value.observedAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || (value.sourceEvidence != null && (typeof value.sourceEvidence !== 'object' || Array.isArray(value.sourceEvidence))) || (value.dateEvidence != null && (!Array.isArray(value.dateEvidence) || value.dateEvidence.some(date => typeof date?.field !== 'string' || typeof date.raw !== 'string' || date.meaning !== 'unverified'))) || input.jobIdentities?.length) throw new ValidationError('公告来源上下文无效或与明确岗位映射冲突');
        sourceIdentityContext = structuredClone(value);
      }
      const id = randomUUID();
      const timestamp = now().toISOString();
      const announcement = { owner: beginProcessingOwner(), id, title: reference.title, originalText: reference.originalText, sourceUrl: reference.sourceUrl, evidenceUse: reference.evidenceUse, publishedAt: reference.publishedAt, createdAt: timestamp, status: 'reading_attachments', attachments: attachments.map(attachment => attachment.item), gaps: [], steps: [{ step: 'original_saved', at: timestamp }], jobIds: [], error: null, jobIdentities: structuredClone(input.jobIdentities ?? []), targetJobs: structuredClone(input.targetJobs ?? []), sourceIdentityContext };
      // Save every original before awaiting any attachment reader; this is a short transaction.
      db.exec('BEGIN IMMEDIATE');
      try {
        save(announcement);
        for (const { item, bytes } of attachments) if (bytes) db.prepare('INSERT INTO announcement_attachments (announcement_id,id,content) VALUES (?,?,?)').run(id, item.id, bytes);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); endProcessingOwner(announcement.owner); throw error; }
      try {
      for (const { item, bytes } of attachments) {
        if (bytes) {
          try { Object.assign(item, await readAttachment(item, bytes, attachmentPython)); item.status = 'read'; }
          catch (error) { item.status = 'failed'; item.error = error.message; }
        }
        if (item.status !== 'read') announcement.gaps.push(`${item.name}：${item.error ?? '附件未取得'}`);
        save(announcement);
      }
      announcement.status = 'saved';
      announcement.contentVersion = createHash('sha256').update(announcement.originalText + JSON.stringify(announcement.attachments.map(item => ({ id: item.id, hash: item.sha256, status: item.status })))).digest('hex');
      announcement.steps.push({ step: 'attachments_checked', at: now().toISOString() });
      return save(announcement);
      } finally { endProcessingOwner(announcement.owner); }
    },
    async processAnnouncement(id, { documentScopes, revalidateSavedOutput = false } = {}) {
      let announcement, startedOwner;
      db.exec('BEGIN IMMEDIATE');
      try {
        announcement = getAnnouncement(id);
        if (!announcement) throw new ValidationError('公告不存在');
        if (announcement.status === 'processed' || announcement.status === 'partial') { db.exec('COMMIT'); return announcement; }
        if (['processing', 'reading_attachments'].includes(announcement.status)) throw new ValidationError('公告正在加工或上次加工中断，请勿重叠运行');
        if (revalidateSavedOutput && (documentScopes != null || announcement.status !== 'failed' || announcement.processingFailure?.stage !== 'validation' || announcement.processingReceipt?.completed !== true || !announcement.rejectedExtraction?.output || announcement.rejectedExtraction.contentVersion !== announcement.contentVersion)) throw new ValidationError('仅可复验同一内容版本、已完成模型调用但校验失败的保存结果');
        const scope=isAutomatic?.()?processingScope(announcement,now()):null;
        if(scope)announcement.sourceProcessingDecision=scope;
        if(scope&&scope.status!=='eligible'){
          announcement.status=scope.status==='excluded'?'scope_excluded':'scope_pending';announcement.processingSkipped=scope.reason;announcement.error=null;
          announcement.steps.push({step:'scope_checked',at:now().toISOString(),contentVersion:announcement.contentVersion,decision:scope.status});
          save(announcement);db.exec('COMMIT');return announcement;
        }
        const relevance=isAutomatic?.()&&!scope?announcementRelevance(announcement):null;
        if(relevance?.status==='out_of_scope'){
          announcement.status='scope_excluded';announcement.processingSkipped=relevance.reason;
          if(!announcement.steps.some(step=>step.step==='direction_skipped'&&step.contentVersion===announcement.contentVersion))announcement.steps.push({step:'direction_skipped',at:now().toISOString(),contentVersion:announcement.contentVersion});
          save(announcement);db.exec('COMMIT');return announcement;
        }
        if (documentScopes != null) {
          if (!Array.isArray(documentScopes) || !documentScopes.length || documentScopes.some(scope => {
            const item = announcement.attachments.find(attachment => attachment.id === scope?.documentId);
            return !item || item.status !== 'read' || !Array.isArray(scope.locators) || !scope.locators.length || new Set(scope.locators).size !== scope.locators.length || scope.locators.some(locator => !item.segments.some(segment => segment.locator === locator));
          }) || new Set(documentScopes.map(scope => scope.documentId)).size !== documentScopes.length) throw new ValidationError('附件加工范围必须引用已读取原件的唯一有效段落');
          announcement.documentScopes = structuredClone(documentScopes);
        }
        announcement.owner = startedOwner = beginProcessingOwner();
        delete announcement.processingSkipped;
        announcement.status = 'processing';
        announcement.error = null;
        if (!revalidateSavedOutput) announcement.processingReceipt = null;
        announcement.processingFailure = null;
        announcement.postprocessError = null;
        announcement.steps.push({ step: revalidateSavedOutput ? 'validation_started' : 'model_started', at: now().toISOString(), contentVersion: announcement.contentVersion });
        save(announcement);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); endProcessingOwner(startedOwner); throw error; }
      const persistedJobIds = [...announcement.jobIds];
      const persistedSteps = [...announcement.steps];
      let failureStage = revalidateSavedOutput ? 'validation' : 'model';
      let extractionResult;
      try {
        if (!processor && !revalidateSavedOutput) throw new Error('Codex加工尚未配置');
        const originals = [{ id: 'announcement', name: announcement.title, text: announcement.originalText, segments: [{ locator: '正文', text: announcement.originalText }] }, ...announcement.attachments.filter(item => item.status === 'read').map(item => { const scope = announcement.documentScopes?.find(scope => scope.documentId === item.id); const segments = scope ? item.segments.filter(segment => scope.locators.includes(segment.locator)) : item.segments; return { id: item.id, name: item.name, text: scope ? segments.map(segment => segment.text).join('\n') : item.text, segments }; })];
        const selectedTitles=announcement.sourceProcessingDecision?.status==='eligible'?announcement.sourceProcessingDecision.selectedTitles:null;
        const documents=processingDocuments(selectedTitles?.length?discoveryProcessingDocuments(originals,selectedTitles):originals,announcement.sourceProcessingDecision);
        assertEnabled?.(announcement);
        const result = revalidateSavedOutput ? {output: structuredClone(announcement.rejectedExtraction.output), receipt: announcement.processingReceipt} : await processor.process({ documents, inputGaps: announcement.gaps, ...(announcement.targetJobs?.length ? { targetJobs: announcement.targetJobs } : {}),...(selectedTitles?.length?{selectedJobTitles:selectedTitles}:{}) });
        extractionResult = result.output ?? result;
        assertEnabled?.(announcement);
        announcement.processingReceipt = result.receipt ?? { verification: 'external processor result; not evidence of real Codex' };
        failureStage = 'validation';
        let output = validateExtraction(result.output ?? result, documents);
        // Scope validation uses exactly what the model saw; final evidence
        // offsets refer to the retained full originals, not the shortened view.
        if(selectedTitles?.length||announcement.sourceProcessingDecision?.selectedDutySections?.length)output=validateExtraction(result.output??result,originals);
        const unitProof=announcement.processingObservation?.recruitmentUnitEvidence;
        if(unitProof&&output.jobs.length===1&&output.jobs[0].title===announcement.title&&officialRoleIdentity(announcement.sourceIdentityContext)){
          const item=output.jobs[0];
          if(item.recruitmentUnit&&![unitProof.value,...unitProof.aliases].includes(item.recruitmentUnit))throw new Error('模型招聘单位与已核验官网证据冲突；拒绝保存岗位');
          const document=documents.find(x=>x.id==='announcement'),quote='招聘单位：'+unitProof.value,start=document?.text.indexOf(quote)??-1;
          if(start<0)throw new Error('官网招聘单位补齐缺少本次加工原文引用');
          item.recruitmentUnit=unitProof.value;
          item.evidence.push({documentId:'announcement',locator:'正文',quote,start,end:start+quote.length});
          item.unknownFields=item.unknownFields.filter(x=>!/^(?:recruitmentUnit|招聘单位|招聘主体)(?:(?:未披露|未知|未明确)|[:：](?:原文)?(?:未披露|未明确披露)(?:岗位)?(?:招聘单位|招聘主体)?[。.]?)?$/.test(x));
        }
        if(selectedTitles?.length&&output.jobs.some(job=>!selectedTitles.includes(job.title)||targetLocation({location:{options:job.locations}}).status!=='included'||jobRelevance(job).status!=='relevant'))throw new Error('加工结果超出选中目标岗位范围；拒绝保存岗位');
        if(selectedTitles?.some(title=>!output.jobs.some(job=>job.title===title)))throw new Error('加工结果漏掉已选中的北京技术岗位；保留原件，拒绝部分保存');
        if (announcement.targetJobs?.length && (output.jobs.length !== 1 || !['title','recruitmentUnit','department','batch'].every(field => (output.jobs[0][field] ?? null) === (announcement.targetJobs[0][field] ?? null)))) throw new Error('加工结果超出选中岗位来源范围；拒绝保存岗位');
        announcement.extraction = output;
        if (revalidateSavedOutput) announcement.savedOutputRevalidations = [...(announcement.savedOutputRevalidations ?? []), {...announcement.rejectedExtraction, revalidatedAt: now().toISOString(), kind: 'saved_output_revalidation', newModelCall: false}];
        delete announcement.rejectedExtraction;
        failureStage = 'job_build';
        const candidates = output.jobs.map(item => {
          const path = item.applicationPath;
          if (path && ['steps', 'direct'].includes(path.kind) && /^www\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>]*)?$/i.test(path.url ?? '') && path.steps?.includes(path.url)) {
            return { ...item, applicationPath: { ...path, kind: 'announcement', url: null }, applicationPathRawUrl: path.url, unknownFields: [...item.unknownFields, `原文投递网址未披露协议：${path.url}；保留原始步骤，完整可点链接待核验，不补造http/https`] };
          }
          return item;
        });
        const jobs = candidates.map(item => buildJob({ title: item.title, originalText: documents.map(document => `${document.id} (${document.name})\n${document.text}`).join('\n\n'), recruitmentUnit: item.recruitmentUnit, contractingEntity: item.contractingEntity, department: item.department, batch: item.batch, location: { options: item.locations }, applicationPath: item.applicationPath, sourceUrl: announcement.sourceUrl, evidenceUse: announcement.evidenceUse, publishedAt: announcement.publishedAt, knownConditions: [...output.commonConditions, ...item.conditions].map(condition => condition.text), unknownFields: [...announcement.gaps, ...output.inputGaps, ...item.unknownFields] }, { announcementId: id, sourceContentVersion: announcement.contentVersion, processingVersion: 'announcement-extract-v1', duties: item.duties, conditions: [...output.commonConditions.map(condition => ({ ...condition, scope: 'common' })), ...item.conditions.map(condition => ({ ...condition, scope: 'job' }))], evidence: item.evidence, dateEvidence: item.dateEvidence ?? [], applicationPathRawUrl: item.applicationPathRawUrl ?? null }));
        const identities = jobs.map(job => {
          if (announcement.sourceIdentityContext) {
            const context = announcement.sourceIdentityContext;
            const native=jobs.length===1&&job.title===announcement.title?officialRoleIdentity(context):null;
            if(native)return {sourceIdentity:native,observedAt:context.observedAt,sourceEvidence:{...context.sourceEvidence,identityKind:'official_role_url'},dateEvidence:job.dateEvidence??[]};
            const same = jobs.filter(item => ['title', 'recruitmentUnit', 'department', 'batch'].every(field => (item[field] ?? null) === (job[field] ?? null)));
            if (!job.recruitmentUnit || same.length !== 1) { const gap = `${job.title}：公告候选身份歧义或招聘单位未知，保留独立岗位，不自动关联`; announcement.gaps.push(gap); job.unknownFields.push(gap); return null; }
            return { sourceIdentity: { sourceId: context.sourceId, externalId: context.externalId + '#' + encodeURIComponent(job.title) }, observedAt: context.observedAt, sourceEvidence: { ...context.sourceEvidence, ...(job.applicationPathRawUrl ? { applicationPathRawUrl: job.applicationPathRawUrl } : {}), identityKind: 'synthetic_article_title', identityNote: '公告URL与提取岗位标题构成合成局部标识，不是官方岗位编号；单位、部门、批次仍严格区分' }, dateEvidence: [...(context.dateEvidence ?? []), ...(job.dateEvidence ?? [])] };
          }
          if (!announcement.jobIdentities.length) return null;
          const matches = announcement.jobIdentities.filter(identity => ['title', 'recruitmentUnit', 'department', 'batch'].every(field => (identity[field] ?? null) === (job[field] ?? null)));
          if (matches.length === 1) return matches[0];
          announcement.gaps.push(`${job.title}：来源身份映射无法唯一对应，暂保留独立岗位`);
          return null;
        });
        announcement.gaps = [...new Set([...announcement.gaps, ...output.inputGaps, ...(jobs.length ? [] : ['未识别到可采用的具体岗位，请核对原文及加工结果'])])];
        announcement.status = announcement.gaps.length ? 'partial' : 'processed';
        announcement.steps.push({ step: 'jobs_saved', at: now().toISOString() });
        failureStage = 'save';
        db.exec('BEGIN IMMEDIATE');
        try {
          const savedJobs = jobs.map((job, index) => saveDerivedJob ? saveDerivedJob(job, identities[index]) : (saveJob(job), job));
          announcement.jobIds = savedJobs.map(job => job.id);
          save(announcement); db.exec('COMMIT');
        }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      } catch (error) {
        announcement.status = 'failed';
        announcement.jobIds = persistedJobIds;
        announcement.steps = persistedSteps;
        announcement.error = error.message;
        if(['batch_deferred','budget_deferred'].includes(error.receipt?.failureCategory))announcement.status='deferred';
        announcement.processingFailure = { stage: failureStage, error: error.message };
        announcement.postprocessError = failureStage === 'model' ? null : { stage: failureStage, error: error.message };
        if (failureStage === 'validation' && extractionResult) announcement.rejectedExtraction = { contentVersion: announcement.contentVersion, at: now().toISOString(), output: extractionResult, error: error.message };
        announcement.processingReceipt = error.receipt ?? announcement.processingReceipt ?? { completed: false, processingVersion: 'announcement-extract-v1' };
        announcement.steps.push({ step: 'model_failed', at: now().toISOString(), phase: failureStage, reason: error.message });
        save(announcement);
      } finally { endProcessingOwner(announcement.owner); }
      return getAnnouncement(id);
    },
  };
}
