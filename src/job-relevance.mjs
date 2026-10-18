import {currentLocalSettings,targetCityLabel,usesTechnicalKeywords} from './local-settings.mjs';
// Career-direction triage uses duties, never qualifications or employer branding.
// It is separate from model matching and does not invent dimension scores.
const technicalTitle = /算法|软件(?!园|公司|企业|产业)|前端|后端|后台开发|数据科学|数据应用|数据规划|数据治理|数据仓库|数据架构|数据中台|架构师|首席数据官|首席AI官|机器学习|大模型|人工智能|AGI|AI工程|AI产品|信息技术|信息科技|信息安全|信息化技术|系统运维|科技产品建设|需求分析(?:师|岗)/i;
const technicalDuties = /(?:软件|系统|平台|后台|前端|模型|算法|大模型|应用程序).{0,12}(?:开发|研发|架构|训练|调优|部署)|(?:开发|研发|设计|建设|优化).{0,12}(?:算法|软件|技术架构|数据平台|大模型|机器学习)|(?:AI|人工智能|大模型).{0,12}(?:产品|应用|模型)|数据治理|信息安全|网络安全|系统运维|技术规划|IT规划|数据标签|技术路线|策略研发.{0,30}回测|编程|Python|Java\b|C\+\+/i;
const nonTechnical = /核算会计|总会计师|财务管理|财务资金|财务共享|司库管理|采购管理|承揽业务|股本开发执行|股权投资|股权业务法律|法律合规|合规管理岗|法律岗|法律管理|法律事务|总法律顾问|法务|税务|公司金融总监|媒体运营|运营驾驶员|党办|客户经理|理财经理|个贷经理|私人银行|私行|柜员|柜台清算|消防|医疗审核|理赔|市场拓展|市场营销|营销管理|销售|商务拓展|品牌管理|募资|人力资源|内容策划|私域内容|互联网渠道合作|互联网运营|数字化获客|生物医药投资|债券发行|股权融资|Equity Financing Business|支行.*(?:行长|负责人)|分行.*(?:总经理|行长)|零售业务团队|公司业务团队|辖属.*负责人|辖属.*团队经理|内部审计|投顾助理|固收资产交易|投资经理|信用管理|流动性管理|授信与债务|资本管理|业务管理岗.*衍生品|研究员.*自营权益|财富业务群总监|客服代表/i;

export function targetLocation(job) {
  const cities=currentLocalSettings().targetCities;
  const locations=[...new Set([...(job.location?.options??[]),job.location?.confirmed].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()))];
  if(!cities.length)return {status:'included',reason:'未限制目标城市',evidence:locations};
  const aliases=city=>[city,city.replace(/市$/, ''),...({'北京':['Beijing'],'上海':['Shanghai'],'广州':['Guangzhou'],'深圳':['Shenzhen']}[city.replace(/市$/, '')]??[])];
  const hasCity=(text,city)=>aliases(city).some(name=>text.toLowerCase().includes(name.toLowerCase()));
  const denied=(text,city)=>aliases(city).some(name=>['不含','不包括','不包含','除','非'].some(prefix=>text.replace(/\s/g,'').includes(prefix+name))||text.includes(name+'以外')||text.includes(name+'之外')||text.includes(name+'市以外')||text.includes(name+'市之外'));
  if(locations.some(value=>cities.some(city=>hasCity(value,city)&&!denied(value,city))))return {status:'included',reason:'公开工作地点包含'+targetCityLabel(),evidence:locations};
  const unknown=/全国|各地|多地|不限|待定|待确认|未披露|未知|面议|可协商|远程|其他|^中国$|^国内$/;
  if(!locations.length||locations.some(value=>unknown.test(value)&&!cities.every(city=>denied(value,city))))return {status:'unknown',reason:targetCityLabel()+'工作地点尚未确认',evidence:locations};
  return {status:'excluded',reason:`工作地点明确不含${targetCityLabel()}（${locations.join('、').slice(0,35)}）`,evidence:locations};
}
// Compatibility for callers outside the application boundary.
export const beijingLocation=targetLocation;

export function recruitmentFit(job) {
 const type=currentLocalSettings().recruitmentType;
 if(type==='all')return {status:'included'};
 const title=job.title??'';
 const campus=/校园|校招|应届|20\d{2}届|实习生/.test(title)&&!/社会招聘|社会在职/.test(title);
 const knownSocial=(job.sourceIdentities??[]).some(x=>/social$/.test(x.sourceId))||/社会招聘|社招/.test(title);
 if(type==='social'&&campus||type==='campus'&&knownSocial&&!campus)return {status:'out_of_scope',reason:'不属于所选招聘类型'};
 if(/博士后/.test(title))return {status:'out_of_scope',reason:'博士后专项不在当前招聘范围'};
 if(type==='campus'&&!campus)return {status:'needs_review',reason:'校招类型尚未确认'};
 return {status:'included'};
}
export function jobRelevance(job) {
  const title = job?.title ?? '', duties = job?.duties ?? '';
  const recruitment=recruitmentFit(job);if(recruitment.status!=='included')return {...recruitment,evidence:[title]};
  const settings=currentLocalSettings(),text=title+'\n'+duties;
  const contains=word=>text.toLowerCase().includes(word.toLowerCase());
  if(settings.excludedKeywords.some(contains))return {status:'out_of_scope',reason:'命中排除关键词',evidence:[title,duties]};
  if(!settings.roleKeywords.length)return {status:'relevant',reason:'岗位方向不限，仍需匹配与独立资格核验'};
  if(!usesTechnicalKeywords(settings)){
    const related={软件研发:/软件|前端|后端|后台开发|架构|编程|Java|Python|C\+\+/i,算法:/算法|机器学习|模型训练|特征建模/,数据科学:/数据科学|数据治理|数据平台|数据仓库|数据标签|数据架构/,人工智能:/人工智能|机器学习|大模型|AGI|\bAI\b/i,信息技术:/信息技术|信息科技|信息安全|网络安全|系统运维|IT规划|科技产品|需求分析/};
    const included=settings.roleKeywords.some(word=>contains(word)||related[word]?.test(text)&&technicalRelevance(job).status==='relevant');
    return included?{status:'relevant',reason:'命中目标岗位关键词或对应专业职责，仍需匹配与独立资格核验'}:{status:'out_of_scope',reason:'未命中目标岗位关键词',evidence:[title,duties]};
  }
  return technicalRelevance(job);
}
function technicalRelevance(job) {
  const title=job.title??'',duties=job.duties??'';
  // A business role coordinating another team's development is not itself a
  // development role. Keep the remainder, including its own technical work.
  const ownDuties=duties.replace(/(?:与|对接|协调)[^。；\n]{0,60}?(?:团队|部门|人员)[、，\s]*(?:协作|合作|沟通|对接)/g,'');
  const businessRole=/渠道经理|渠道专家|渠道销售|财务|会计|核算|产品策略分析|投资顾问|资产证券化|资本市场.*执行|债券融资|船长|轮机长|电商运营|账户业务|内核审核|投行.*质控|授信.*审|清收|投顾产品|私募产品|信用研究|成本管理|并购.*项目|债券承销|交易对手风险管理|基金投顾|集中交易.*交易|业务拓展/.test(title);
  if(businessRole&&!technicalTitle.test(title))return {status:'out_of_scope',reason:'核心职责为非技术业务、财会、营销或其他职业方向，技术工具使用不等于技术岗位',evidence:[title]};
  const facilitiesRole=/(?:电气|供配电|暖通|土木|建筑|机械|结构).{0,6}(?:设计|施工|工程)/.test(title);
  const softwareWork=/(?:软件|算法|固件|嵌入式|控制程序).{0,12}(?:研发|开发|设计)|(?:研发|开发|设计).{0,12}(?:软件|算法|固件|控制程序)/.test(ownDuties);
  if(facilitiesRole&&!technicalTitle.test(title)&&!softwareWork)return {status:'out_of_scope',reason:'核心为工程设施设计或施工，电气系统架构不等于软件技术架构',evidence:[title,duties]};
  if (technicalDuties.test(ownDuties) || /(?:数据平台|软件平台|算法系统).{0,12}技术研究/.test(ownDuties) || technicalTitle.test(title)) return {status:'relevant', reason:'技术方向候选，仍需职业匹配和独立资格核验'};
  const physicalProject=/项目/.test(title)&&/(?:化工|煤化工|土木|施工|建筑|石油).{0,15}项目/.test((job.knownConditions??[]).join('\n'));
  if (nonTechnical.test(title) || /外部董事|独立董事/.test(title) || physicalProject || /行政.{0,15}(?:办公|财务|后勤)|组织网点阵地营销|负责.*(?:保单基础服务|销售组织|品牌宣传)|制定方案企划.*销售产品|指导团队和客户经理.*营销|推介研究成果.*获取客户|风险查勘/.test(duties)) return {status:'out_of_scope', reason:'核心职责为非技术业务或其他工程方向，与软件算法方向不符', evidence: duties ? [duties] : [title]};
  return {status:'needs_review', reason:'尚未取得明确技术职责，补充职责后再判断', evidence: duties ? [duties] : []};
}

export function announcementRelevance(announcement) {
  const targets=announcement.targetJobs?.length?announcement.targetJobs:announcement.jobIdentities;
  // A broad announcement or attachment can contain other technical roles.
  if(targets?.length!==1||announcement.attachments?.length)return null;
  const duties=announcement.originalText.match(/(?:工作职责|岗位职责|职位职责|职责描述|岗位描述|职责)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:任职条件|任职资格|任职要求|应聘条件|岗位要求|岗位需求|职位要求)\s*[:：]?|$)/)?.[1]??'';
  const direction=jobRelevance({...targets[0],duties});
  if(direction.status==='out_of_scope')return direction;
  // Only the single-role source adapters' explicit location line. Never use
  // employer headquarters or infer every role's location in a broad notice.
  const locationLine=announcement.originalText.match(/^[ \t]*(?:工作地点|地点公开选项|公开地点选项|公开地点|地点)\s*[:：]\s*([^\r\n]+)$/m)?.[1];
  const fit=beijingLocation({location:{options:locationLine?[locationLine]:[]}});
  return fit.status==='excluded'?{status:'out_of_scope',reason:fit.reason,evidence:fit.evidence}:direction;
}
