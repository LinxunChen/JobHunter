import {locateEvidenceText} from './evidence-text.mjs';
const string = { type: 'string' };
const nullable = { type: ['string', 'null'] };
const array = items => ({ type: 'array', items });
const object = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const evidence = object({ documentId: string, locator: string, quote: string });
const condition = object({ text: string, evidence: array(evidence) });
const applicationPath = object({ kind: { type: 'string', enum: ['direct', 'steps', 'email', 'announcement'] }, url: nullable, email: nullable, steps: nullable, loginRequired: { type: 'boolean' } });
export const extractionSchema = object({
  commonConditions: array(condition),
  jobs: array(object({
    title: string, recruitmentUnit: nullable, contractingEntity: nullable, department: nullable, batch: nullable,
    locations: array(string), duties: nullable, conditions: array(condition), evidence: array(evidence),
    applicationPath: { anyOf: [applicationPath, { type: 'null' }] }, unknownFields: array(string),
    dateEvidence: array(object({ field: string, raw: string, meaning: { type: 'string', enum: ['unverified', 'explicit_publish_date', 'explicit_registration_start', 'explicit_deadline'] }, evidence: array(evidence) })),
  })),
  inputGaps: array(string),
});

function checkSchema(value, schema, path = 'output') {
  if (schema.anyOf) {
    if (schema.anyOf.some(branch => { try { checkSchema(value, branch, path); return true; } catch { return false; } })) return;
    throw new Error(`模型输出结构无效：${path}`);
  }
  const types = [].concat(schema.type);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(type)) throw new Error(`模型输出结构无效：${path}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`模型输出枚举无效：${path}`);
  if (type === 'object') {
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error(`模型输出字段无效：${path}`);
    for (const [key, item] of Object.entries(value)) checkSchema(item, schema.properties[key], `${path}.${key}`);
  }
  if (type === 'array') value.forEach((item, index) => checkSchema(item, schema.items, `${path}[${index}]`));
}

export function validateExtraction(output, documents) {
  checkSchema(output, extractionSchema);
  const byId = new Map(documents.map(document => [document.id, document]));
  const verify = items => {
    if (!items.length) throw new Error('模型缺少原文证据');
    return items.map(item => {
      const document = byId.get(item.documentId);
      const block = document?.segments?.find(segment => segment.locator === item.locator);
      const match = document && item.locator.trim() && item.quote.trim() && locateEvidenceText(block?.text ?? (document.segments?.length ? '' : document.text), item.quote);
      if (!match) throw new Error(`模型证据无法定位：${item.documentId}/${item.locator}`);
      const index = block ? document.segments.indexOf(block) : -1;
      const prefix = index >= 0 ? document.segments.slice(0, index).map(segment => segment.text).join('\n') : '';
      const start = (index >= 0 ? prefix.length + (index ? 1 : 0) : 0) + match.start;
      return { ...item, quote: match.text, start, end: start + match.text.length };
    });
  };
  const verifyCondition = item => {
    const refs = verify(item.evidence);
    const matches = refs.map(ref => locateEvidenceText(ref.quote, item.text)).filter(Boolean);
    if (!item.text.trim() || !matches.length || new Set(matches.map(match => match.text)).size !== 1) throw new Error('条件必须保留原文证据条款');
    return { ...item, text: matches[0].text, evidence: refs };
  };
  const commonConditions = output.commonConditions.map(verifyCondition);
  const joined = documents.map(document => document.text).join('\n');
  const jobs = output.jobs.map(rawJob => {
    const job = {...rawJob};
    // Human text is restored from retained source; URLs/email stay exact.
    for (const field of ['title', 'recruitmentUnit', 'contractingEntity', 'department', 'batch', 'duties']) {
      if (job[field] != null) job[field] = locateEvidenceText(joined, job[field])?.text ?? job[field];
    }
    job.locations = job.locations.map(value => locateEvidenceText(joined, value)?.text ?? value);
    if (job.applicationPath?.steps != null) job.applicationPath = {...job.applicationPath, steps: locateEvidenceText(joined, job.applicationPath.steps)?.text ?? job.applicationPath.steps};
    const jobEvidence = verify(job.evidence);
    if (!jobEvidence.some(ref => ref.quote.includes(job.title))) throw new Error('本岗位名称未出现在岗位证据中');
    if (!job.title.trim() || !joined.includes(job.title)) throw new Error('岗位名称缺少原文证据');
    for (const field of ['recruitmentUnit', 'contractingEntity', 'department', 'batch', 'duties']) if (job[field] != null && (!job[field].trim() || !joined.includes(job[field]))) throw new Error(`${field}缺少原文证据`);
    if (job.locations.some(location => !location.trim() || !joined.includes(location))) throw new Error('地点缺少原文证据');
    if (job.applicationPath) for (const field of ['url', 'email', 'steps']) if (job.applicationPath[field] != null && !joined.includes(job.applicationPath[field])) throw new Error(`投递入口 ${field} 缺少原文证据`);
    return { ...job, evidence: jobEvidence, conditions: job.conditions.map(verifyCondition), dateEvidence: (job.dateEvidence ?? []).map(date => {
      const refs = verify(date.evidence);
      const matches = refs.map(ref => locateEvidenceText(ref.quote, date.raw)).filter(Boolean);
      if (!matches.length || new Set(matches.map(match => match.text)).size !== 1) throw new Error('日期原值缺少原文证据');
      return { ...date, raw: matches[0].text, evidence: refs };
    }) };
  });
  return { commonConditions, jobs, inputGaps: output.inputGaps };
}
