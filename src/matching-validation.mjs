const string = { type: 'string' };
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const pair = object({ profileQuote: string, jobQuote: string, explanation: string });
const dimension = object({ shortReason: string, level: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] }, explanation: string, directExperiences: array(pair), transferableAbilities: array(pair), gaps: array(string), jobQuotes: array(string) });
// This is a format guard on a literal source quote, not a suitability score.
// Include ordinary operational/development duties, not only leadership verbs.
const responsibility = /负责|主导|开发|研发|建设|设计|优化|落地|制定|统筹|带领|管理|参与|研究|探索|搭建|推进|推动|输出|挖掘|评估|监测|实施|重构|改进|实现|维护|构建|测试|部署|分析|执行|支持|协助|协调|处理|审核|开展|保障|完善|组织|编制|运维|承担/;
export const matchingSchema = object({ technical: dimension, business: dimension, scope: dimension, route: { type: 'string', enum: ['expert', 'leader', 'both', 'uncertain'] }, routeExplanation: string, routeEvidence: array(string), recommendation: object({level:{type:'string',enum:['priority','consider','avoid','uncertain']},reason:string}), uncertainties: array(string) });
function structure(value, schema) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (type !== schema.type || (schema.enum && !schema.enum.includes(value))) throw new Error('Codex匹配结构或枚举无效');
  if (type === 'object') {
    if (schema.required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('Codex匹配字段无效，不采用总分或录用概率');
    for (const [key, item] of Object.entries(value)) structure(item, schema.properties[key]);
  }
  if (type === 'array') value.forEach(item => structure(item, schema.items));
}
export function validateMatching(output, { job, profile }) {
  const legacy = !Object.hasOwn(output ?? {}, 'recommendation') && !Object.hasOwn(output ?? {}, 'routeEvidence') && ['technical','business','scope'].every(key => output?.[key] && !Object.hasOwn(output[key], 'shortReason'));
  const schema = structuredClone(matchingSchema);
  if (legacy) {
    for (const key of ['recommendation','routeEvidence']) { delete schema.properties[key]; schema.required = schema.required.filter(item => item !== key); }
    for (const key of ['technical','business','scope']) { delete schema.properties[key].properties.shortReason; schema.properties[key].required = schema.properties[key].required.filter(item => item !== 'shortReason'); }
  }
  structure(output, schema);
  if (!legacy) {
    const short = value => value.trim().length > 0 && value.length <= 60 && !/[\r\n]/.test(value);
    if (!short(output.recommendation.reason) || ['technical','business','scope'].some(key => !short(output[key].shortReason))) throw new Error('推荐结论和三维短理由须为60字以内单行');
    if (output.recommendation.level === 'priority' && (!['high','medium'].includes(output.technical.level) || !['high','medium'].includes(output.scope.level) || ['low','unknown'].includes(output.business.level) || !output.technical.directExperiences.length || output.route === 'uncertain')) throw new Error('优先推荐缺少直接经历或三维证据');
    if (output.recommendation.level === 'consider' && (!['high','medium'].includes(output.technical.level) || !['high','medium'].includes(output.scope.level) || !(output.technical.directExperiences.length || output.technical.transferableAbilities.length))) throw new Error('可以考虑缺少可迁移或相关职责证据');
    const dutyText = job.duties ?? job.originalText;
    if (output.route !== 'uncertain' && !output.routeEvidence.length) throw new Error('职责路线缺少岗位职责引文');
    for(const quote of output.routeEvidence)if(!quote.trim()||!dutyText.includes(quote)){
      const error=new Error('职责路线必须引用本岗位实际职责：引文与职责原文不一致');
      error.validationEvidence={field:'routeEvidence',quote,foundInDuties:dutyText.includes(quote),responsibility:responsibility.test(quote)};throw error;
    }
    if(output.route!=='uncertain'&&!output.routeEvidence.some(quote=>responsibility.test(quote))){
      const error=new Error('职责路线必须引用本岗位实际职责：引文缺少实际职责事实');
      error.validationEvidence={field:'routeEvidence',quote:output.routeEvidence[0]??'',foundInDuties:true,responsibility:false};throw error;
    }
  }
  const jobText = job.originalText;
  const profileText = profile.text;
  for (const key of ['technical', 'business', 'scope']) {
    const result = output[key];
    if (!result.explanation.trim() || !result.jobQuotes.length || result.jobQuotes.some(quote => !quote.trim() || !jobText.includes(quote))){
      const error=new Error('匹配缺少可定位的岗位原文解释');
      error.validationEvidence={field:key+'.jobQuotes',reason:!result.explanation.trim()?'missing_explanation':!result.jobQuotes.length?'missing_quotes':'not_literal',quotes:result.jobQuotes.filter(quote=>!quote.trim()||!jobText.includes(quote))};throw error;
    }
    for (const item of [...result.directExperiences, ...result.transferableAbilities]) if (!item.profileQuote.trim() || !profileText.includes(item.profileQuote) || !item.jobQuote.trim() || !jobText.includes(item.jobQuote) || !item.explanation.trim()) throw new Error('匹配引文无法在岗位或职业资料定位');
    if (result.level === 'unknown' && !result.gaps.length) throw new Error('无法判断的匹配维度需要说明具体缺口');
    if (result.level === 'high' && (!result.directExperiences.length || result.directExperiences.some(item => item.profileQuote.length < 8 || !/负责|主导|开发|建设|设计|优化|落地|制定|统筹|带领|项目|经历/.test(item.profileQuote)))) throw new Error('高匹配缺少直接项目或职责事实，不以履历品牌代替证据');
    if (key === 'scope' && result.level !== 'unknown' && !result.jobQuotes.some(quote => responsibility.test(quote))) throw new Error('职责层级缺少实际岗位职责，不能直接映射机构职级');
  }
  if (!output.routeExplanation.trim()) throw new Error('专家／负责人路线需要职责解释');
  const validated=structuredClone(output);
  // Extra skill context may be literal source text without proving a route.
  // Retain actual responsibility quotes; altered/invented quotes still fail above.
  if(!legacy)validated.routeEvidence=validated.routeEvidence.filter(quote=>responsibility.test(quote));
  return validated;
}
