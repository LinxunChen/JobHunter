import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {startServer} from '../src/server.mjs';
import {fetchCcbPublic} from '../src/ccb-source.mjs';
import {discoveryDeadline,discoveryScope} from '../src/discovery-scope.mjs';
const index='https://gzw.beijing.gov.cn/yggq/gqzp/',url='https://mp.weixin.qq.com/s/current-test';
const at='2026-10-11T13:00:00Z';
const catalog=(title,article=url)=>`<div class="public_list_team"><ul><li><a href="${article}" title="${title}">${title}</a><span>2026-10-10</span></li></ul></div><script>currentPage=0;countPage=1;</script>`;

test('发现入口截止取正文而非栏目日期，年/月/日与跨北京零点、冲突及非法日期均受保护',()=>{
 assert.equal(discoveryDeadline('报名截止时间\n2026年10月7日',at).status,'expired');
 assert.equal(discoveryDeadline('报名时间：2026年10月1日9:00至2026年10月20日17:00',at).day,'2026-10-20');
 assert.equal(discoveryDeadline('报名截止日期：2026-10-11','2026-10-11T16:01:00Z').status,'expired');
 for(const text of ['栏目日期2026-10-20','截止2026年2月30日','截止2026-10-20\n截止2026-11-20'])assert.equal(discoveryDeadline(text,at).status,'unknown');
});

test('当前北京单岗可加工，混合中的本岗地点未知、非技术、过期和图片缺正文不调用模型',async t=>{
 let calls=0,body='',selectedUrl=url,title='算法工程师社会招聘';
 const app=createApplication({databasePath:':memory:',now:()=>new Date(at),matchingProcessor:null,careerSource:null,announcementProcessor:{process:async()=>{calls++;throw Error('仅 eligible fixture 可到模型边界');}},sasacFetch:async request=>new Response(request===index?catalog(title,selectedUrl):`<div id="js_content">${body}</div>`)});t.after(()=>app.close());
 const cases=[['报名截止时间：2026年10月7日\n工作地点：北京','scope_excluded'],['岗位名称：算法工程师\n报名截止时间：2026年12月31日\n工作地点：上海','scope_excluded'],['岗位名称：算法工程师\n报名截止时间：2026年12月31日','saved'],['岗位名称：算法工程师\n岗位名称：客户经理\n工作地点：北京\n报名截止时间：2026年12月31日','saved'],['<img src="sample">来源：模拟北京公司','saved']];
 for(const [i,[value,status]] of cases.entries()){selectedUrl=url+'-'+i;body=value;const run=await app.checkSasacSource({articleUrls:[selectedUrl]});assert.equal(run.details[0].processingStatus,status);assert.ok(run.details[0].announcementId);assert.equal(app.getAnnouncement(run.details[0].announcementId).status,'saved');assert.equal(calls,0);}
 // Use a new URL scope: expired original must remain excluded in future runs.
 assert.equal(discoveryScope({text:'岗位名称：算法工程师\n报名截止时间：2026年12月31日\n工作地点：北京市海淀区',title,at}).status,'eligible');
 assert.equal(app.getModelBudgetStatus().limit,50);assert.equal(app.getModelBudgetStatus().used,0);
});

test('已保存的过期公众号正文从候选队列排除，正文缺口不冒充访问验证，重启幂等',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jh-discovery-'));let requests=0;
 const options={databasePath:join(root,'db.sqlite'),now:()=>new Date(at),matchingProcessor:null,announcementProcessor:null,careerSource:null,sasacFetch:async request=>{if(request===index)return new Response(catalog('社会公开招聘'));requests++;throw Error('过期文章不得再次请求');}};
 let app=createApplication(options);t.after(()=>{app.close();rmSync(root,{recursive:true,force:true});});
 await app.createAnnouncement({title:'本人取得的完整旧正文',originalText:'工作地点：北京\n报名截止时间：2026年10月7日',sourceUrl:url,evidenceUse:'historical',sourceIdentityContext:{sourceId:'beijing-sasac',externalId:url,observedAt:at}});
 const run=await app.checkSasacSource({articleUrls:[url]});assert.equal(run.status,'success');assert.equal(run.details[0].acquisition,'not_requested');assert.equal(requests,0);
 assert.equal(app.listSourceCandidates('beijing-sasac')[0].status,'excluded');assert.equal(app.listRecruitmentReviewPlan().some(x=>x.sourceId==='beijing-sasac'&&x.due),false);
 app.close();app=createApplication(options);assert.equal(app.getSourceSettings('beijing-sasac').articleUrls.length,0);assert.equal(app.listSourceCandidates('beijing-sasac')[0].status,'excluded');
});

test('建行真实传输入口保持一次检查的匿名列表上下文，两轮会话隔离及删除，客服即使提AI也不调模型',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jh-ccb-context-')),bin=join(root,'bin'),log=join(root,'requests.jsonl');mkdirSync(bin);
 const executable=join(bin,'curl'),priorPath=process.env.PATH;
 // External service fixture: detail rejects a fresh session, accepts the
 // anonymous session previously established by a public listing request.
 const fixture=`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),value=x=>args[args.indexOf(x)+1],u=new URL(args.at(-1)),code=u.searchParams.get('TXCODE'),jar=value('--cookie-jar');
let context=fs.existsSync(jar),raw;
if(code==='NHR104'){fs.writeFileSync(jar,'anonymous public-list context');raw={SUCCESS:'true',TOTAL_PAGE:'1',TOTAL_REC:'1',planPostList:[{planId:'p2026',planPost:'customer1',orgId:'ccb',secondOrgId:'beijing',planType:'SH',planPostName:'客服代表岗',workPlace:'北京',planStatus:'1'}]};}
else if(code==='NHR107')raw=context?{SUCCESS:'true',planPostName:'客服代表岗',orgName:'中国建设银行',secondOrgName:'北京中心',cityName:'北京',planName:'2026社会招聘',planStatus:'1',endTime:'2026-12-31',postDesc:'依托大模型提供业务咨询、投诉处理等客户服务',PostRequest:'本科及一年客户服务经验'}:{SUCCESS:'false',ERRORMSG:'请重新登录'};
else if(code==='NHR105')raw={SUCCESS:'true',TOTAL_PAGE:'0',TOTAL_REC:'0',annoList:[]};
else raw=u.pathname.endsWith('job_detail.js')?"mapping: { planStatus: { 1: '正在报名', 2: '报名结束' } }":u.pathname.endsWith('job_detail.html')?'<script src="/cn/job/v3/js/job_detail.js"></script>':'<script src="/cn/job/v3/js/job_list.js"></script>社会招聘';
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({code,jar,context})+'\\n');fs.writeFileSync(value('--output'),typeof raw==='string'?raw:JSON.stringify(raw));process.stdout.write('200');`;
 writeFileSync(executable,fixture,{mode:0o700});process.env.PATH=bin+':'+priorPath;
 const app=createApplication({databasePath:':memory:',now:()=>new Date(at),careerSource:null,matchingProcessor:null,announcementProcessor:{process:async()=>{throw Error('客服不得调模型');}}});
 t.after(()=>{process.env.PATH=priorPath;app.close();rmSync(root,{recursive:true,force:true});});
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const fresh=await fetchCcbPublic('https://job.ccb.com/tran/WCCMainPlatV5?TXCODE=NHR107');assert.equal((await fresh.json()).SUCCESS,'false');
 for(let i=0;i<2;i++){const result=await fetch(base+'/api/sources/ccb/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({postIds:['p2026:customer1:beijing']})});assert.equal(result.status,200);const run=await result.json();assert.equal(run.details[0].validated,true);assert.match(run.details[0].processingSkipped,/非技术/);assert.ok(run.details[0].announcementId);assert.equal(app.listJobs().length,0);}
 const records=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),detailRecords=records.filter(x=>x.code==='NHR107');assert.deepEqual(detailRecords.map(x=>x.context),[false,true,true]);assert.equal(new Set(detailRecords.map(x=>x.jar)).size,3);assert.ok(records.every(x=>!existsSync(dirname(x.jar))));assert.equal(app.getModelBudgetStatus().used,0);
});

test('真实公开图片保存原图和置信度；低置信截止标题不升级自动排除或加工，队列每周复查', {skip:process.platform!=='darwin'},async t=>{
 const imageUrl='https://mmbiz.qpic.cn/mmbiz_jpg/controlled-fixture/640?wx_fmt=jpeg',bytes=readFileSync(new URL('./fixtures/beijing-sasac/expired-deadline-image.jpg',import.meta.url));let imageReads=0,calls=0;
 const app=createApplication({databasePath:':memory:',now:()=>new Date(at),careerSource:null,matchingProcessor:null,announcementProcessor:{process:async()=>{calls++;throw Error('已截止图片不应加工');}},sasacFetch:async request=>{
  if(request===index)return new Response(catalog('北京银行总行中层管理人员公开招聘正式启动'));
  if(request===url)return new Response(`<div id="js_content"><img data-src="${imageUrl}">来源：北京银行</div>`);
  assert.equal(request,imageUrl);imageReads++;return new Response(bytes);
 }});t.after(()=>app.close());
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const request=()=>fetch(base+'/api/sources/sasac/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({articleUrls:[url]})}).then(x=>x.json());
 const run=await request();assert.equal(run.status,'success',JSON.stringify(run.gaps));assert.equal(run.details[0].processingDecision.deadline.day,null);assert.equal(run.details[0].processingStatus,'saved');assert.equal(calls,0);assert.equal(app.getModelBudgetStatus().used,0);
 const ann=app.getAnnouncement(run.details[0].announcementId);assert.equal(ann.evidenceUse,'unverified');assert.equal(ann.sourceProcessingDecision.status,'needs_material');assert.equal(ann.attachments[0].reader,'macOS Vision OCR');assert.ok(ann.attachments[0].segments.every(x=>Number.isFinite(x.confidence)));assert.match(ann.attachments[0].text,/2026年10月7日/);assert.deepEqual(app.getAnnouncementAttachment(ann.id,'attachment-1'),bytes);
 assert.equal(app.listSourceCandidates('beijing-sasac')[0].status,'pending');assert.equal(app.listRecruitmentReviewPlan().find(x=>x.sourceId==='beijing-sasac').due,false);const again=await request();assert.equal(again.details[0].cached,true);assert.equal(imageReads,2);assert.equal(app.listAnnouncements().length,1);
});

test('HTTP200微信防引用占位图不能作为已读招聘图片', {skip:process.platform!=='darwin'},async()=>{
 const {readImage}=await import('../src/image-reader.mjs');
 const bytes=readFileSync(new URL('./fixtures/beijing-sasac/anti-hotlink-placeholder.png',import.meta.url));
 await assert.rejects(()=>readImage(bytes),/平台引用提示.*未取得招聘原图/);
});
