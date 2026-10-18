import { randomUUID, createHash } from 'node:crypto';

const ruleVersion = 'eligibility-v3';
const educationRanks = { '大专': 1, '本科': 2, '硕士': 3, '博士': 4 };
const evidenceHash = job => createHash('sha256').update(JSON.stringify({ originalText: job.originalText, conditions: job.conditions, knownConditions: job.knownConditions, location: job.location, unknownFields: job.unknownFields })).digest('hex');

const calendarDate = (year, month, day) => {
  const text = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(text + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
};
const birthdayDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? calendarDate(...value.split('-').map(Number)) : null;
function ageCheck(clause, job, profile) {
  const birthday = birthdayDate(profile.birthday);
  if (!birthday) return { status: 'pending', reason: '明确年龄要求需要个人生日（YYYY-MM-DD）', gaps: ['个人生日'] };
  if (/原则|放宽|优秀|例外|以下|或/.test(clause)) return { status: 'pending', reason: '原则、例外、替代或含义不明的年龄条款需确认，不自动豁免或排除' };
  const interval = clause.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:至|到)(\d{4})年(\d{1,2})月(\d{1,2})日出生/);
  if (interval) {
    const minimumBirthDate = calendarDate(...interval.slice(1, 4).map(Number));
    const maximumBirthDate = calendarDate(...interval.slice(4, 7).map(Number));
    if (!minimumBirthDate || !maximumBirthDate || minimumBirthDate > maximumBirthDate) return { status: 'pending', reason: '出生日期范围无效或矛盾，需核对原文' };
    return { status: birthday >= minimumBirthDate && birthday <= maximumBirthDate ? 'verified' : 'ineligible', reason: `生日${birthday}与明确出生范围${minimumBirthDate}至${maximumBirthDate}比较`, facts: { birthday, minimumBirthDate, maximumBirthDate } };
  }
  const range = clause.match(/(\d{4})年(\d{1,2})月(\d{1,2})日及以后出生/);
  if (range) {
    const minimumBirthDate = calendarDate(...range.slice(1).map(Number));
    if (!minimumBirthDate) return { status: 'pending', reason: '出生范围日期无效，需核对原文' };
    return { status: birthday >= minimumBirthDate ? 'verified' : 'ineligible', reason: `生日${birthday}与明确出生范围${minimumBirthDate}及以后比较`, facts: { birthday, minimumBirthDate } };
  }
  const max = clause.match(/不超过(\d+)周岁/);
  const references = [...clause.matchAll(/截至(\d{4})年(\d{1,2})月(\d{1,2})日/g)];
  if (!references.length) references.push(...job.originalText.matchAll(/截至(\d{4})年(\d{1,2})月(\d{1,2})日/g));
  const dates = [...new Set(references.map(match => calendarDate(...match.slice(1).map(Number))))];
  if (!max || dates.length !== 1 || !dates[0]) return { status: 'pending', reason: '年龄界限或公告明确基准日缺失／歧义，不使用当前年龄代替', gaps: ['公告年龄界限／基准日'] };
  const referenceDate = dates[0];
  if (birthday > referenceDate) return { status: 'pending', reason: '个人生日晚于公告基准日，需要核对资料' };
  const [by, bm, bd] = birthday.split('-').map(Number);
  const [ry, rm, rd] = referenceDate.split('-').map(Number);
  const age = ry - by - (rm < bm || (rm === bm && rd < bd) ? 1 : 0);
  return { status: age <= Number(max[1]) ? 'verified' : 'ineligible', reason: `按生日${birthday}与公告基准${referenceDate}计算${age}周岁，要求不超过${max[1]}周岁`, facts: { birthday, referenceDate, age, maxAge: Number(max[1]) } };
}

export function createEligibilityOperations({ db, getJob, now, ValidationError, getProfileContext, getQualificationProfile }) {
  db.exec('CREATE TABLE IF NOT EXISTS eligibility_results (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL, recorded_at TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS eligibility_by_job_time ON eligibility_results(job_id,recorded_at DESC)');
  const requireJob = jobId => { const job = getJob(jobId); if (!job) throw new ValidationError('岗位不存在'); return job; };
  const listEligibility = (jobId,limit=-1) => {
    const job = requireJob(jobId);
    return db.prepare('SELECT body FROM eligibility_results WHERE job_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?').all(jobId,limit).map(row => {
      const result = JSON.parse(row.body);
      const context = getProfileContext(result.profileSnapshot, result.profileSource);
      return { ...result, ...context, stale: result.jobEvidenceHash !== evidenceHash(job) || result.ruleVersion !== ruleVersion || context.profileStale };
    });
  };
  return {
    listEligibility,
    getEligibility(jobId) { return listEligibility(jobId,1)[0] ?? null; },
    evaluateEligibility(jobId, input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('资格核验输入必须为对象');
      const independent = !input.profile ? getQualificationProfile?.() : null;
      const profile = input.profile ?? (independent ? {...independent.facts,version:independent.version} : null);
      const job = requireJob(jobId);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || typeof profile.version !== 'string' || !profile.version.trim()) throw new ValidationError('个人资格档案必须包含明确版本');
      const context = independent ? {profileSource:{kind:'qualification',id:independent.id,version:independent.version},profileStale:false} : getProfileContext(profile, null, input.careerProfileId);
      const conditions = job.conditions ?? job.knownConditions.map(text => ({ text, scope: 'manual', evidence: job.originalText.includes(text) ? [{ documentId: 'manual', locator: '原文', quote: text }] : [] }));
      const checks = conditions.flatMap(condition => {
        const base = { originalCondition: condition.text, scope: condition.scope, evidence: condition.evidence };
        if (!condition.evidence?.length) return [{ ...base, condition: condition.text, status: 'pending', reason: '条件缺少可核对原文证据，不据此硬排除' }];
        const uncertain = /原则|放宽|例外|可接受|可替代|可视为|等同|豁免|特别优秀|(?:博士|硕士|本科|大专).*或/.test(condition.text);
        if (uncertain) return [{ ...base, condition: condition.text, status: 'pending', reason: '原则性、替代或例外条件需确认，不自动硬排除或豁免' }];
        const clauses = condition.text.replace(/(学历|学位|毕业|专业|证书|经验|经历)(?=(?:须|必须|需|要求|持有|具备|具有|限|仅|不超过|年龄))/g, '$1；').replace(/专业(?=(?:博士|硕士|本科|大专))/g, '专业；').replace(/并且|且|同时|并|及(?!以上|以后)|和|与/g, '；');
        return clauses.split(/[，,；;。]/).filter(clause => clause && !/^截至\d{4}年\d{1,2}月\d{1,2}日$/.test(clause)).flatMap(clause => {
          const kinds = [
            [/劳务派遣|劳动派遣|外包/, 'employment'], [/年龄|周岁|岁以下|出生/, 'age'], [/专业/, 'major'], [/证书|资格证/, 'certificate'], [/\d+年.*(?:经验|经历)|项目经验/, 'experience'], [/博士|硕士|本科|大专/, 'education'],
          ].filter(([pattern]) => pattern.test(clause)).map(([,kind]) => kind);
          return (kinds.length ? kinds : ['other']).map(kind => {
          const check = { ...base, condition: clause.trim() };
          if (kind === 'employment' && /(?:非|不采用|不是|不属于|无)(?:劳务派遣|劳动派遣|外包)/.test(clause)) return { ...check, status: 'verified', reason: '原文明示非派遣／外包，只核对该条款，不推断集团本体直签' };
          if (kind === 'employment' && /(?:本岗位|本次招聘|用工形式|用工方式).*(?:为|采用|属于).*(?:劳务派遣|劳动派遣|外包)|^(?:劳务派遣|劳动派遣|外包)(?:岗位|用工|招聘)?$/.test(clause)) return { ...check, status: 'ineligible', reason: '原文明确外包／派遣，按本人用工偏好排除' };
          if (/原则|放宽|例外|可接受|可替代|可视为|等同|豁免|特别优秀|(?:博士|硕士|本科|大专).*或/.test(clause)) return { ...check, status: 'pending', reason: '原则性、替代或例外条件需确认，不自动硬排除或豁免' };
          if ((kind === 'other' || (kind === 'education' && /优先/.test(clause) && [...clause.matchAll(/博士|硕士|本科|大专/g)].length === 1)) && /优先|沟通能力|团队合作|责任心|热爱|企业文化/.test(clause) && !/必须|须持有|不超过/.test(clause)) return { ...check, status: 'information', reason: '偏好或软技能描述，保留原文，不作为明确硬资格' };
          if (/优先|优选|加分/.test(clause) && !/必须|须持有|仅限|不超过/.test(clause) && [...clause.matchAll(/博士|硕士|本科|大专/g)].length <= 1) return { ...check, status: 'information', reason: '明确偏好条款，保留匹配依据，不作为硬资格' };
          if (kind === 'major' && /熟悉|熟练|掌握|了解/.test(clause) && !/学历|学位|毕业|须为|限.*专业/.test(clause)) return { ...check, status: 'information', reason: '专业知识能力要求，由技术匹配解释，不推断毕业专业门槛' };
          if (kind === 'other' && /亲属回避|不良记录|违法|犯罪|职业道德|个人品质|政治|拥护|心理素质|身体素质/.test(clause)) return { ...check, status: profile.declarations?.includes(condition.text) ? 'verified' : 'pending', reason: profile.declarations?.includes(condition.text) ? '本人已明确确认该声明条件' : '需本人确认声明条件', gaps: profile.declarations?.includes(condition.text) ? [] : ['本人声明'] };
          if (kind === 'other' && /熟悉|熟练|掌握|了解|热情|热爱|信仰|好奇|驱动|自驱|学习能力|沟通|协作|团队合作|责任心|业务理解|研究能力|创新能力|编程|算法基础|模型训练|保持.*畅通|报名时|简历|招聘程序|招聘期间|申请资料|招聘.*解释权/.test(clause)) return { ...check, status: 'information', reason: '能力、偏好或流程说明，保留原文并由匹配解释，不作为客观资格缺口' };
          if (kind === 'age') return { ...check, ...ageCheck(condition.text, job, profile) };
          if (kind === 'major') {
            const required = clause.match(/(?:要求|须为|限)?([A-Za-z一-龥]+)专业/)?.[1]?.replace(/^(?:须|要求|限)/, '');
            if (!profile.major) return { ...check, status: 'pending', reason: '所要求个人专业缺少明确资料', gaps: ['个人专业'] };
            if (!required || /相关|相近|或|等/.test(clause)) return { ...check, status: 'pending', reason: '专业对应范围需要确认，不将相邻专业直接视为符合' };
            return { ...check, status: profile.major === required ? 'verified' : 'pending', reason: `要求${required}专业，个人专业${profile.major}；名称不同需核对专业范围` };
          }
          if (kind === 'certificate') {
            const required = clause.match(/(?:持有|取得|具备|获得)([A-Za-z0-9-]+)(?:资格)?证书/)?.[1];
            const confirmed = required && Array.isArray(profile.certificates) && profile.certificates.includes(required);
            return { ...check, status: confirmed ? 'verified' : 'pending', reason: confirmed ? `个人资料明确持有${required}证书` : '所要求证书缺少个人明确证据', gaps: confirmed ? [] : ['个人证书'], facts: { requiredCertificate: required ?? null } };
          }
          if (kind === 'experience') {
            const requirement = clause.match(/(\d+)年(?:以上)?([A-Za-z一-龥]+?)(?:项目|工作)?经验/);
            const domain = requirement?.[2];
            const relevant = Array.isArray(profile.experiences) ? profile.experiences.filter(item => item && typeof item === 'object' && item.domain === domain) : [];
            const exact = value => typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
            if (!requirement || !relevant.length || relevant.some(item => !exact(item.startMonth) || !exact(item.endMonth))) return { ...check, status: 'pending', reason: '所要求经验需个人相关项目精确年月，不能用相邻经历或年份推断', gaps: ['相关项目精确年月'] };
            const ordinal = value => { const [year, month] = value.split('-').map(Number); return year * 12 + month - 1; };
            if (relevant.some(item => ordinal(item.endMonth) < ordinal(item.startMonth))) return { ...check, status: 'pending', reason: '个人项目起止精确年月矛盾，需核对资料', gaps: ['项目起止精确年月'] };
            const months = new Set();
            for (const item of relevant) for (let month = ordinal(item.startMonth); month < ordinal(item.endMonth); month++) months.add(month);
            const requiredMonths = Number(requirement[1]) * 12;
            return { ...check, status: months.size >= requiredMonths ? 'verified' : 'pending', reason: `可核对${domain}项目精确年月去重后${months.size}个月，要求${requiredMonths}个月；不足时需补充证据`, facts: { confirmedMonths: months.size, requiredMonths, domain } };
          }
          if (/不要求(?:博士|硕士|本科|大专)/.test(clause)) return { ...check, status: 'information', reason: '原文明示不要求该学历，不作为硬门槛' };
          if (kind === 'education' && [...clause.matchAll(/博士|硕士|本科|大专/g)].length > 1) return { ...check, status: 'pending', reason: '同条含多个学历层次，需确认各限定范围，不能用首个学历放行' };
          const required = clause.match(/博士|硕士|本科|大专/)?.[0];
          const supplied = educationRanks[profile.education];
          if (kind === 'education' && required && !/(?:非|不要求)(?:博士|硕士|本科|大专)/.test(clause)) return { ...check, status: supplied ? ((/仅限|仅接受|仅要求/.test(clause) ? supplied === educationRanks[required] : supplied >= educationRanks[required]) ? 'verified' : 'ineligible') : 'pending', reason: `明确要求${required}，个人资料为${profile.education ?? '未知'}`, facts: { requiredEducation: required, suppliedEducation: profile.education ?? null } };
          if (/^截至\d{4}年\d{1,2}月\d{1,2}日$/.test(clause)) return { ...check, status: 'information', reason: '公告年龄基准日，随明确年龄条款一起核验' };
          return { ...check, status: 'pending', reason: '明确条款解释或所需个人资料尚待核验，未生成全部符合' };
          });
        });
      });
      for (const gap of job.unknownFields ?? []) if (/(?:附件|\.pdf|\.docx|\.xlsx).*(?:未取得|失败|缺失|不可读|未配置|缺少)|未取得.*附件|公共.*条件.*(?:缺失|未取得)/.test(gap)) checks.push({ condition: '资格证据缺口', evidence: [], status: 'pending', reason: gap, gaps: [gap] });
      const status = !checks.length ? 'pending' : checks.some(item => item.status === 'ineligible') ? 'ineligible' : checks.some(item => item.status === 'pending') ? 'pending' : 'verified';
      const result = { id: randomUUID(), jobId, status, checks, unknownFields: [...(job.contractingEntity ? [] : ['签约主体未披露，不据此降级或要求核验']), ...(job.location.confirmed ? [] : ['最终工作地点未确认'])], profileVersion: profile.version, profileSnapshot: structuredClone(profile), jobSnapshot: job, jobEvidenceHash: evidenceHash(job), jobVersion: job.sourceContentVersion ?? evidenceHash(job), ruleVersion, evaluatedAt: now().toISOString(), stale: false, statement: checks.length ? '仅针对已取得的公开条件，不保证通过招聘审核；普通未披露不构成否定条件' : '未取得明确条件，不能生成全部符合；不是因签约主体等普通未披露转待核验' };
      Object.assign(result, context, {stale: context.profileStale});
      db.prepare('INSERT INTO eligibility_results (id, job_id, body, recorded_at) VALUES (?, ?, ?, ?)').run(result.id, jobId, JSON.stringify(result), result.evaluatedAt);
      return result;
    },
  };
}
