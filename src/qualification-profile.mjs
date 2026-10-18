import { randomUUID, createHash } from 'node:crypto';

const fields = ['education', 'major', 'birthday', 'certificates', 'experiences', 'declarations'];
const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function createQualificationProfileOperations({ db, now, ValidationError }) {
  db.exec('CREATE TABLE IF NOT EXISTS qualification_profiles (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const list = (limit=-1) => db.prepare('SELECT body FROM qualification_profiles ORDER BY rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(row.body));
  return {
    listQualificationProfiles: list,
    getQualificationProfile: () => list(1)[0] ?? null,
    saveQualificationProfile(input) {
      if (!input || typeof input.facts !== 'object' || !input.facts || Array.isArray(input.facts) || Object.keys(input.facts).some(key => !fields.includes(key))) throw new ValidationError('资格事实字段无效');
      const facts = Object.fromEntries(fields.filter(key => Object.hasOwn(input.facts, key)).map(key => [key, input.facts[key]]));
      if (Object.hasOwn(facts, 'education') && !['大专', '本科', '硕士', '博士'].includes(facts.education)) throw new ValidationError('学历无效');
      if (facts.major != null && (typeof facts.major !== 'string' || !facts.major.trim())) throw new ValidationError('专业必须为明确名称');
      if (facts.birthday != null && !calendarDate(facts.birthday)) throw new ValidationError('生日必须为有效YYYY-MM-DD');
      if (facts.certificates != null && (!Array.isArray(facts.certificates) || facts.certificates.some(item => typeof item !== 'string' || !item.trim()))) throw new ValidationError('证书必须为名称列表');
      if (facts.experiences != null && (!Array.isArray(facts.experiences) || facts.experiences.some(item => !item || typeof item.domain !== 'string' || !item.domain.trim() || !['startMonth','endMonth'].every(key => /^\d{4}-(0[1-9]|1[0-2])$/.test(item[key])) || item.endMonth < item.startMonth))) throw new ValidationError('经历需要领域及有效起止年月');
      if (facts.declarations != null && (!Array.isArray(facts.declarations) || facts.declarations.some(item => typeof item !== 'string' || !item.trim()))) throw new ValidationError('声明必须为本人确认的条款列表');
      const sources = {};
      for (const key of Object.keys(facts)) {
        const source = input.sources?.[key];
        if (!source || !['user', 'career'].includes(source.kind) || typeof source.reference !== 'string' || !source.reference.trim() || typeof source.quote !== 'string' || !source.quote.trim()) throw new ValidationError(`资格${key}必须保留明确来源和原文`);
        sources[key] = { kind: source.kind, reference: source.reference, quote: source.quote };
      }
      const hash = createHash('sha256').update(JSON.stringify({ facts, sources })).digest('hex');
      const current = list(1)[0];
      if (current?.hash === hash) return current;
      const value = { id: randomUUID(), version: `qualification-${hash.slice(0, 16)}`, hash, facts, sources, savedAt: now().toISOString() };
      db.prepare('INSERT INTO qualification_profiles VALUES(?,?)').run(value.id, JSON.stringify(value));
      return value;
    },
  };
}

// Read only labelled facts; employer names, skills and approximate years do not prove qualifications.
export function qualificationFactsFromCareer(profile) {
  const facts = {}, sources = {};
  const patterns = { education: /^(?:最高(?:已取得)?学历|学历|教育背景)\s*[：:]\s*(博士|硕士|本科|大专)(?:\s|$|[，。；])/,
    major: /^(?:所学专业|毕业专业|专业)\s*[：:]\s*([^，。；\n]+)/,
    birthday: /^(?:出生日期|生日)\s*[：:]\s*(\d{4}-\d{2}-\d{2})(?:\s|$)/ };
  for (const [key, pattern] of Object.entries(patterns)) {
    const matches = profile.text.split('\n').map(line => ({ line: line.trim(), match: line.trim().match(pattern) })).filter(item => item.match);
    if (new Set(matches.map(item => item.match[1].trim())).size !== 1) continue;
    const value = matches[0].match[1].trim();
    if (key === 'birthday' && !calendarDate(value)) continue;
    facts[key] = value; sources[key] = { kind: 'career', reference: profile.id, quote: matches[0].line };
  }
  const lines = profile.text.split('\n').map(line => line.trim());
  const certificateLines = lines.filter(line => /^(?:已取得证书|持有证书)\s*[：:]\s*\S/.test(line));
  if (certificateLines.length) {
    facts.certificates = [...new Set(certificateLines.flatMap(line => line.replace(/^[^：:]+[：:]\s*/, '').split(/[、,，；;]/).map(item => item.trim()).filter(Boolean)))];
    sources.certificates = { kind: 'career', reference: profile.id, quote: certificateLines.join('\n') };
  }
  const experienceLines = lines.map(line => ({ line, match: line.match(/^相关经历\s*[：:]\s*([^|]+)\|\s*(\d{4}-(?:0[1-9]|1[0-2]))\s*\|\s*(\d{4}-(?:0[1-9]|1[0-2]))\s*$/) })).filter(item => item.match && item.match[3] >= item.match[2]);
  if (experienceLines.length) {
    facts.experiences = experienceLines.map(({match}) => ({ domain: match[1].trim(), startMonth: match[2], endMonth: match[3] }));
    sources.experiences = { kind: 'career', reference: profile.id, quote: experienceLines.map(item => item.line).join('\n') };
  }
  return { facts, sources };
}
