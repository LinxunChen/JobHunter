import {roleDuties} from './processing-scope.mjs';
// Public employer recruitment microsites use the same anonymous Grace API.
// A live listing is discovery evidence; without a verified application state it
// does not establish that applications are still accepted.
export function createZhaopinReader({source,request,plain}) {
 const normalize=s=>s.replaceAll('(', '（').replaceAll(')', '）');
 const query=async(run,path,payload)=>{
  const r=await request(run,source.apiOrigin+'/grace/api/dsc/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const b=JSON.parse(r.raw);if(b.code!==200||!b.data)throw Error('招聘专题公开查询失败');return {...r,data:b.data};
 };
 const validate=row=>{
  const j=row?.job;
  if(row?.company?.companyNumber!==source.companyId||!j||!new RegExp('^CC'+source.companyId.slice(2)+'J\\d{1,20}$').test(j.jobNumber)||typeof j.title!=='string'||!j.title.trim()||j.positionSourceType!==1)throw Error('招聘专题岗位账号、社招身份或编号变化');
  const u=new URL(j.url);if(!['http:','https:'].includes(u.protocol)||u.hostname!=='jobs.zhaopin.com'||u.port||u.username||u.password||u.pathname!=='/'+j.jobNumber+'.htm'||u.search||u.hash)throw Error('招聘专题岗位投递链接不匹配');
  return j;
 };
 return {
  async collect(run){
   const home=await request(run,source.url);run.officialChain.push(home);if(!home.raw.includes(source.employer)||!home.raw.includes('社会招聘'))throw Error('招聘专题身份变化');
   const company=await query(run,'get-company-detail',{companyNumber:source.companyId,scene:'social',convertRequired:false}),base=company.data.companyBase;
   if(base?.companyNumber!==source.companyId||base.authenticationState!==1||company.data.businessInfo?.registeredName!==source.employer)throw Error('招聘专题认证账号与机构不一致');
   // Retain identity evidence only; the company API also contains unrelated Q&A.
   run.officialChain.push({url:company.url,readAt:company.readAt,rawHash:company.rawHash,companyNumber:base.companyNumber,registeredName:company.data.businessInfo.registeredName,authenticationState:base.authenticationState});
   const rows=[];let total;
   for(let page=1;page<=(total===undefined?1:Math.ceil(total/50));page++){
    const r=await query(run,'search-job-list',{orgNumbers:[source.companyId],jobSource:1,pageIndex:page,pageSize:50});run.pages.push(r);
    const d=r.data,p=d.pageInfo;
    if(!p||p.pageIndex!==page||p.pageSize!==50||!Number.isInteger(p.totalNum)||p.totalNum<0||p.totalNum>5000||!Array.isArray(d.jobList)||(total!==undefined&&total!==p.totalNum)||p.totalPage!==Math.ceil(p.totalNum/50))throw Error('招聘专题分页总数或结构变化');
    total=p.totalNum;
    for(const row of d.jobList){const j=validate(row);rows.push({externalId:j.jobNumber,title:j.title,url:j.url,locations:[j.cityName],category:'social',raw:{companyNumber:row.company.companyNumber,job:{jobNumber:j.jobNumber,title:j.title,cityName:j.cityName,detail:j.detail,jobCategories:j.jobCategories,modifiedTime:j.modifiedTime,positionSourceType:j.positionSourceType}}});}
   }
   if(rows.length!==total||new Set(rows.map(x=>x.externalId)).size!==total)throw Error('招聘专题跨页重复或岗位数量不完整');
   run.listings=rows;run.listComplete=true;
  },
  async detail(run,entry){
   const r=await query(run,'get-job-detail',{pc:true,jobNumber:entry.externalId}),j=validate(r.data);run.lastDetailResponse=r;
   if(j.jobNumber!==entry.externalId||j.title!==entry.title||typeof j.detail!=='string'||!j.detail.trim())throw Error('招聘专题详情身份或正文不完整');
   const body=plain(j.detail),employers=source.employers.filter(name=>(j.jobCategories??[]).some(x=>normalize(x)===normalize(name))||normalize(body).includes('【'+normalize(name)+'职位】'));
   if(employers.length>1)throw Error('招聘专题岗位出现冲突雇主');
   const unit=employers[0]??null;
   const originalText=`企业社会招聘专题\n岗位：${j.title}\n招聘单位：${unit??'未披露'}\n发布账号所属机构（不替代岗位招聘单位）：${source.employer}\n工作地点：${j.cityName??'未披露'}\n岗位原文：\n${body}\n学历要求：${j.minEducationName??'未披露'}\n工作经验：${j.workingExpName??'未披露'}\n投递入口：${j.url}\n当前报名开放状态尚未核验。`;
   return {response:r,originalText,title:j.title,url:j.url,unit,department:null,organization:unit,locations:[j.cityName??'未披露'],dutiesVerified:Boolean(roleDuties(body).trim()),applicationOpen:null,attachments:[],dateEvidence:[]};
  }
 };
}
