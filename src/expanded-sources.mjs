import {sourceProcessingKey} from './local-settings.mjs';
import {officialApplicationUrl} from './official-application-link.mjs';
import {execFile} from 'node:child_process';
import {randomUUID,createHash,createDecipheriv} from 'node:crypto';
import {expandedSources,expandedMethod,validExpandedSelection} from './expanded-source-catalog.mjs';
import {readPublicRecruitmentTable} from './public-recruitment-table.mjs';
import {readHtmlTables} from './boc-html.mjs';
import {jobRelevance,targetLocation} from './job-relevance.mjs';
import {discoveryDeadline} from './discovery-scope.mjs';
import {createCibPublicSession} from './cib-public.mjs';
import {createAbcPublicSession} from './abc-public.mjs';
import {createZhaopinReader} from './zhaopin-public.mjs';
import {readHtmlRecruitmentUnit} from './recruitment-unit-evidence.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?\s*>|<\/?(?:p|div|li|tr|h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
const links=html=>[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({href:m[1].replaceAll('&amp;','&'),title:plain(m[2])}));
function bodyDiv(html,match) {
 const start=html.search(match);if(start<0)throw Error('官方正文区域结构变化');
 let depth=0;const rest=html.slice(start);
 for(const m of rest.matchAll(/<\/?div\b[^>]*>/gi)){depth+=m[0].startsWith('</')?-1:1;if(!depth)return rest.slice(0,m.index+m[0].length);}
 throw Error('官方正文区域不完整');
}
function confirmedDateObservation(detail) {
 const fact=detail.dateEvidence?.find(x=>x.field==='deadline'&&x.meaning==='explicit_deadline');
 return fact&&detail.originalText.includes(fact.raw)?{deadline:{raw:fact.raw,evidence:{url:detail.url,text:detail.originalText,quote:fact.raw,locator:'官方详情明确截止时间'}}}:{};
}
export function createExpandedSourceOperations({db,now,application,sourceFetch=fetch,sourceTimeoutMs=20000,ValidationError}) {
 const operations={};
 db.exec('CREATE TABLE IF NOT EXISTS source_checks (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,body TEXT NOT NULL,checked_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_processing (source_id TEXT NOT NULL,external_id TEXT NOT NULL,content_hash TEXT NOT NULL,announcement_id TEXT NOT NULL,PRIMARY KEY(source_id,external_id,content_hash))');
 const save=run=>db.prepare('INSERT INTO source_checks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,run.sourceId,JSON.stringify(run),run.checkedAt);
 operations.getExpandedSourceCoverage=id=>{if(!expandedSources.some(s=>s.id===id))throw new ValidationError('扩展来源不存在');return {sourceId:id,...application.getSourceCoverageHistory(id)};};
 for(const source of expandedSources) {
  if(source.type==='cmri')continue;
  const sourceId=source.id,origin=new URL(source.url).origin;
  let abcSession,cibSession;
  const anonymousCookies=new WeakMap();
  application.registerSource({id:sourceId,name:source.name,kind:'recruitment',monitoringObjectIds:source.objects,scope:source.type==='zhaopin'?'企业认证账号社招列表完整分页和岗位正文；具体招聘主体按原文核验，当前投递开放须另核验':source.type==='public-table'?'官方社招栏目单页岗位矩阵，仅核验列示；行摘要不是官方岗位编号，职责资格及当前开放须另补齐':source.type==='classic-beisen'?'官方社招列示窗口及已发现岗位详情；未核验完整分页时不以缺席判下线':source.type==='tele-overseas'?'2026海外社招专场完整岗位表，仅中国电信研究院；不代表全部普通社招，当前开放须独立确认':source.type==='notices'?'官方招聘栏目最新公告窗口；每轮最多1篇详情，附件与岗位按实际读取计数，不以缺失判下线':'公开社会招聘列表全部分页；每轮最多20项详情；平台共享主体分别核验，公开列示不等于报名开放'});
  const request=async(run,url,options={},binary=false)=>{
   application.assertSourceRequestAllowed(sourceId);
   const parsed=new URL(url);if(![origin,source.apiOrigin].includes(parsed.origin)||parsed.username||parsed.password)throw Error('超出核验官方来源，不跟随未知跳转');
   const controller=new AbortController();let timer;
   try {return await Promise.race([(async()=>{
    let response;
    if(sourceFetch===fetch&&source.type==='cib'){cibSession??=await createCibPublicSession();response=await cibSession.fetch(url,{...options,signal:controller.signal});}
    else if(sourceFetch===fetch&&source.type==='abc'){abcSession??=await createAbcPublicSession();response=await abcSession.fetch(url,{...options,signal:controller.signal});}
    else if(sourceFetch===fetch&&(parsed.protocol==='http:'||source.type==='public-wt'||source.transport==='curl'))response=await new Promise((resolve,reject)=>{const args=['--compressed','--silent','--show-error','--max-time',String(Math.ceil(sourceTimeoutMs/1000)),'--max-filesize','5242880','--write-out','\n%{http_code}'];if(options.method)args.push('--request',options.method);for(const [key,value]of Object.entries(options.headers??{}))args.push('--header',key+': '+value);if(options.body)args.push('--data',options.body);args.push(url);execFile('/usr/bin/curl',args,{encoding:null,maxBuffer:5243904,signal:controller.signal},(error,stdout)=>{if(error)return reject(Error('官方公开读取失败：curl '+error.code));const status=Number(stdout.subarray(-3).toString());resolve(new Response(stdout.subarray(0,-4),{status}));});});
    else response=await sourceFetch(url,{...options,headers:{...(anonymousCookies.has(run)?{Cookie:anonymousCookies.get(run)}:{}),...options.headers},redirect:'manual',signal:controller.signal});
    const setCookies=response.headers.getSetCookie?.()??[];if(setCookies.length)anonymousCookies.set(run,setCookies.map(value=>value.split(';')[0]).join('; '));
    // This platform establishes an anonymous locale/session with one redirect
    // to the exact same public URL. No account cookie or login is loaded.
    if(source.type==='moka'&&response.status===302&&new URL(response.headers.get('location'),url).href===url&&setCookies.length)response=await sourceFetch(url,{...options,headers:{Cookie:anonymousCookies.get(run),...options.headers},redirect:'manual',signal:controller.signal});
    if(response.status!==200)throw Error(`官方来源HTTP ${response.status}，未绕过登录或访问验证`);
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>5*1024*1024)throw Error('官方响应超过5MiB边界');
    return {url,status:response.status,readAt:now().toISOString(),rawHash:response.wireHash??hash(bytes),...(response.rawRedacted?{rawRedacted:true}:{}),...(response.publicData?{publicData:response.publicData}:{}),...(binary?{bytes,raw:bytes.toString('base64')}:{raw:bytes.toString('utf8')})};
   })(),new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('官方来源请求超时'));},sourceTimeoutMs);})]);}finally{clearTimeout(timer);}
  };
  const json=async(run,path,payload)=>{const r=await request(run,origin+path,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});let data;try{data=JSON.parse(r.raw);}catch{throw Error('官方JSON结构变化');}if(data.Code!==200)throw Error('官方公开查询失败：'+String(data.Message??data.Code));return {...r,data};};
  const mokaJson=async(run,path,payload)=>{const r=await request(run,origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});let body=JSON.parse(r.raw);if(body.necromancer){if(!/^[a-f0-9]{16}$/.test(body.necromancer)||typeof run.mokaIv!=='string'||run.mokaIv.length!==16)throw Error('公开响应编码协议变化');const decipher=createDecipheriv('aes-128-cbc',Buffer.from(body.necromancer),Buffer.from(run.mokaIv));body=JSON.parse(Buffer.concat([decipher.update(body.data,'base64'),decipher.final()]).toString('utf8'));}if(body.code!==0||body.success!==true||!body.data)throw Error('官方公开岗位查询失败：'+String(body.msg??body.code));return {...r,data:body.data};};
  const wtJson=async(run,path,payload)=>{const r=await request(run,origin+source.apiPrefix+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(payload).toString()});const data=JSON.parse(r.raw);if(data.req_state!==9200)throw Error('官方公开社招查询未成功');return {...r,data};};
  const cmbJson=async(run,path,payload)=>{const r=await request(run,origin+'/api/socialRecruitmentWebsite/job/'+path,payload?{method:'POST',headers:{'Content-Type':'application/json','X-B3-BusinessId':'LZ4101CMBRecruitmentPCFront'},body:JSON.stringify(payload)}:{}),data=JSON.parse(r.raw);if(data.returnCode!=='SUC0000'||!data.body)throw Error('官方社会招聘查询未成功');return {...r,data:data.body};};
  const citicsJson=async(run,path,payload)=>{const r=await request(run,source.apiOrigin+'/api/v1/recruit/'+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sysNo:'CSE001',recruitType:'05',...payload}).toString()}),data=JSON.parse(r.raw);if(data.errorCode!==0)throw Error('官方社招查询未成功：'+String(data.errorMsg));return {...r,data};};
  const bocomJson=async(run,path,params)=>{const r=await request(run,origin+'/api/GTMS.GTMS-PORTAL.V-1.0/'+path+'.do',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({REQ_MESSAGE:JSON.stringify({REQ_HEAD:{TRAN_PROCESS:'',TRAN_ID:'',ACCESS_TOKEN:null,REFRESH_TOKEN:null},REQ_BODY:{params}})}).toString()}),data=JSON.parse(r.raw);if(data.RSP_HEAD?.TRAN_SUCCESS!=='1'||!data.RSP_BODY?.results)throw Error('交行公开查询未成功');return {...r,data:data.RSP_BODY.results};};
  const abcJson=async(run,path,payload)=>{const r=await request(run,origin+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),body=r.publicData??JSON.parse(r.raw);if(body.descCode!=='CL00001')throw Error('农行公开查询未成功：'+String(body.descCode));return {...r,data:body.object};};
  const cibJson=async(run,path,payload)=>{const r=await request(run,origin+'/ersApi/recruitposition/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),body=JSON.parse(r.raw);if(body.code!=='0000'||!body.data)throw Error('兴业公开查询未成功');return {...r,data:body.data};};
  const zhaopin=source.type==='zhaopin'?createZhaopinReader({source,request,plain}):null;
  async function collect(run) {
   if(zhaopin) {await zhaopin.collect(run);}
   else if(source.type==='iguopin') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!home.raw.includes('国聘'))throw Error('国聘专属入口结构变化');
    const meta=await request(run,source.apiOrigin+'/api/activity/exclusive/v1/info?domain='+source.domain),config=JSON.parse(meta.raw);run.officialChain.push(meta);if(config.code!==200||config.data?.company_id!==source.companyId||config.data.company?.name!==source.employer)throw Error('国聘独立雇主配置变化');
    const rows=[];let total;
    for(let page=1;page<=(total===undefined?1:Math.ceil(total/100));page++){if(page>100)throw Error('国聘岗位超过100页');const r=await request(run,source.apiOrigin+'/api/jobs/v1/project-job',{method:'POST',headers:{'Content-Type':'application/json',Device:'pc',Version:'5.0.0',Subsite:'iguopin'},body:JSON.stringify({source:'s_job_list',page_size:100,page,company_id_with_sub:source.companyId,project_group:[]})}),b=JSON.parse(r.raw),d=b.data;run.pages.push(r);save(run);if(b.code!==200||!d||d.page!==page||d.page_size!==100||!Number.isInteger(d.total)||d.total<0||d.total>10000||!Array.isArray(d.list)||(total!==undefined&&total!==d.total))throw Error('国聘公开岗位分页结构变化');total=d.total;for(const row of d.list){if(!validExpandedSelection(source,row.job_id)||!row.job_name||!row.company_id||!row.company_name||!row.recruitment_type_cn)throw Error('国聘岗位身份变化');rows.push({externalId:row.job_id,title:row.job_name,category:row.company_id!==source.companyId||row.company_name!==source.employer?'excluded_scope':row.recruitment_type_cn==='社会招聘'&&row.nature_cn==='社招'?'social':'excluded',locations:(row.district_list??[]).map(x=>x.area_cn),raw:row});}}
    if(rows.length!==total||new Set(rows.map(x=>x.externalId)).size!==total)throw Error('国聘跨页重复或数量不完整');run.listings=rows;run.listComplete=true;
   }else if(source.type==='tele-overseas') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!home.raw.includes('社会招聘')||!home.raw.includes('./js/jobs1.js'))throw Error('电信海外社招专场身份变化');
    const r=await request(run,origin+'/ct2026/js/jobs1.js');run.pages.push(r);const match=r.raw.match(/var\s+jobssz\s*=\s*(\[)/);if(!match)throw Error('电信社招数组未取得');const literal=r.raw.slice(match.index+match[0].length-1);let depth=0,quoted=false,escaped=false,end=-1;
    for(let i=0;i<literal.length;i++){const c=literal[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='[')depth++;else if(c===']'&&!--depth){end=i;break;}}
    if(end<0)throw Error('电信社招数组不完整');const rows=JSON.parse(literal.slice(0,end+1).replace(/(:\s*)''(?=\s*[,}])/g,'$1""'));if(!Array.isArray(rows)||rows.length>10000||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('电信社招数组重复或超界');
    for(const row of rows)if(typeof row.lx!=='string'||!validExpandedSelection(source,row.id)||!row.company||!row.jobname||(row.company===source.employer&&(row.lx.trim()!=='社会招聘'||!row.gwzz||!row.gwyq)))throw Error('电信社招岗位身份或正文变化');
    run.listings=rows.map(row=>({externalId:row.id,title:row.jobname,category:row.company===source.employer?'social':'excluded_scope',locations:[row.city||'未披露'],raw:row}));run.listComplete=true;run.businessGaps.push('该渠道为海外人才专场，不代表研究院全部普通社招；当前截止或可报名状态未披露，不调用模型');
   }else if(source.type==='wecruit') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!home.raw.includes(source.redirectTitle?'/pb/js/social.js':'/mc/js/index.js'))throw Error('具体机构招聘门户结构变化');if(source.redirectTitle){const identity=await request(run,origin+'/wecruit/common/getSLD',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sld:new URL(source.url).hostname}).toString()}),meta=JSON.parse(identity.raw);run.officialChain.push(identity);if(meta.state!=='200'||meta.data?.linkData?.title!==source.redirectTitle||!meta.data.linkData.link.startsWith(origin+'/'+source.suite+'/'))throw Error('基金独立招聘门户主体变化');}let total,pages=1;const rows=[];
    for(let page=1;page<=pages;page++){if(page>100)throw Error('公开社招超过100页');const r=await request(run,origin+'/wecruit/positionInfo/listPosition/'+source.suite,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({recruitType:'2',currentPage:String(page),pageSize:'50'}).toString()}),b=JSON.parse(r.raw),d=b.data?.pageForm;run.pages.push(r);save(run);if(b.state!=='200'||!d||!Number.isInteger(d.dataCount)||d.dataCount<0||d.dataCount>10000||!Number.isInteger(d.totalPage)||d.totalPage>100||(d.currentPage!==page&&!(d.currentPage===0&&d.dataCount===0&&d.totalPage===0&&page===1))||!Array.isArray(d.pageData)||(total!==undefined&&total!==d.dataCount))throw Error('具体机构社招分页结构变化');total=d.dataCount;pages=d.totalPage;for(const row of d.pageData){if(!validExpandedSelection(source,row.postId)||row.recruitType!==2||row.currentSuiteKey!==source.suite.slice(2)||!row.postName||!row.company)throw Error('具体机构社招身份变化');rows.push({externalId:row.postId,title:row.postName.replace(/\\u([0-9a-f]{4})/gi,(_,code)=>String.fromCharCode(parseInt(code,16))),category:row.company===source.employer?'social':'excluded_scope',locations:[row.workPlaceStr||'未披露'],raw:row});}}
    if(rows.length!==total||new Set(rows.map(x=>x.externalId)).size!==total)throw Error('具体机构社招分页重复或数量不符');run.listings=rows;run.listComplete=true;
   }else if(source.type==='citicbank') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!home.raw.includes('/recruitportal/portal/recruitQuery')||!home.raw.includes('recruitmentType: "01"'))throw Error('中信银行社招入口身份或分类变化');const rows=[];let total;
    for(let page=1;page<=(total===undefined?1:Math.ceil(total/15));page++){if(page>1000)throw Error('中信银行公开社招超过1000页');const r=await request(run,origin+'/recruitportal/portal/recruitQuery',{method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8'},body:JSON.stringify({RELEASENAME:'',recruitmentType:'01',workAddr:[],deptCode:[],page,userId:null})}),d=JSON.parse(r.raw);run.pages.push(r);save(run);if(d.IsSuc!==true||!Number.isInteger(d.pageCount)||d.pageCount<0||d.pageCount>10000||!Array.isArray(d.tableData?.rows)||(total!==undefined&&d.pageCount!==total))throw Error('中信银行社招分页结构变化');total=d.pageCount;for(const item of d.tableData.rows){const row=item.itemMap;if(!row||!validExpandedSelection(source,String(row.ID))||!row.RELEASENAME||!row.CONTENT)throw Error('中信银行社招岗位身份变化');rows.push({externalId:String(row.ID),title:row.RELEASENAME,category:/分行|^总行$/.test(row.CONTENT)?'social':'scope_pending',locations:[row.WORKADDR||'未披露'],raw:row});}}
    if(rows.length!==total||new Set(rows.map(x=>x.externalId)).size!==total)throw Error('中信银行列表数量不符或重复');run.listings=rows;run.listComplete=true;
   }else if(source.type==='sinopec') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/<title>中国石化招聘网站/.test(home.raw))throw Error('石化官方入口身份变化');let total;const rows=[];
    for(let page=1;page<=(total===undefined?1:Math.ceil(total/100));page++){if(page>100)throw Error('石化公开社招超过100页');const r=await request(run,origin+'/api/sz/socialJobInfo/selectSocialJobVoByPage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({searchLike:'',endTag:'N',page,limit:100})}),b=JSON.parse(r.raw),d=b.data;run.pages.push(r);save(run);if(b.success!==true||b.code!=='S000000'||!d||!Array.isArray(d.records)||!Number.isInteger(d.total)||d.total<0||d.total>10000||d.current!==page||(total!==undefined&&d.total!==total))throw Error('石化未结束社招分页无效');total=d.total;for(const row of d.records){if(!validExpandedSelection(source,row.id)||row.endTag!=='N'||!row.jobName||!row.department)throw Error('石化社招身份变化');rows.push({externalId:row.id,title:row.jobName,category:/博士后|校园|实习/.test(row.jobName)?'excluded':'social',raw:row});}}
    if(rows.length!==total||new Set(rows.map(x=>x.externalId)).size!==total)throw Error('石化社招分页数量不符或重复');run.listings=rows;run.listComplete=true;if(!rows.length)run.businessGaps.push('官方未结束社招列表当前为空；无当前详情样本，不重复读取258条历史招聘');
   }else if(source.type==='cib') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/<title>兴业(?:银行|招聘官网)/.test(home.raw))throw Error('兴业官方入口身份变化');let rows=[],total,complete=false;
    // At most one recovery sweep. Completeness requires one internally
    // consistent sweep, never a union of different mutable snapshots.
    for(let sweep=0;sweep<2&&!complete;sweep++){
     rows=[];total=undefined;let drift=false;
     for(let page=1;page<=(total===undefined?1:Math.ceil(total/100));page++){
      if(page>100)throw Error('兴业公开列表超过100页');
      const r=await cibJson(run,'portalPage',{recruitType:'SR',visibilityFlag:'Y',positionStatus:'P',pagination:{pageIndex:page,pageSize:100}});r.sweep=sweep+1;run.pages.push(r);save(run);
      if(!Number.isInteger(r.data.total)||r.data.total<0||r.data.total>10000||!Array.isArray(r.data.list))throw Error('兴业社招分页结构变化');
      if(total!==undefined&&total!==r.data.total){drift=true;break;}total=r.data.total;
      for(const row of r.data.list){if(!validExpandedSelection(source,String(row.positionId))||row.recruitType!=='SR'||row.positionStatus!=='P'||!row.positionName)throw Error('兴业社招岗位身份变化');rows.push(row);}
     }
     complete=!drift&&rows.length===total&&new Set(rows.map(r=>String(r.positionId))).size===total;
    }
    const unique=[...new Map(rows.map(row=>[String(row.positionId),row])).values()];
    run.paginationRecovery={sweeps:Math.max(...run.pages.map(x=>x.sweep??1)),expected:total,read:rows.length,unique:unique.length,complete};
    if(!complete){run.gaps.push('兴业列表覆盖未完整：有限重读后取得 '+unique.length+'/'+total+' 个唯一岗位；保留已知条目，不据缺失判下线');run.failureCategory='pagination';}
    run.listings=unique.map(row=>({externalId:String(row.positionId),title:row.positionName,category:/兴业数金|兴业证券|兴业基金|兴业消费金融|兴业金融租赁|兴业理财|兴业信托|兴银/.test((row.firstBusinessUnitDesc??'')+' '+(row.businessUnitDesc??''))?'excluded_scope':/分行|总行|信用卡中心/.test(row.businessUnitDesc??'')?'social':'scope_pending',raw:row}));run.listComplete=complete;
   }else if(source.type==='abc') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/中国农业银行/.test(home.raw))throw Error('农行官方入口身份变化');
    const category=await abcJson(run,'pubDict/getRecruitTypeById',{value:100});run.officialChain.push(category);if(category.data?.id!==100||category.data?.name!=='社会招聘')throw Error('农行社招类别身份变化');
    let units;
    if(source.orgId){const meta=await abcJson(run,'org/getOrgInfoById',{value:source.orgId});run.officialChain.push(meta);if(meta.data?.id!==source.orgId||meta.data.orgName!==source.orgName||!Array.isArray(meta.data.recruitTypes))throw Error('农银金科具体机构身份未核验');if(!meta.data.recruitTypes.includes(100)){run.listings=[];run.listComplete=true;run.scopeListCount=0;run.businessGaps.push('官方具体机构目前未开放社招类别（仅列示校招）；每轮重查机构类别，社招详情尚无当前样本');return;}units=[{value:source.orgId,label:source.orgName}];}
    else{const directory=await abcJson(run,'org/getOrgsByAreaId',{recruitType:100});run.pages.push(directory);if(!Array.isArray(directory.data)||directory.data.some(x=>!x.label||!Array.isArray(x.children)))throw Error('农行社会招聘机构目录结构变化');units=directory.data.filter(x=>x.label!=='子公司').flatMap(x=>x.children);}
    const rows=[];for(const unit of units){if(!Number.isInteger(unit.value)||!unit.label)throw Error('农行机构目录身份不完整');const r=await abcJson(run,'orgPosition/getAllInPosition',{recruitType:100,orgId:unit.value});run.pages.push(r);save(run);if(!Array.isArray(r.data))throw Error('农行公开岗位列表结构变化');for(const row of r.data){if(!validExpandedSelection(source,String(row.jobPublishId))||!row.jobName||row.orgName!==unit.label)throw Error('农行岗位机构或身份不一致');rows.push({externalId:String(row.jobPublishId),title:row.jobName,category:'social',raw:{...row,orgId:unit.value}});}}
    if(new Set(rows.map(x=>x.externalId)).size!==rows.length)throw Error('农行机构目录重复岗位');run.listings=rows;run.listComplete=true;if(!rows.length)run.businessGaps.push('官方社招具体机构公开岗位列表当前为空；无当前详情样本，未执行模型');
   }else if(source.subtype==='ccbfund') {
    const home=await request(run,source.url),categories=await request(run,origin+'/website/v1/api/article/category?type=about');run.officialChain.push(home,categories);const tree=JSON.parse(categories.raw);if(tree.errcode!==0||!Array.isArray(tree.data))throw Error('基金官方栏目目录无效');const flatten=rows=>rows.flatMap(row=>[row,...flatten(row.childNodes??[])]),column=flatten(tree.data).find(x=>x.id===851&&x.name==='诚聘英才'&&x.type==='LIST');if(!column)throw Error('基金招聘栏目身份变化');let total,pages=1;const rows=[];
    for(let page=1;page<=pages;page++){const r=await request(run,origin+'/website/v1/api/article/list?'+new URLSearchParams({categoryId:'851',page:String(page),keyword:''})),body=JSON.parse(r.raw),d=body.data;run.pages.push(r);save(run);if(body.errcode!==0||!d||!Array.isArray(d.content)||!Number.isInteger(d.totalElements)||d.totalElements<0||!Number.isInteger(d.totalPages)||d.totalPages>100||d.number!==page-1||(total!==undefined&&d.totalElements!==total))throw Error('基金招聘公告分页结构变化');total=d.totalElements;pages=d.totalPages;for(const row of d.content){const url=origin+'/resource/static/content/'+row.contentId+'.html';if(row.categoryId!==851||row.articleType!=='0'||!row.title||!validExpandedSelection(source,url))throw Error('基金招聘公告身份或格式变化');rows.push({externalId:url,url,title:row.title,raw:row,category:/校园|毕业生|实习|博士后/.test(row.title)?'excluded':'unknown'});}}
    if(rows.length!==total||new Set(rows.map(x=>x.externalId)).size!==rows.length)throw Error('基金公告重复或数量不完整');run.listings=rows;run.listComplete=true;
   }else if(source.type==='bocom') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/交通银行/.test(home.raw))throw Error('官方招聘入口身份变化');const rows=[];let total;
    for(let page=1;page<=(total===undefined?1:Math.ceil(total/100));page++){if(page>100)throw Error('公开社招超过100页');const r=await bocomJson(run,'querySocietyRecruitInfo',{businessPara:{workPlace:'',pubName:'',bankNumber:'',positionId:'',engageType:3},pagePara:{pageNum:page,pageSize:100}});run.pages.push(r);save(run);if(!Number.isInteger(r.data.total)||r.data.total<0||r.data.total>10000||!Array.isArray(r.data.policyList)||(total!==undefined&&r.data.total!==total))throw Error('交行社招分页结构变化');total=r.data.total;for(const row of r.data.policyList){if(!validExpandedSelection(source,String(row.positionId))||row.engageType!=='3'||!row.pubName||!row.bankName)throw Error('交行社招岗位身份不符');rows.push(row);}}
    if(rows.length!==total||new Set(rows.map(x=>x.positionId)).size!==total)throw Error('交行社招分页重复或数量不符');run.listings=rows.map(row=>({externalId:String(row.positionId),title:row.pubName,category:row.bankParentOrgId===1000000002&&new RegExp(source.unitPattern).test(row.bankName)?'social':'excluded_scope',raw:row}));run.listComplete=true;
   }else if(source.type==='citics') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/中信证券|CITIC/i.test(home.raw))throw Error('官方招聘入口身份变化');const rows=[];
    for(const deptype of ['Headquarter','Branch']){let total;const group=[];for(let page=1;page<=(total===undefined?1:Math.ceil(total/100));page++){if(page>100)throw Error('公开社招超过100页');const r=await citicsJson(run,'getPositionList',{deptype,pageNo:String(page),pageSize:'100'});run.pages.push(r);save(run);if(!Number.isInteger(r.data.count)||r.data.count<0||r.data.count>10000||!Array.isArray(r.data.positionList)||(total!==undefined&&r.data.count!==total))throw Error('官方社招分页结构变化');total=r.data.count;for(const row of r.data.positionList){const externalId=deptype+':'+row.positionNo;if(!validExpandedSelection(source,externalId)||!row.positionName||!row.deptNo)throw Error('官方社招岗位身份缺失');group.push({externalId,title:row.positionName,category:/中信证券华南|中信证券[（(]山东|中信证券国际/.test(row.companyName??row.deptName??'')?'excluded_scope':'social',raw:{...row,deptype}});}}
     if(group.length!==total||new Set(group.map(x=>x.externalId)).size!==total)throw Error('官方社招跨页重复或数量不符');rows.push(...group);
    }run.listings=rows;run.listComplete=true;
   }else if(source.type==='cmb') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/招商银行/.test(home.raw))throw Error('官方招聘入口身份变化');const rows=[];let total;
    for(let page=1;page<=(total===undefined?1:Math.ceil(total/100));page++){const r=await cmbJson(run,'getList',{jobTypeIdList:[],orgIdList:[],pageIndex:page,pageSize:100});run.pages.push(r);save(run);if(!Array.isArray(r.data.data)||!Number.isInteger(r.data.total)||r.data.total<0||r.data.total>10000||(total!==undefined&&r.data.total!==total))throw Error('社会招聘分页结构变化');total=r.data.total;for(const row of r.data.data){if(!validExpandedSelection(source,row.publishGID)||!row.jobDisplay)throw Error('社会招聘岗位身份缺失');rows.push(row);}}
    if(rows.length!==total||new Set(rows.map(x=>x.publishGID)).size!==total)throw Error('社会招聘分页重复或不完整');run.listings=rows.map(row=>({externalId:row.publishGID,title:row.jobDisplay,category:new RegExp(source.unitPattern).test(row.branchCodeName??'')?'social':'excluded_scope',raw:row}));run.listComplete=true;
   }else if(source.type==='moka') {
    const home=await request(run,source.url);run.officialChain.push(home);const value=home.raw.match(/<input\b[^>]*id=["']init-data["'][^>]*value=["']([^"']*)["']/)?.[1];if(!value)throw Error('官方社招平台配置未取得');const config=JSON.parse(value.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&'));if(config.org?.id!==source.orgId||config.org?.name!==source.employer||String(config.siteId)!==String(source.siteId)||config.mode!=='social')throw Error('社招入口或机构身份变化');run.mokaIv=config.aesIv;run.portalEmployer=config.org.name;
    const rows=[];let total;
    for(let offset=0;offset<(total??1);offset+=100){const r=await mokaJson(run,'/api/outer/ats-apply/website/jobs',{orgId:source.orgId,siteId:source.siteId,offset,limit:100});run.pages.push(r);save(run);if(!Number.isInteger(r.data.jobStats?.total)||r.data.jobStats.total<0||r.data.jobStats.total>10000||!Array.isArray(r.data.jobs)||(total!==undefined&&r.data.jobStats.total!==total))throw Error('公开社招分页结构变化');total=r.data.jobStats.total;for(const row of r.data.jobs){if(!validExpandedSelection(source,row.id)||row.orgId!==source.orgId||!row.title)throw Error('社招岗位身份不符');rows.push(row);}}
    if(rows.length!==total||new Set(rows.map(x=>x.id)).size!==total)throw Error('公开社招分页重复或不完整');run.listings=rows.map(row=>({externalId:row.id,title:row.title,category:row.status!=='open'||row.hireMode!==1?'excluded':new RegExp(source.excludedUnitPattern).test(row.title+' '+(row.department?.name??''))?'excluded_scope':'social',raw:row}));run.listComplete=true;
   }else if(source.type==='public-wt') {
    const home=await request(run,source.url);run.officialChain.push(home);if(!/光大|CEB/.test(home.raw))throw Error('官方招聘入口身份变化');const rows=[];let total,size;
    for(let page=1;page<=(total===undefined?1:Math.ceil(total/size));page++){if(page>100)throw Error('公开社招超过100页');const r=await wtJson(run,'list',{brandCode:'1',recruitType:'2',rowSize:'100',page:String(page)});run.pages.push(r);save(run);const d=r.data;if(d.page!==page||!Number.isInteger(d.rowCount)||d.rowCount<0||!Number.isInteger(d.rowSize)||d.rowSize<1||!Array.isArray(d.postList)||(total!==undefined&&(d.rowCount!==total||d.rowSize!==size)))throw Error('官方社招分页结构变化');total=d.rowCount;size=d.rowSize;for(const row of d.postList){if(!validExpandedSelection(source,String(row.postId))||row.recruitType!==2||!row.postName)throw Error('岗位身份或社招分类无效');rows.push(row);}}
    if(rows.length!==total||new Set(rows.map(x=>x.postId)).size!==total)throw Error('官方社招分页重复或不完整');run.listings=rows.map(row=>({externalId:String(row.postId),title:row.postName,category:new RegExp(source.unitPattern).test(row.orgName??'')?'social':'excluded_scope',raw:row}));run.listComplete=true;
   }else if(source.subtype==='psbc') {
    const rows=[];let total=1;for(let page=0;page<total;page++){const url=page?source.url.replace('index.html','index_'+page+'.html'):source.url,r=await request(run,url);run.pages.push(r);save(run);const pages=Number(r.raw.match(/var countPage\s*=\s*(\d+)/)?.[1]),current=Number(r.raw.match(/var currentPage\s*=\s*(\d+)/)?.[1]);if(!r.raw.includes('name="ColumnName" content="社会招聘"')||!Number.isInteger(pages)||pages<1||pages>100||current!==page||(page&&pages!==total))throw Error('官方社招栏目身份或分页结构变化');total=pages;const block=bodyDiv(r.raw,/<div\b[^>]*class=["']col_list["']/);if(!/<ul\b/.test(block)||!/<\/ul>/.test(block))throw Error('官方栏目列表不完整');for(const item of links(block)){const url=new URL(item.href,source.url).href;if(!validExpandedSelection(source,url)||!item.title)throw Error('官方公告身份不符');rows.push({externalId:url,url,title:item.title,category:/校园|毕业生|博士后/.test(item.title)?'excluded':'unknown'});}}
    if(new Set(rows.map(x=>x.url)).size!==rows.length)throw Error('社招公告跨页重复');run.listings=rows;run.listComplete=true;if(!rows.length)run.businessGaps.push('官方社会招聘栏目当前为空；已核验栏目模板和全部分页，尚无真实详情样本');
   }else if(source.type==='spdb') {
    const home=await request(run,source.url);run.officialChain.push(home);const token=home.raw.match(/var token="([^"]+)"/)?.[1];if(!token)throw Error('官方匿名社招页面令牌未取得');
    const rows=[];let total=null,size=null;
    for(let page=1;page<=(total===null?1:Math.ceil(total/size));page++) {
     if(page>100)throw Error('公开社招超过100页边界');
     const r=await request(run,origin+'/socialJobJsonList',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',csrftoken:token,Referer:source.url},body:new URLSearchParams({pageNo:String(page),jobKey:'',recuitType:'1'}).toString()});const data=JSON.parse(r.raw);run.pages.push({...r,data});save(run);
     if(!Array.isArray(data.rows)||data.pageNo!==page||!Number.isInteger(data.totalRowCount)||!Number.isInteger(data.rowsDisplayed)||data.rowsDisplayed<1||(total!==null&&(total!==data.totalRowCount||size!==data.rowsDisplayed)))throw Error('官方社招分页、匿名会话或结构变化');
     total=data.totalRowCount;size=data.rowsDisplayed;
     for(const row of data.rows){if(!validExpandedSelection(source,String(row.openningJobId))||!row.positionName)throw Error('社招类型或岗位身份不一致');rows.push(row);}
    }
    if(rows.length!==total||new Set(rows.map(x=>x.openningJobId)).size!==total)throw Error('社招分页重复或数量不符');run.listings=rows.map(row=>({externalId:String(row.openningJobId),title:row.positionName,raw:row,category:String(row.recuitWay)==='1'&&String(row.recuitType)==='11'?'social':'excluded'}));run.listComplete=true;
   }else if(source.subtype==='boc') {
    const entries=[];let pages=1;
    for(let index=0;index<pages;index++) {
     const r=await request(run,source.url+(index?'index_'+index+'.html':''));run.pages.push(r);save(run);
     const pagination=r.raw.match(/createPageHTML\(\s*(\d+)\s*,\s*(\d+)\s*,\s*"index"\s*,\s*"html"\s*\)/);
     if(!pagination||Number(pagination[2])!==index||Number(pagination[1])<1||Number(pagination[1])>100||(index&&Number(pagination[1])!==pages))throw Error('官方公告分页结构变化');pages=Number(pagination[1]);
     const rows=links(r.raw).map(item=>({...item,url:new URL(item.href,source.url).href})).filter(item=>validExpandedSelection(source,item.url)&&new RegExp(source.titlePattern).test(item.title));entries.push(...rows);
    }
    if(new Set(entries.map(x=>x.url)).size!==entries.length)throw Error('公告跨页重复');
    run.listings=entries.map(item=>({externalId:item.url,url:item.url,title:item.title,category:/校园|毕业生|博士后/.test(item.title)?'excluded':'unknown'}));run.listComplete=true;
   }else if(source.subtype==='json') {
    const home=await request(run,source.url),config=await request(run,origin+'/webGlobal.json');run.officialChain.push(home,config);
    if(JSON.parse(config.raw).requestUrl!=='')throw Error('官方内容地址变更，停止未知来源');
    const r=await request(run,origin+'/article/join.json');run.pages.push(r);const data=JSON.parse(r.raw);
    if(data.code!==0||!Array.isArray(data.data?.articleList))throw Error('官方招聘列表结构变化');
    run.listings=data.data.articleList.map(row=>{if(!Number.isInteger(row.id)||!row.title||String(row.categoryId)!=='1')throw Error('招聘栏目身份无效');const url=origin+'/article/'+row.id+'.json';return {externalId:url,url,title:row.title,category:/校园|毕业生|博士后/.test(row.title)?'excluded':'unknown',raw:row};});
    if(new Set(run.listings.map(x=>x.externalId)).size!==run.listings.length)throw Error('官方列表重复');run.listComplete=true;
   }else if(source.subtype==='energy') {
    let total=null,pages=1;const entries=[];
    for(let index=0;index<pages;index++) {
     const r=await request(run,index===0?source.url:origin+'/recTypeSerch',index===0?{}:{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({pagenum:String(index),kinds:'3',searchtype:'job',schType:''}).toString()});run.pages.push(r);save(run);
     const count=r.raw.match(/共<b>(\d+)<\/b>条，共<b>(\d+)<\/b>页/);if(!count||Number(count[2])>100||(total!==null&&Number(count[1])!==total))throw Error('社招分页数量变化或未核验');total=Number(count[1]);pages=Number(count[2]);
     if(!r.raw.includes('社会招聘'))throw Error('分页未保留公开社招分类');
     const pageEntries=new Map();
     for(const item of links(r.raw)){const parsed=new URL(item.href,origin);if(parsed.pathname==='/annc/showgw'&&/^[a-f0-9-]{36}$/.test(parsed.searchParams.get('id')??'')&&[null,'3'].includes(parsed.searchParams.get('kinds'))){parsed.searchParams.set('kinds','3');const url=parsed.href;if(validExpandedSelection(source,url)&&!pageEntries.has(url))pageEntries.set(url,{externalId:url,url,title:item.title,category:'social'});}}
     entries.push(...pageEntries.values());
    }
    if(entries.length!==total||new Set(entries.map(x=>x.externalId)).size!==total)throw Error('社招列表重复或未完成分页');run.listings=entries;run.listComplete=true;
   }else if(source.type==='beisen') {
    const home=await request(run,source.url);run.officialChain.push(home);
    const raw=home.raw.match(/var BSGlobal = (\{[^\n]+\});/)?.[1];if(!raw)throw Error('官方招聘平台配置未取得');
    const config=JSON.parse(raw),category=config.Pages?.find(p=>p.BusinessType==='1'&&/社会招聘|社招/.test(p.Name));if(!category||!config.PortalId)throw Error('未核验社会招聘分类，不用校园或集团首页替代');
    run.portalId=config.PortalId;run.portalEmployer=config.tenantInfo?.Alias??null;run.detailRoute='/social/detail';
    const detailPage=config.Pages.find(p=>p.BusinessType==='1'&&p.Code?.toLowerCase().endsWith('detail'));if(detailPage)run.detailRoute='/'+detailPage.Code.replace(/Detail$/i,'').toLowerCase()+'/detail';
    if(source.applicationRule==='status-gated-form') {
     // Follow only the literal public route-to-template binding; never execute its JavaScript.
     const templateName=config.CustomRouteRule?.match(/["']\/social\/detail["']\s*:\s*["']\/custom\/([a-zA-Z0-9_-]+)\?jobAdId=\$\{jobAdId\}/)?.[1];
     if(templateName){const address=config.Pages.find(p=>p.Code==='custom'&&p.Name===templateName&&p.PageType===3)?.HtmlAddress;
      if(!address)throw Error('官方社招申请模板绑定缺失');const u=new URL(address);
      if(u.origin!==source.apiOrigin||u.username||u.password||u.search||u.hash||!u.pathname.startsWith(source.applicationTemplatePrefix)||!/^[a-f0-9-]{36}\.html$/.test(u.pathname.slice(source.applicationTemplatePrefix.length)))throw Error('官方社招申请模板地址超出已核验机构范围');
      run.applicationTemplateUrl=u.href;
     }
    }
    const rows=[];let total;
    for(let index=0;index<(total===undefined?1:Math.ceil(total/100));index++) {
     const r=await json(run,'/api/Jobad/GetJobAdPageList',{PortalId:run.portalId,PageIndex:index,PageSize:100,category:1,DisplayFields:['Org','LocId','PostDate','EndTime','Duty','Require','Degree','Category']});run.pages.push(r);save(run);
     if(!Number.isInteger(r.data.Count)||r.data.Count<0||r.data.Count>10000||!Array.isArray(r.data.Data)||(total!==undefined&&r.data.Count!==total))throw Error('社会招聘分页总数变化或格式无效');
     total=r.data.Count;
     for(const row of r.data.Data){if(!validExpandedSelection(source,row.Id)||String(row.CategoryId)!=='1'||!row.JobAdName)throw Error('公开列表混入未知身份或非社招条目');rows.push(row);}
    }
    if(rows.length!==total||new Set(rows.map(x=>x.Id)).size!==total)throw Error('公开列表分页重复或不完整');
    run.listings=rows.map(row=>({externalId:row.Id,title:row.JobAdName,category:source.unitPattern?(row.Org?new RegExp(source.unitPattern).test(row.Org)?'social':'excluded_scope':'scope_pending'):'social',raw:row}));run.listComplete=true;
   }else if(source.type==='public-table') {
    const r=await request(run,source.url);run.pages.push(r);save(run);
    if(!plain(r.raw).includes(source.pageIdentity)||!plain(r.raw).includes('社会招聘'))throw Error('官方社会招聘岗位表页面身份未核验');
    run.listings=readPublicRecruitmentTable(r.raw,{plain}).map(row=>({...row,raw:row,category:'social'}));run.listComplete=true;
    run.businessGaps.push('仅核验官方岗位表列示，缺职责、资格及当前开放期限；旧外部申请链接不作为可投依据');
   }else if(source.type==='classic-beisen') {
    const rows=new Map();let lastPage=1,paginationVerified=false;
    for(let index=1;index<=lastPage;index++) {
     const r=await request(run,source.url+'?PageIndex='+index);run.pages.push(r);save(run);
     if(!r.raw.includes('社会招聘')||!r.raw.includes('szzwxq'))throw Error('官方社会招聘列表结构变化');
     const visible=r.raw.replace(/<!--[\s\S]*?-->/g,'');
     const pageNumbers=links(visible).flatMap(link=>{try{const p=new URL(link.href,source.url).searchParams.get('PageIndex');return /^\d+$/.test(p??'')?[Number(p)]:[];}catch{return [];}});if(index===1){lastPage=Math.max(1,...pageNumbers);paginationVerified=pageNumbers.length>0;}if(lastPage>100)throw Error('列表超过100页边界');
     const page=new Map();for(const row of links(r.raw)){const url=new URL(row.href,source.url);const id=url.searchParams.get('jobId');if(url.pathname==='/szzwxq'&&validExpandedSelection(source,id)&&!page.has(id))page.set(id,{externalId:id,title:row.title,category:'social',url:url.href});}
     for(const [id,row] of page){if(rows.has(id))throw Error('列表跨页重复');rows.set(id,row);}
    }
    run.listings=[...rows.values()];run.listComplete=paginationVerified;run.listingWindowVerified=!paginationVerified;
    if(!paginationVerified)run.businessGaps.push('官方页面仅有当前列示窗口，无可核验分页总数；不把窗口缺席判断为岗位下线');
   }else {
    const r=await request(run,source.url);run.pages.push(r);save(run);
    const entries=links(r.raw).map(item=>({...item,url:new URL(item.href,source.url).href})).filter(item=>validExpandedSelection(source,item.url)&&/招聘|招收/.test(item.title)&&(!source.titlePattern||new RegExp(source.titlePattern).test(item.title)));
    if(!entries.length)throw Error('官方招聘公告窗口未识别到条目，不视作无新增');
    run.listings=[...new Map(entries.map(item=>[item.url,{externalId:item.url,title:item.title,url:item.url,category:/校园|毕业生|博士后/.test(item.title)?'excluded':/社会招聘/.test(item.title)?'social':'unknown'}])).values()];
    run.listingWindowVerified=true;run.listComplete=false;run.businessGaps.push('已核验最新公告窗口，历史分页未覆盖；未读取详情不计已核验资格或开放');
   }
   run.listCount=run.listings.length;run.scopeListCount=run.listings.filter(item=>!['excluded','excluded_scope','scope_pending'].includes(item.category)).length;
  }
  async function detail(run,entry) {
   if(zhaopin)return zhaopin.detail(run,entry);
   if(source.type==='public-table')return {response:run.pages[0],originalText:`官方社会招聘岗位表\n职位名称：${entry.title}\n部门：${entry.department}\n工作地点：${entry.locations.join('、')}\n官方原文链接：${source.url}\n职责、任职资格与当前开放期限未披露；岗位表列示不等于仍可申请。`,title:entry.title,url:source.url,unit:null,department:entry.department,locations:entry.locations,dutiesVerified:false,applicationOpen:null,attachments:[],dateEvidence:[],evidenceUse:'unverified'};
   if(source.type==='iguopin') {
    const data=entry.raw,response=run.pages.find(page=>JSON.parse(page.raw).data.list.some(row=>row.job_id===entry.externalId));if(typeof data.contents!=='string'||!data.contents.trim()||typeof data.is_apply!=='boolean')throw Error('国聘完整正文或可投状态未取得');
    const locations=entry.locations,url='https://www.iguopin.com/job/detail?id='+entry.externalId,body=plain(data.contents),duties=body.match(/(?:【|^|\n)岗位职责[】：:]?\s*([\s\S]*?)(?=【任职|\n任职|$)/)?.[1]??'',deadline=data.end_time&&Number(data.end_time.slice(0,4))<2100?data.end_time:null,originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${data.company_name}\n岗位编号：${entry.externalId}\n部门：${data.department_cn??'未披露'}\n工作地点：${locations.join('、')||'未披露'}\n岗位公开正文：\n${body}\n${duties?'工作职责：\n'+duties+'\n':'职责缺口：官方正文未单列明确岗位职责，不将任职要求自动视为职责。\n'}官方当前允许投递：${data.is_apply?'是':'否'}\n${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}\n${plain(data.apply_instruction)}`;
    return{response,originalText,title:entry.title,url,unit:data.company_name,department:data.department_cn,organization:data.company_name,locations,applicationOpen:data.status===1&&data.is_apply,dutiesVerified:Boolean(duties),attachments:[],dateEvidence:deadline?[{field:'end_time',raw:deadline,meaning:'explicit_deadline'}]:[],evidenceUse:data.status!==1||!data.is_apply||discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='tele-overseas') {
    const data=entry.raw,response=run.pages[0],url=source.url,locations=[data.city||'未披露'],originalText=`官方2026海外社会招聘专场\n岗位：${entry.title}\n招聘单位：${data.company}\n部门：${data.bm??'未披露'}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(data.gwzz)}\n任职条件：\n${plain(data.gwyq)}\n学历要求：${data.xl??'以任职条件为准'}\n招聘人数：${data.num??'未披露'}\n薪酬：${data.xz??'未披露'}\n福利：${data.fl??'未披露'}\n官方联系方式：${plain(data.lxfs)}\n投递入口：${url}\n公开专场未披露当前截止或可报名状态，不能认定仍可应聘。`;
    return{response,originalText,title:entry.title,url,unit:data.company,department:data.bm,organization:data.company,locations,applicationOpen:null,attachments:[],dateEvidence:[],evidenceUse:'unverified'};
   }
   if(source.type==='wecruit') {
    const r=await request(run,origin+'/wecruit/positionInfo/listPositionDetail/'+source.suite,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({postId:entry.externalId,recruitType:'2'}).toString()}),b=JSON.parse(r.raw),data=b.data;run.lastDetailResponse=r;save(run);const title=String(data?.postName??'').replace(/\\u([0-9a-f]{4})/gi,(_,code)=>String.fromCharCode(parseInt(code,16)));if(b.state!=='200'||!data||data.postId!==entry.externalId||title!==entry.title||data.recruitType!==2||data.company!==source.employer||!data.workContent||!data.serviceCondition||typeof data.canDelivery!=='boolean')throw Error('具体机构详情主体、职责、资格或可投状态变化');
    const applicationUrl=officialApplicationUrl(source,data.externalPostId);
    const url=source.url.replace('/position/society','/position/detail')+'?postId='+entry.externalId+'&recruitType=society',locations=(data.workPlaceList??[]).map(x=>x.name),deadline=data.endDate&&Number(data.endDate.slice(0,4))<2100?data.endDate:null,originalText=`官方社会招聘岗位\n岗位：${title}\n招聘单位：${data.company}\n部门：${data.department??'未披露'}\n工作地点：${locations.join('、')||data.workPlaceStr||'未披露'}\n工作职责：\n${plain(data.workContent)}\n任职条件：\n${plain(data.serviceCondition)}\n学历要求：${data.education??'未披露'}\n工作年限：${data.workYears??'未披露'}\n官方当前允许投递：${data.canDelivery?'是':'否'}\n${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}`;
    return{response:r,originalText,title,url,...(applicationUrl?{applicationUrl}:{}),unit:data.company,department:data.department,organization:data.company,locations:locations.length?locations:[data.workPlaceStr||'未披露'],applicationOpen:data.canDelivery,attachments:[],dateEvidence:data.endDate?[{field:'endDate',raw:data.endDate,meaning:deadline?'explicit_deadline':'unverified'}]:[],evidenceUse:data.canDelivery===false||discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='citicbank') {
    const r=await request(run,origin+'/recruitportal/portal/getPositionById',{method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8'},body:JSON.stringify({id:entry.externalId,channelType:'01'})}),b=JSON.parse(r.raw),data=b.data?.itemMap;run.lastDetailResponse=r;save(run);if(b.IsSuc!==true||!data||String(data.ID)!==entry.externalId||data.RELEASENAME!==entry.title||!data.SH_ZZ||!data.SH_YQ)throw Error('中信银行社招详情身份、职责或资格不完整');
    const parent=entry.raw.BRANCH_DEPT_CODE&&data.BRANCH_DEPT_CODE===entry.raw.BRANCH_DEPT_CODE&&run.listings.some(x=>x.raw.DEPT_CODE===entry.raw.BRANCH_DEPT_CODE&&x.raw.CONTENT===data.DEPT_ID);
    if(data.DEPT_ID!==entry.raw.CONTENT&&!parent){run.detailFailures??=[];run.detailFailures.push({externalId:entry.externalId,response:r,listOrganization:entry.raw.CONTENT,detailOrganization:data.DEPT_ID});save(run);throw Error('中信银行招聘机构身份不一致，未取得官方组织层级证据');}
    run.organizationRelations??=[];if(parent)run.organizationRelations.push({externalId:entry.externalId,listed:entry.raw.CONTENT,detail:data.DEPT_ID,parentCode:entry.raw.BRANCH_DEPT_CODE,proof:'本轮官方列表父机构编码与详情BRANCH_DEPT_CODE一致'});
    const url=origin+'/CustStyle/zpmhys/positionDetail.html?id='+entry.externalId+'&channelType=01&showReturn=true&showDelivery=true',text=value=>plain(String(value??'').replaceAll('&lt;br&gt;','<br>')),locations=[data.WORKADDR??'未披露'],organization=data.DEPT_ID,originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：中信银行 ${organization}\n工作地点：${locations.join('、')}\n工作职责：\n${text(data.SH_ZZ)}\n任职条件：\n${text(data.SH_YQ)}\n学历要求：${data.SH_XL??'未披露'}${data.SH_UP==='1'?'及以上':''}\n专业要求：${data.SH_ZY??'未披露'}\n工作类型：${data.SH_GZ??'未披露'}\n发布日期（不代替报名期限）：${data.FBZWDATE??'未披露'}\n投递入口：${url}\n官方公开详情未披露报名截止或当前可投状态，仅公开列示不代表仍可报名。`;
    return{response:r,originalText,title:entry.title,url,unit:source.employer,department:organization,organization,locations,applicationOpen:null,attachments:[],dateEvidence:[],evidenceUse:'unverified'};
   }
   if(source.type==='sinopec') {
    const r=await request(run,origin+'/api/sz/socialJobInfo/selectSocialJobVoById?id='+entry.externalId),b=JSON.parse(r.raw),data=b.data;run.lastDetailResponse=r;save(run);if(b.success!==true||b.code!=='S000000'||!data||data.id!==entry.externalId||data.jobName!==entry.title||data.department!==entry.raw.department||!data.positionDsc||!data.positionCondition)throw Error('石化岗位详情身份、职责或资格不完整');
    const url=origin+'/#/social/jobDetail?id='+entry.externalId+'&endTag=N',deadline=data.timeEnd,locations=[data.workLocation??'未披露'],originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${data.department}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(data.positionDsc)}\n任职条件：\n${plain(data.positionCondition)}\n学历要求：${data.educationNormText??data.educationNorm??'未披露'}\n年龄范围：${data.ageRange??'未披露'}\n补充说明：${plain(data.postTreatment)}\n${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}`;
    return {response:r,originalText,title:entry.title,url,unit:data.department,department:null,organization:data.department,locations,applicationOpen:null,attachments:[],dateEvidence:deadline?[{field:'timeEnd',raw:deadline,meaning:'explicit_deadline'}]:[],evidenceUse:discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='cib') {
    const r=await cibJson(run,'queryByIdForPortal',{id:entry.externalId}),data=r.data;run.lastDetailResponse=r;save(run);if(String(data.positionId)!==entry.externalId||data.positionName!==entry.title||data.recruitType!=='SR'||data.businessUnit!==entry.raw.businessUnit||!data.jobDuty||!data.positionRequirment)throw Error('兴业详情主体、职责或条件不完整');
    const organization=data.businessUnitDesc,locations=[data.positionAddr??'未披露'],deadline=data.expiryDate&&Number(data.expiryDate.slice(0,4))<2100?data.expiryDate:null,url=origin+'/portal/#/positionDetails/'+entry.externalId,originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：兴业银行 ${organization}\n部门：${data.departmentDesc??'未披露'}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(data.jobDuty)}\n任职条件：\n${plain(data.positionRequirment)}\n学历要求编码：${data.educationRequirment??'未披露'}\n学历是否可放宽：${data.educationIsPassable??'未披露'}\n专业要求：${plain(data.majorRequirment)}\n补充说明：${plain(data.remark)}\n${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}`;
    return {response:r,originalText,title:entry.title,url,unit:source.employer,department:organization,organization,locations,applicationOpen:null,attachments:[],dateEvidence:deadline?[{field:'expiryDate',raw:deadline,meaning:'explicit_deadline'}]:[],evidenceUse:discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='abc') {
    const r=await abcJson(run,'orgPosition/getPositioninfoById',{value:Number(entry.externalId)}),d=r.data?.publishVo;run.lastDetailResponse=r;save(run);if(!d||String(d.jobPublishId)!==entry.externalId||d.jobName!==entry.title||d.orgName!==entry.raw.orgName||Number(d.engageType)!==100||!d.duty||!d.condition)throw Error('农行具体岗位身份、社招类别或条件不完整');
    const locations=[d.placeName??r.data.workPlaces?.workPlaceName??'未披露'],deadline=d.deadlineTimes,url=source.url+'#/PositionDetails/:'+entry.externalId,unit=source.orgId?source.employer:source.employer+' '+d.orgName,originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${unit}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(d.duty)}\n任职条件：\n${plain(d.condition)}\n${plain(d.ability)}\n${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}`;
    return {response:r,originalText,title:entry.title,url,unit,department:null,organization:d.orgName,locations,applicationOpen:null,attachments:[],dateEvidence:deadline?[{field:'deadlineTimes',raw:deadline,meaning:'explicit_deadline'}]:[],evidenceUse:discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='bocom') {
    const r=await bocomJson(run,'queryPositionDetail',{positionId:Number(entry.externalId)}),data=r.data;run.lastDetailResponse=r;save(run);
    if(data.pubName!==entry.title||data.bankName!==entry.raw.bankName||data.bankNumber!==entry.raw.bankNumber||!data.responsibility||!data.require)throw Error('交行岗位详情身份、职责或资格不完整');
    const url=origin+'/#/social/recruitmentInfo/?positionId='+entry.externalId,deadline=data.endDate,locations=[data.workPlace??'未披露'],originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${data.bankName}\n部门：${data.deptName??'未披露'}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(data.responsibility)}\n任职条件：\n${plain(data.require)}\n${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}`;
    return {response:r,originalText,title:entry.title,url,unit:data.bankName,department:data.deptName??null,organization:data.bankName,locations,applicationOpen:null,attachments:[],dateEvidence:deadline?[{field:'endDate',raw:deadline,meaning:'explicit_deadline'}]:[],evidenceUse:discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='citics') {
    const [deptype,positionNo]=entry.externalId.split(':'),r=await citicsJson(run,'getPositionInfo',{deptype,positionNo,deptNo:String(entry.raw.deptNo)}),data=r.data.positionInfo;run.lastDetailResponse=r;save(run);
    if(r.data.type!=='05'||!data||data.positionNo!==positionNo||data.deptNo!==entry.raw.deptNo||data.positionName!==entry.title||data.type!=='社会招聘'||!data.positionDesc||!data.qualification)throw Error('官方岗位详情身份、职责或资格不完整');
    const locations=[data.workplace??'未披露'],department=data.deptName,url=origin+'/positonDetail?'+new URLSearchParams({deptNo:data.deptNo,positionNo,pageName:deptype==='Headquarter'?'socialHeadquarters':'socialBranch',resumeType:'1'});
    const originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${source.employer}\n部门：${department}\n招聘批次：${r.data.batchTitle??'未披露'}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(data.positionDesc)}\n任职条件：\n${plain(data.qualification)}\n公开列示日期字段（不代替报名期限）：${entry.raw.reqendDate??'未披露'}\n投递入口：${url}\n官方网页查看详情及应聘需要登录；公开只读接口可匿名读取，不保证目前可提交。`;
    return {response:r,originalText,title:entry.title,url,unit:source.employer,department,organization:department,locations,applicationOpen:null,attachments:[],dateEvidence:entry.raw.reqendDate?[{field:'reqendDate',raw:entry.raw.reqendDate,meaning:'unverified'}]:[],evidenceUse:'unverified'};
   }
   if(source.type==='cmb') {
    const r=await cmbJson(run,'getDetail?publishId='+entry.externalId),data=r.data;run.lastDetailResponse=r;save(run);const sameOrganization=data.branchCodeName===entry.raw.branchCodeName||entry.raw.branchCodeName==='总行'+data.branchCodeName;if(data.publishGID!==entry.externalId||data.jobDisplay!==entry.title||!data.jobResponsibility||!data.jobRequirement||!sameOrganization)throw Error('岗位详情身份、职责或条件不完整');
    const title=entry.title,organization=entry.raw.branchCodeName,unit=new RegExp(source.unitPattern).test(organization)?source.employer+' '+data.branchCodeName:null,locations=[data.locationName??'未披露'],deadline=data.expiredOn,url=origin+'/positionDetail/social?publishId='+entry.externalId;
    const originalText=`官方社会招聘岗位\n岗位：${title}\n招聘单位：${unit??'未披露'}\n工作地点：${locations.join('、')}\n工作职责：\n${plain(data.jobResponsibility)}\n任职条件：\n${plain(data.jobRequirement)}\n${deadline?'报名截止时间：'+deadline+'\n':''}${data.longTermRecruitment===true?'官方标记：长期招聘\n':''}投递入口：${url}`;
    return {response:r,originalText,title,url,unit,department:organization,organization,locations,dateEvidence:deadline?[{field:'deadline',raw:deadline,meaning:'explicit_deadline',evidence:[{quote:'报名截止时间：'+deadline}]}]:[],applicationOpen:null,longTermRecruitment:data.longTermRecruitment===true,attachments:[],evidenceUse:deadline&&discoveryDeadline(originalText,now()).status==='expired'?'historical':'unverified'};
   }
   if(source.type==='moka'||source.type==='public-wt') {
    const moka=source.type==='moka',r=moka?await mokaJson(run,'/api/outer/ats-apply/website/job',{orgId:source.orgId,siteId:source.siteId,jobId:entry.externalId}):await wtJson(run,'detail',{postId:entry.externalId,recruitType:'2',brandCode:'1'}),data=moka?r.data:r.data.postInfo;
    if(!data||String(moka?data.id:data.postId)!==entry.externalId||(moka?data.title:data.postName)!==entry.title||(moka?data.orgId!==source.orgId||data.hireMode!==1:data.recruitType!==2))throw Error('岗位详情身份或社招分类无效');
    const description=plain(moka?data.jobDescription:data.workConcet),requirements=plain(moka?'':data.serviceCondition);if(!description||!moka&&!requirements)throw Error('岗位职责或完整条件未取得');
    const department=moka?data.department?.name:data.orgName,unit=moka?department===source.employer?source.employer:null:/分行|总行/.test(department??'')?source.employer+' '+department:null;
    const locations=moka?(data.locations??[]).map(x=>x.cityName?(x.cityName+(x.address?' '+x.address:'')):/^110\d{3}$/.test(String(x.cityId))?'北京市'+(x.address?' '+x.address:''):x.address||'城市编码 '+x.cityId):[data.workPlace].filter(Boolean),deadline=moka?null:data.signUpDeadline;
    const evidenceUse=deadline&&discoveryDeadline('报名截止时间：'+deadline,now()).status==='expired'?'historical':'unverified',applicationOpen=moka?data.status==='open':null;
    const url=moka?source.url+'#/job/'+entry.externalId:origin+'/uiap/wt/'+source.corpCode+'/zpzh/postDetail?recruitType=2&postId='+entry.externalId;
    const originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${unit??'未披露'}\n部门：${department??'未披露'}\n平台机构：${run.portalEmployer??source.employer}\n工作地点：${locations.join('、')||'未披露'}\n工作职责：\n${description}\n${moka?'':'任职条件：\n'+requirements+'\n'}${deadline?'报名截止时间：'+deadline+'\n':''}投递入口：${url}`;
    return {response:r,originalText,title:entry.title,url,unit,department,organization:department,locations,dateEvidence:deadline?[{field:'deadline',raw:deadline,meaning:'explicit_deadline',evidence:[{quote:'报名截止时间：'+deadline}]}]:[],applicationOpen,attachments:[],evidenceUse};
   }
   if(source.type==='beisen') {
    const params=new URLSearchParams({jobAdId:entry.externalId,category:'1',portalId:run.portalId,displayFields:JSON.stringify(['Org','LocId','PostDate','EndTime','Duty','Require','Degree','Category'])});
    const r=await json(run,'/api/JobAd/GetJobAdInfo?'+params);const data=r.data.Data;
    if(!data||data.Id!==entry.externalId||data.JobAdName!==entry.title||String(data.CategoryId)!=='1'||!data.Duty||(!data.Require&&!/任职资格|任职要求|任职基本要求/.test(data.Duty)))throw Error('岗位详情身份、职责或条件不完整');
    const org=plain(data.Org),unit=/(?:有限公司|集团.*公司|保险公司|分公司|分行)$/.test(org)||['中金财富','中再产险','中再寿险'].includes(org)?org:null;
    const department=unit?null:org||null;const url=origin+run.detailRoute+'?jobAdId='+entry.externalId;
    let applicationOpen=null,applicationEvidence=null;
    if(source.applicationRule==='status-gated-form') {
     const page=run.applicationTemplateUrl?(run.applicationTemplateResponse??=await request(run,run.applicationTemplateUrl)):await request(run,url);
     const gate=page.raw.match(/if\s*\(\s*detail\.Status\s*!=\s*1\s*\)\s*\{\s*alert\(\s*['"]职位已下架['"]\s*\);\s*window\.location\.href\s*=\s*['"][^'"]+['"];\s*return\s*;/);
     const button=page.raw.match(/<a\b[^>]*\bid=["']apply["'][^>]*>[\s\S]*?立即申请[\s\S]*?<\/a>/);
     const handler=page.raw.match(/\$\(['"]#apply['"]\)\.on\(['"]click['"],function\(\)\s*\{[\s\S]*?location\.href\s*=\s*['"]\/form\?fromPage=job&jobAdId=['"]\+jobAdId/);
     if(gate&&button&&!/disabled|display\s*:\s*none|\bhidden\b/i.test(button[0])&&handler?.[0].includes('/api/Login/GetUserInfo')&&Number.isInteger(data.Status)) {
      applicationOpen=data.Status===1;
      applicationEvidence={url,templateUrl:page.url,rawHash:page.rawHash,readAt:page.readAt,text:gate[0]+'\n'+button[0]+'\n'+handler[0]+'\n本轮同一岗位官方Status='+data.Status,quote:'职位已下架',locator:'官方下架状态规则与当前岗位申请表单入口'};
     } else run.businessGaps.push(entry.title+'：当前页面在招规则或申请入口未核验，不以Status字段代替');
    }
    const originalText=`官方社会招聘岗位\n岗位：${entry.title}\n招聘单位：${unit??'未披露'}\n部门：${department??'未披露'}\n平台所属机构（不替代岗位招聘单位）：${run.portalEmployer??source.name}\n地点：${(data.LocNames??[]).join('、')||'未披露'}\n工作职责：\n${plain(data.Duty)}\n任职条件：\n${plain(data.Require)}\n官方详情原始日期（日期语义未核验，不代替报名时间）：${JSON.stringify({PostDate:data.PostDate,EndTime:Number(String(data.EndTime).slice(0,4))>=2100?null:data.EndTime})}\n投递入口：${url}\n点击申请后按官方步骤登录填写简历。平台Status只证明公开列示，不保证报名开放。`;
    return {response:r,originalText,title:entry.title,url,unit,department,organization:org,dateEvidence:['PostDate','EndTime'].filter(field=>data[field]).map(field=>({field,raw:data[field],meaning:'unverified'})),applicationOpen,applicationEvidence,attachments:[]};
   }
   const url=source.type==='spdb'?origin+'/jobDetail?jobId='+entry.externalId+'&type=1':source.type==='classic-beisen'?origin+'/szzwxq?jobId='+entry.externalId:entry.url;
   const r=await request(run,url);run.lastDetailResponse=r;save(run);let body,title=entry.title;
   if(source.type==='spdb'){body=bodyDiv(r.raw,/<div[^>]*class="bordercontainer"/i);if(!body.includes('岗位职责')||!body.includes('应聘条件')||!body.includes(entry.title))throw Error('社招详情职责、资格或身份不完整');}
   else if(source.subtype==='json') {const data=JSON.parse(r.raw);if(data.code!==0||!data.data?.article?.content||data.data.article.title!==entry.title)throw Error('招聘正文身份或内容无效');body=data.data.article.content;}
   else
   if(source.type==='classic-beisen') {body=bodyDiv(r.raw,/<div\s+class="zwxq"/i);if(!body.includes(entry.title)||!body.includes('工作职责')||!body.includes('任职资格'))throw Error('官方岗位详情职责条件或选中身份不完整');}
   else body=bodyDiv(r.raw,new RegExp('<div[^>]*class=["\'][^"\']*'+source.bodyClass+'[^"\']*["\']|<div[^>]*class='+source.bodyClass+'(?=[\\s>])','i'));
   const tables=readHtmlTables(body,{plain,sourceOffset:0});let originalText=plain(body)+tables.map(table=>'\n【官方表格】\n'+table.expandedText).join('');
   // The verified official listing/JSON title can be outside the article body.
   if(!originalText.includes(title))originalText='官方栏目列示标题：'+title+'\n'+originalText;
   const deadline=originalText.match(/(?:截止|报名[^\n]{0,15}至|报名时间[^\n]{0,25}至)[^\n]{0,15}?(20\d{2})[年.-](\d{1,2})[月.-](\d{1,2})日?/);
   const namedBatch=title.match(/(20\d{2})(?:[-—](20\d{2}))?年(?:社会招聘|校园招聘)/);
   const historicalBatch=namedBatch&&Number(namedBatch[2]??namedBatch[1])<new Date(now().getTime()+28800000).getUTCFullYear();
   const explicitEnd=discoveryDeadline(originalText,now()).day??(deadline?`${deadline[1]}-${deadline[2].padStart(2,'0')}-${deadline[3].padStart(2,'0')}`:null);
   const evidenceUse=historicalBatch||(explicitEnd&&explicitEnd<new Date(now().getTime()+28800000).toISOString().slice(0,10))?'historical':'unverified';
   const attachmentGap=message=>{if(evidenceUse==='historical')run.businessGaps.push('历史招聘附件：'+message);else{run.gaps.push(message);run.failureCategory='attachment';}};
   const attachments=[];
   const fileLinks=[...new Map(links(r.raw).filter(item=>/\.(?:pdf|docx|xlsx|doc|xls)(?:\?|$)/i.test(item.href)).map(item=>[item.href,item])).values()];
   if(fileLinks.length>10)throw Error('官方附件超过10项读取边界');
   if(/详见附件|见附件\d/.test(originalText)&&!fileLinks.length)attachmentGap(entry.title+'：原文引用必要附件，但附件链接未取得');
   for(const item of fileLinks) {
    if(!/\.(?:pdf|docx|xlsx|doc|xls)(?:\?|$)/i.test(item.href))continue;
    const attachmentUrl=new URL(item.href,url).href,name=item.title||new URL(attachmentUrl).pathname.split('/').at(-1),ext=new URL(attachmentUrl).pathname.split('.').at(-1).toLowerCase();
    const mediaType={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}[ext];
    try {if(!mediaType)throw Error('旧式Office附件格式未支持，保留补录缺口');const file=await request(run,attachmentUrl,{},true);attachments.push({name,mediaType,contentBase64:file.raw});run.attachmentsChecked++;}
    catch(error){attachments.push({name,mediaType:mediaType??'application/octet-stream'});attachmentGap(name+'：'+error.message);}
   }
   const institution=readHtmlRecruitmentUnit({html:r.raw,body,title,response:r,plain});
   if(institution.context)originalText+='\n【官方网页机构信息】\n'+institution.context;
   if(institution.unit)originalText+='\n招聘单位：'+institution.unit+'\n招聘单位依据：'+(institution.evidence.basis==='job_label'?'岗位明确单位字段':'同页官网名称、版权主体与具名官方招聘声明一致；不代表劳动合同签约主体');
   originalText+='\n官方原文链接：'+url+'\n平台属于：'+source.name+'，岗位雇主须按原文提取，不能用平台名称替代。';
   const roleDeadline=source.type==='classic-beisen'&&originalText.match(/^(?:报名截止时间|截止时间)\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/m);
   const locations=source.type==='classic-beisen'?originalText.match(/^工作地点\s*[:：]\s*([^\n]+)/m)?.[1]?.trim():null;
   const applyId=r.raw.match(/<a\b[^>]*\bid=["']apply["'][^>]*\burl=["']\/Portal\/Resume\/ResumeItem\?jid=(\d+)["']/i)?.[1];
   return {response:r,originalText,title,url,unit:institution.unit,recruitmentUnitEvidence:['classic-beisen','spdb'].includes(source.type)?institution.evidence:null,department:null,dateEvidence:roleDeadline?[{field:'deadline',raw:roleDeadline[1],meaning:'explicit_deadline'}]:[],applicationOpen:roleDeadline&&applyId===entry.externalId?evidenceUse!=='historical':null,locations:locations?[locations]:undefined,attachments,evidenceUse};
  }
  operations[expandedMethod(sourceId)]=async(input={})=>{
   const field=source.type==='notices'?'articleUrls':'postIds',selected=input[field]??[],limit=source.type==='notices'?1:20;
   if(!Array.isArray(selected)||selected.length>limit||selected.some(id=>!validExpandedSelection(source,id)))throw new ValidationError('来源详情选择越界');
   if(!['manual','scheduled'].includes(input.trigger??'manual')||(input.trigger==='scheduled'&&!Number.isFinite(Date.parse(input.scheduledFor))))throw new ValidationError('来源触发时刻无效');
   const run={id:randomUUID(),sourceId,expandedSource:true,checkedAt:now().toISOString(),trigger:input.trigger??'manual',scheduledFor:input.scheduledFor??null,status:'checking',stage:'list',officialChain:[],pages:[],listings:[],listCount:0,listComplete:false,details:[],jobIds:[],attachmentsChecked:0,gaps:[],businessGaps:[],error:null};save(run);
   try {
    await collect(run);save(run);
    for(const id of selected) {
     application.assertSourceRequestAllowed(sourceId,id);
     let entry=run.listings.find(item=>item.externalId===id);
     if(!entry&&source.type==='classic-beisen'&&run.listingWindowVerified){const previous=application.listSourceCandidates(sourceId).find(x=>x.externalId===id);if(previous?.title)entry={externalId:id,title:previous.title,category:'social',knownDetailOutsideWindow:true};}
     if(!entry){
      if(run.listComplete)for(const job of application.listJobs()){
       const identity=job.sourceIdentities?.find(x=>x.sourceId===sourceId&&(x.externalId===id||x.externalId.split('#')[0]===id));if(!identity)continue;
       const text='本轮完整社会招聘列表未列示该岗位；仅确认疑似下线，不确认招聘结束。';
       application.recordRecruitmentObservation(job.id,{id:run.id+':'+job.id,sourceId,externalId:identity.externalId,observedAt:run.checkedAt,acquisition:'success',listComplete:true,listed:false,detailAccessible:null,applicationOpen:null,evidence:{url:source.url,text,quote:text},sourceCheckId:run.id});
      }
      run.businessGaps.push('选中详情不在本轮公开列表；保留原岗位，不据此判断结束');continue;
     }
     if(['excluded','excluded_scope','scope_pending'].includes(entry.category)&&input.processJobs!==false){run.businessGaps.push(entry.title+'：校招、博士后或主体范围未核验，不自动加工');continue;}
     if(input.trigger==='scheduled'&&input.processJobs!==false){
      const fit=targetLocation({location:{options:entry.locations??(typeof entry.raw?.WORKADDR==='string'?[entry.raw.WORKADDR]:[])}});
      const direction=jobRelevance({title:entry.title,duties:typeof entry.raw?.Duty==='string'?plain(entry.raw.Duty):''});
      if(fit.status==='excluded'||direction.status==='out_of_scope'){
       const reason=fit.status==='excluded'?fit.reason:direction.reason;run.skippedSelections??=[];run.skippedSelections.push({externalId:id,title:entry.title,processingSkipped:reason,processingDecision:{status:'excluded',reason}});save(run);continue;
      }
     }
     run.stage='detail';
     try {
      run.detailAttempts??=[];run.detailAttempts.push({externalId:id,at:now().toISOString()});save(run);
      const gapStart=run.gaps.length,d=await detail(run,entry);run.details.push({...d,externalId:id});save(run);
      if(source.unitPattern&&!new RegExp(source.unitPattern).test(d.organization??'')){run.details.at(-1).scopeDeferred=true;run.businessGaps.push(entry.title+'：共享平台具体雇主不在已核验目标范围，暂缓加工');continue;}
      application.assertSourceRequestAllowed(sourceId,id);
      // A detail-only refresh must update known jobs too. Recovery processing
      // does not run the adapter's post-model branch a second time.
      const knownJobs=db.prepare("SELECT body FROM jobs WHERE json_extract(body,'$.title')=? AND json_extract(body,'$.sourceUrl')=?").all(d.title,d.url).map(row=>JSON.parse(row.body)).filter(job=>job.sourceIdentities?.some(x=>x.sourceId===sourceId&&(x.externalId===id||x.externalId===d.url)));
      for(const job of knownJobs)if(d.recruitmentUnitEvidence){
       const result=application.recordJobRecruitmentUnitEvidence(job.id,{sourceId,externalId:id,evidence:d.recruitmentUnitEvidence});
       if(result.status==='conflict')run.businessGaps.push(d.title+'：官网招聘单位与已存单位不一致，保留现值及原件，待核验');
      }
      const priorIds=[...new Set([...db.prepare('SELECT DISTINCT announcement_id FROM source_processing WHERE source_id=? AND external_id=?').all(sourceId,id).map(x=>x.announcement_id),...knownJobs.map(x=>x.announcementId).filter(Boolean)])].map(announcement_id=>({announcement_id}));
      for(const prior of priorIds){
       const a=application.getAnnouncement(prior.announcement_id);if(a?.sourceUrl!==d.url||a.title!==d.title)continue;
       application.recordAnnouncementProcessingObservation(a.id,{sourceUrl:d.url,title:d.title,checkedAt:run.checkedAt,applicationOpen:d.applicationOpen,locations:d.locations,recruitmentUnitEvidence:d.recruitmentUnitEvidence});
       application.reconcileAnnouncementJobs(a.id);
       for(const jobId of a.jobIds){const job=application.getSourceJob(jobId),identity=job?.sourceIdentities?.find(x=>x.sourceId===sourceId);if(!identity)continue;
        application.recordRecruitmentObservation(jobId,{id:run.id+':'+jobId,sourceId,externalId:identity.externalId,observedAt:run.checkedAt,acquisition:'success',listComplete:run.listComplete,listed:true,detailAccessible:true,applicationOpen:d.applicationOpen,...(d.applicationUrl?{applicationUrl:d.applicationUrl}:{}),...confirmedDateObservation(d),evidence:{url:d.url,text:d.originalText+(d.applicationEvidence?'\n本轮报名开放证据（独立于岗位原文）：\n'+d.applicationEvidence.text:''),quote:d.title},sourceCheckId:run.id});
       }
      }
      if(zhaopin){run.details.at(-1).processingDecision={status:'needs_material',reviewPolicy:'on_change',reason:[d.dutiesVerified===false?'职责正文缺失':null,!d.unit?'具体招聘主体未确认':null,'当前投递状态仍需浏览器核验'].filter(Boolean).join('；')+'；原文保留，不调用模型'};run.businessGaps.push(entry.title+'：'+run.details.at(-1).processingDecision.reason);continue;}
      if(source.type==='public-table'){run.details.at(-1).processingDecision={status:'needs_material',reviewPolicy:'on_change',reason:'官方岗位表缺职责、资格和当前开放依据；补充最新完整社招详情后再加工'};run.businessGaps.push(entry.title+'：'+run.details.at(-1).processingDecision.reason);continue;}
      if(d.evidenceUse==='historical'){run.details.at(-1).processingSkipped='历史招聘原文保留，不进入当前岗位加工；栏目内容更新后再核对';run.businessGaps.push(entry.title+'：'+run.details.at(-1).processingSkipped);continue;}
      if(input.processJobs===false){run.businessGaps.push(entry.title+'：本次仅核验公开详情，未执行模型');continue;}
      if(run.gaps.length>gapStart){run.businessGaps.push(entry.title+'：必要附件缺失，暂缓自动岗位加工');continue;}
      if(['moka','public-wt','cmb','citics','bocom','abc','cib','sinopec','citicbank','wecruit','tele-overseas','iguopin'].includes(source.type)){
       const fit=targetLocation({location:{options:d.locations}}),duties=d.originalText.match(/工作职责：\n([\s\S]*?)(?=\n(?:任职要求|任职条件|报名截止时间|投递入口)|$)/)?.[1]??'',direction=jobRelevance({title:d.title,duties});
       if(fit.status==='excluded'||direction.status==='out_of_scope'){run.details.at(-1).processingSkipped=fit.status==='excluded'?fit.reason:direction.reason;run.businessGaps.push(entry.title+'：'+run.details.at(-1).processingSkipped);continue;}
       if(fit.status!=='included'||direction.status!=='relevant'||d.dutiesVerified===false||['moka','wecruit','iguopin'].includes(source.type)&&d.applicationOpen!==true||['public-wt','cmb','citics','bocom','abc','cib','sinopec','citicbank','tele-overseas','iguopin'].includes(source.type)&&!d.longTermRecruitment&&discoveryDeadline(d.originalText,now()).status!=='open_window'){run.details.at(-1).processingDecision={status:'needs_material',reason:'当前开放、目标地点或明确技术职责尚未同时核验，保留公开详情，不调用模型'};run.businessGaps.push(entry.title+'：'+run.details.at(-1).processingDecision.reason);continue;}
      }
      const digest=hash(JSON.stringify({originalText:d.originalText,attachments:d.attachments})),cached=db.prepare('SELECT announcement_id FROM source_processing WHERE source_id=? AND external_id=? AND content_hash=?').get(sourceId,id,sourceProcessingKey(digest));
      const target={title:d.title,recruitmentUnit:d.unit,department:d.department,batch:null};
      const identity={...target,sourceIdentity:{sourceId,externalId:id},observedAt:run.checkedAt,sourceEvidence:{sourceId,checkedAt:run.checkedAt,listed:true,applicationOpen:d.applicationOpen,detailUrl:d.response.url,applicationUrl:d.url},dateEvidence:d.dateEvidence};
      let announcement=cached?application.getAnnouncement(cached.announcement_id):null;
      if(!announcement){announcement=await application.createAnnouncement({title:d.title,originalText:d.originalText,sourceUrl:d.url,evidenceUse:d.evidenceUse??'unverified',attachments:d.attachments,...(['beisen','moka','public-wt','cmb','citics','bocom','abc','cib','sinopec','citicbank','wecruit','tele-overseas','iguopin'].includes(source.type)?{jobIdentities:[identity],targetJobs:[target]}:{sourceIdentityContext:{sourceId,externalId:d.url,observedAt:run.checkedAt}})});db.prepare('INSERT INTO source_processing VALUES(?,?,?,?)').run(sourceId,id,sourceProcessingKey(digest),announcement.id);}
      announcement=application.recordAnnouncementProcessingObservation(announcement.id,{sourceUrl:d.url,title:d.title,checkedAt:run.checkedAt,applicationOpen:d.applicationOpen,locations:d.locations,recruitmentUnitEvidence:d.recruitmentUnitEvidence});
      run.stage='processing';announcement=await application.processAnnouncement(announcement.id);run.details.at(-1).announcementId=announcement.id;
      run.details.at(-1).processingStatus=announcement.status;run.details.at(-1).processingDecision=announcement.sourceProcessingDecision;
      if(announcement.processingSkipped)run.details.at(-1).processingSkipped=announcement.processingSkipped;
      if(['deferred','scope_pending'].includes(announcement.status)){run.businessGaps.push(entry.title+'：'+(announcement.processingSkipped??'等待模型执行恢复'));continue;}
      if(announcement.status==='failed')throw Error('模型加工失败：'+announcement.error);
      run.jobIds.push(...announcement.jobIds);run.businessGaps.push(...announcement.gaps);
      for(const jobId of announcement.jobIds){const identity=application.getSourceJob(jobId).sourceIdentities?.find(x=>x.sourceId===sourceId&&(['beisen','moka','public-wt','cmb','citics','bocom','abc','cib','sinopec','citicbank','wecruit','tele-overseas','iguopin'].includes(source.type)?x.externalId:['spdb','classic-beisen'].includes(source.type)?/^\d+$/.test(x.externalId)?x.externalId:new URL(x.externalId.split('#')[0]).searchParams.get('jobId'):x.externalId.split('#')[0])===id);if(identity)application.recordRecruitmentObservation(jobId,{id:run.id+':'+jobId,sourceId,externalId:identity.externalId,observedAt:run.checkedAt,acquisition:'success',listComplete:run.listComplete,listed:true,detailAccessible:true,applicationOpen:d.applicationOpen,...(d.applicationUrl?{applicationUrl:d.applicationUrl}:{}),...confirmedDateObservation(d),evidence:{url:d.url,text:d.originalText+(d.applicationEvidence?'\n本轮报名开放证据（独立于岗位原文）：\n'+d.applicationEvidence.text:''),quote:d.title},sourceCheckId:run.id});}
     }catch(error){run.gaps.push(entry.title+'：'+error.message);run.failureCategory??=run.stage==='processing'?'processing':'detail';}
    }
    run.status=run.gaps.length?'partial':'success';run.stage='completed';
   }catch(error){run.status='failed';run.error=error.message;}
   finally {if(cibSession){await cibSession.close();cibSession=null;}if(abcSession){await abcSession.close();abcSession=null;}run.finishedAt=now().toISOString();save(run);application.recordSourceCheck(run);}
   return structuredClone(run);
  };
 }
 return operations;
}
