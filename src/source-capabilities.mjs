import {expandedSources,expandedMethod,validExpandedSelection} from './expanded-source-catalog.mjs';
// One capability registry for manual selection, review planning and scheduled dispatch.
export const sourceCapabilities = {
  'efunds-social': { method: 'checkEfundsSource', field: 'postIds', limit: 20, defaults: ['62fd32a72f9d2421b983ae01'], valid: id => /^[a-f0-9]{24}$/.test(id) },
  'boc-social': { method: 'checkBocSource', field: 'postIds', limit: 20, defaults: [], valid: id => /^[a-f0-9]{24}$/.test(id), urls: 'announcementUrls', urlLimit: 10, validUrl: url => /^https:\/\/www\.boc\.cn\/aboutboc\/bi4\/\d{6}\/t\d+_\d+\.html$/.test(url) },
  'ccb-social': { method: 'checkCcbSource', field: 'postIds', limit: 20, defaults: [], valid: id => /^[\w-]+:[\w-]+:[\w-]+$/.test(id) },
  'icbc-social': { method: 'checkIcbcSource', field: 'postIds', limit: 20, defaults: ['00000000000006161504'], valid: id => /^\d{20}$/.test(id) },
  'cmri-social': { method: 'checkCmriSource', field: 'postIds', limit: 20, defaults: [], valid: id => /^[A-Za-z0-9_-]{1,128}$/.test(id) },
  'beijing-sasac': { method: 'checkSasacSource', field: 'articleUrls', limit: 10, defaults: [], valid: value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ((url.hostname === 'gzw.beijing.gov.cn' && url.pathname.startsWith('/yggq/gqzp/')) || (url.hostname === 'mp.weixin.qq.com' && /^\/(?:s\/|mp\/verify|mp\/wappoc_appmsgcaptcha(?:$|\?))/.test(url.pathname))); } catch { return false; } } },
};
export const sourceAliases = { efunds: 'efunds-social', boc: 'boc-social', ccb: 'ccb-social', icbc: 'icbc-social', cmri: 'cmri-social', sasac: 'beijing-sasac' };
// Public navigation comes from adapter entry points, never from user-supplied clues.
export const recruitmentEntries = {
 'boc-social': [{label:'官方招聘栏目',url:'https://www.boc.cn/aboutboc/bi4/'},{label:'官方社招平台',url:'https://chrcmp.chinahr.com/pages/boc-social/'}],
 'ccb-social': [{label:'官方社招平台',url:'https://job.ccb.com/cn/job/plan_index.html?planType=SH'}],
 'icbc-social': [{label:'官方社招平台',url:'https://job.icbc.com.cn/pc/index.html'}],
 'cmri-social': [{label:'官方招聘平台',url:'https://job.10086.cn/personal/job/index.html'}],
 'efunds-social': [{label:'官方招聘入口',url:'https://job.efunds.com.cn/'}],
 'beijing-sasac': [{label:'国企招聘栏目',url:'https://gzw.beijing.gov.cn/yggq/gqzp/'}],
};

for (const source of expandedSources) {
  sourceCapabilities[source.id]={method:expandedMethod(source.id),field:source.type==='notices'?'articleUrls':'postIds',limit:source.type==='notices'?1:20,defaults:[],valid:id=>validExpandedSelection(source,id),selectionFromIdentity:id=>['classic-beisen','spdb'].includes(source.type)?(id.startsWith('https://')?new URL(id.split('#')[0]).searchParams.get('jobId'):id):source.type==='notices'?id.split('#')[0]:id};
  sourceAliases[source.id]=source.id;
  recruitmentEntries[source.id]=[{label:source.type==='public-table'?'官方社招岗位表':source.type==='notices'?'官方招聘公告':'官方社招平台',url:source.url}];
}

// Only observed social recruitment is implemented in this release.
for(const capability of Object.values(sourceCapabilities))capability.supportedRecruitmentTypes=['social'];
export function recruitmentTypeSupport(sourceId,settings) {
 const supportedRecruitmentTypes=sourceCapabilities[sourceId]?.supportedRecruitmentTypes??[];
 return {supportedRecruitmentTypes,requestedRecruitmentType:settings.recruitmentType,supported:settings.recruitmentType==='all'?supportedRecruitmentTypes.length>0:supportedRecruitmentTypes.includes(settings.recruitmentType)};
}
