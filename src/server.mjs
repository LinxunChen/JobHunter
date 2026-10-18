import {settingsPage,settingsFromForm,profileAnalysisSummary,identifiedFactRows} from './settings-web.mjs';
import {createHash} from 'node:crypto';
import {expandedSources} from './expanded-source-catalog.mjs';
import {historyPage as checksHistoryPage} from './history-web.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sourceConsolePage,operationalChangesPage} from './source-console-web.mjs';
import {qualificationProfilePage,qualificationFromForm} from './qualification-web.mjs';
import { sourceCapabilities,sourceAliases } from './source-capabilities.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ValidationError } from './application.mjs';
import { createProductionApplication } from './production-bootstrap.mjs';
import { scheduledRunsPage } from './scheduled-run-web.mjs';
import { notificationsPage } from './notification-web.mjs';
import { sasacSourcesPage } from './sasac-web.mjs';
import { bocSourcesPage } from './boc-web.mjs';
import { ccbSourcesPage } from './ccb-web.mjs';
import { backupsPage } from './backup-web.mjs';
import { cmriSourcePage } from './cmri-source-web.mjs';
import { icbcSourcePage } from './icbc-source-web.mjs';
import { sourcesPage } from './source-web.mjs';
import { careerPage } from './matching-web.mjs';
import { historyPage } from './identity-web.mjs';
import { correctionFromForm } from './corrections-web.mjs';
import { newAnnouncementPage, announcementFromForm, announcementsPage, announcementPage } from './announcement-web.mjs';
import { jobsPage, jobPage, newJobPage, jobFromForm, page, escapeHtml, applicationsPage, followedPage } from './web.mjs';

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new ValidationError('补录内容超过12MiB，请缩小正文或附件');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sourceInput(request,json,fromForm=()=>({})) {
  const type=(request.headers['content-type']??'').split(';')[0];
  if(type!==(json?'application/json':'application/x-www-form-urlencoded'))throw new ValidationError('请求内容类型无效');
  const raw=await body(request);let input;
  try{input=json?JSON.parse(raw):fromForm(new URLSearchParams(raw));}catch{throw new ValidationError('来源请求JSON无效');}
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('来源请求须为对象');
  return input;
}

export async function startServer({ app, port = 3210 } = {}) {
  if (!app) throw new Error('需要共用应用入口');
  const server = createServer(async (request, response) => {
    const local = `http://127.0.0.1:${server.address().port}`;
    const hosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    const send = (status, content, json = false) => {
      response.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'" });
      response.end(json ? JSON.stringify(content) : content);
    };
    if (!hosts.includes(request.headers.host)) return send(403, page('拒绝访问', '<p>仅允许本机访问。</p>'));
    const url = new URL(request.url, local);
    const automatic=request.method==='POST'&&(/^(?:\/api)?\/sources\/[^/]+\/check$/.test(url.pathname)||['/runs','/api/runs'].includes(url.pathname));
    return app.withModelBatch(async()=>{
    try {
      if (request.method === 'POST' && app.verificationMode) throw new ValidationError('恢复核对模式只读，外部服务及写入均停用');
      if (request.method === 'POST' && request.headers.origin && ![local, local.replace('127.0.0.1', 'localhost')].includes(request.headers.origin)) return send(403, page('拒绝访问', '<p>不允许其他网站写入本机数据。</p>'));
      if (request.method === 'GET' && ['/assets/personal.js', '/assets/announcement.js', '/assets/jobs.css','/assets/sources.js','/assets/sources.css','/assets/settings.js'].includes(url.pathname)) {
        response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        return response.end(readFileSync(new URL('.' + url.pathname, import.meta.url), 'utf8'));
      }
      const rawHistory=url.pathname.match(/^\/api\/history\/([a-z_]+)\/([^/]+)\/raw$/);
      if(request.method==='GET'&&rawHistory) {
        const kind=rawHistory[1],id=decodeURIComponent(rawHistory[2]);
        if(!app.hasHistoryRecord(kind,id))return send(404,{error:'历史记录不存在'},true);
        if(app.databasePath===':memory:')return send(200,app.getHistoryRecord(kind,id),true);
        const child=spawn(app.historyPython,[fileURLToPath(new URL('./read-history.py',import.meta.url)),app.databasePath,kind,id],{stdio:['ignore','pipe','ignore']});
        child.on('exit',code=>{if(code!==0&&!response.writableFinished)response.destroy();});
        response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'});
        child.stdout.pipe(response);response.once('close',()=>{if(child.exitCode===null)child.kill('SIGTERM');});child.once('error',()=>response.destroy());
        return;
      }
      const checksHistoryRoute=url.pathname.match(/^\/api\/history\/([a-z_]+)$/);
      if(request.method==='GET'&&(checksHistoryRoute||url.pathname==='/history')) {
        const input={kind:checksHistoryRoute?.[1]??url.searchParams.get('kind')??'source_checks',sourceId:url.searchParams.get('sourceId')??undefined,cursor:url.searchParams.get('cursor')??undefined,limit:Number(url.searchParams.get('limit')??20)};
        const result=app.listHistoryPage(input);return send(200,checksHistoryRoute?result:checksHistoryPage(input,result),Boolean(checksHistoryRoute));
      }
      if(request.method==='GET'&&['/runs','/api/runs'].includes(url.pathname)){
        const history=app.listHistoryPage({kind:'scheduled_runs',cursor:url.searchParams.get('cursor')??undefined}),status=app.getScheduledStatus();
        return send(200,url.pathname.startsWith('/api/')?{...status,runs:history.items,pagination:{nextCursor:history.nextCursor,limit:history.limit}}:scheduledRunsPage(status,history.items,history),url.pathname.startsWith('/api/'));
      }
      const runRoute=url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if(request.method==='GET'&&runRoute){const run=app.getScheduledRun(decodeURIComponent(runRoute[1]));return send(run?200:404,run??{error:'周期不存在'},true);}
      if(request.method==='POST'&&['/runs','/api/runs'].includes(url.pathname)){
        const json=url.pathname.startsWith('/api/'),type=(request.headers['content-type']??'').split(';')[0];if(type!==(json?'application/json':'application/x-www-form-urlencoded'))throw new ValidationError('请求内容类型无效');
        const raw=await body(request);if(json){let input;try{input=JSON.parse(raw);}catch{throw new ValidationError('周期JSON无效');}if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new ValidationError('周期操作仅接受空对象，不接受凭据或指定旧计划');}
        const run=await app.runScheduledCycle({trigger:'manual'});if(json)return send(200,run,true);response.writeHead(303,{Location:'/runs'});return response.end();
      }
      if(request.method==='GET'&&['/notification-preview','/api/notification-preview'].includes(url.pathname)){
        const preview=app.getNotificationPreview(url.searchParams.get('id'));
        return send(200,url.pathname.startsWith('/api/')?preview:page('消息预览',`<p><a href="/notifications">通知台账</a> · 只读预览，不创建通知事件或发送尝试。</p><div class="notification-preview">${preview.htmlContent??`<pre>${escapeHtml(preview.content)}</pre>`}</div><details><summary>纯文本版本</summary><pre>${escapeHtml(preview.content)}</pre></details>`),url.pathname.startsWith('/api/'));
      }
      if(request.method==='GET'&&['/notifications','/api/notifications'].includes(url.pathname))return send(200,url.pathname.startsWith('/api/')?app.getNotificationLedger({cursor:url.searchParams.get('cursor')??undefined}):notificationsPage(app.getNotificationLedger({cursor:url.searchParams.get('cursor')??undefined})),url.pathname.startsWith('/api/'));
      const notificationAction=url.pathname.match(/^\/(api\/)?notifications\/([^/]+)\/(send|query)$/);
      if(request.method==='POST'&&(notificationAction||['/notification-verifications','/api/notification-verifications','/api/notifications/recover'].includes(url.pathname))){
        const json=url.pathname.startsWith('/api/'),type=(request.headers['content-type']??'').split(';')[0];if(type!==(json?'application/json':'application/x-www-form-urlencoded'))throw new ValidationError('请求内容类型无效');
        const raw=await body(request);if(json){let input;try{input=JSON.parse(raw);}catch{throw new ValidationError('通知JSON无效');}if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new ValidationError('通知操作仅接受空对象，不接受凭据或自定义正文');}
        const result=notificationAction?(notificationAction[3]==='send'?await app.sendNotification(decodeURIComponent(notificationAction[2])):await app.queryNotificationResult(decodeURIComponent(notificationAction[2]))):url.pathname.endsWith('/recover')?app.recoverNotificationAttempts():app.createNotificationVerification();
        if(json)return send(200,result,true);response.writeHead(303,{Location:'/notifications'});return response.end();
      }
      if(request.method==='GET'&&url.pathname==='/api/today')return send(200,app.getToday(),true);
      if(request.method==='GET'&&url.pathname==='/today'){response.writeHead(302,{Location:'/jobs'});return response.end();}
      if(request.method==='GET'&&url.pathname==='/api/action-events')return send(200,app.getActionEvents(),true);
      if(request.method==='GET'&&url.pathname==='/api/notification-drafts')return send(200,app.listNotificationDrafts(),true);
      if(request.method==='POST'&&['/daily-actions/prepare','/api/daily-actions/prepare'].includes(url.pathname)){
        const json=url.pathname.startsWith('/api/'),type=(request.headers['content-type']??'').split(';')[0];if(type!==(json?'application/json':'application/x-www-form-urlencoded'))throw new ValidationError('请求内容类型无效');
        const raw=await body(request);let input;try{input=json?JSON.parse(raw):{};}catch{throw new ValidationError('行动内容JSON无效');}if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('行动参数无效');
        const result=app.prepareDailyActions();if(json)return send(200,result,true);response.writeHead(303,{Location:'/today'});return response.end();
      }
      if (request.method === 'GET' && ['/backups', '/api/backups'].includes(url.pathname)) return send(200, url.pathname.startsWith('/api/') ? app.listBackups() : backupsPage(app.listBackups()), url.pathname.startsWith('/api/'));
      const backupAction = url.pathname.match(/^\/(api\/)?backups\/([^/]+)\/(verify|restore)$/);
      if (request.method === 'POST' && (['/backups', '/api/backups'].includes(url.pathname) || backupAction)) {
        const json = url.pathname.startsWith('/api/'); const type = (request.headers['content-type'] ?? '').split(';')[0];
        if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        const raw = await body(request); let input;
        if (json) { try { input = JSON.parse(raw); } catch { throw new ValidationError('JSON内容无效'); } }
        else input = Object.fromEntries(new URLSearchParams(raw));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('备份参数无效');
        const result = backupAction ? (backupAction[3] === 'verify' ? await app.verifyBackup(decodeURIComponent(backupAction[2])) : await app.restoreBackup(decodeURIComponent(backupAction[2]), input)) : await app.createBackup(input);
        if (json) return send(backupAction?.[3] === 'verify' ? 200 : result.status === 'failed' ? 503 : 201, result, true);
        if (backupAction?.[3] === 'restore') return send(200, page('恢复核对', `<p>新目录已核验，原路径保持可读；恢复目录默认只读并停用外部服务。</p><pre>${escapeHtml(result.databasePath)}</pre><p>以JOBHUNTER_DB指定此路径并在另一本机端口启动，检查岗位库、我的投递及原文附件。凭据需另行配置，切换正式数据另获授权。</p>`));
        if (result.status === 'failed' || result.valid === false) return send(503, page('备份未通过核验', `<p>${escapeHtml(result.gaps?.join('；'))}</p>`));
        response.writeHead(303, { Location: '/backups' }); return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/announcements/new') return send(200, newAnnouncementPage());
      if (request.method === 'GET' && ['/announcements', '/api/announcements'].includes(url.pathname)) return send(200, url.pathname.startsWith('/api/') ? app.listAnnouncements() : announcementsPage(app.listAnnouncements()), url.pathname.startsWith('/api/'));
      if (request.method === 'POST' && ['/announcements', '/api/announcements'].includes(url.pathname)) {
        const json = url.pathname.startsWith('/api/');
        const type = (request.headers['content-type'] ?? '').split(';')[0];
        if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        const raw = await body(request);
        let input;
        if (json) { try { input = JSON.parse(raw); } catch { throw new ValidationError('JSON内容无效'); } }
        else input = announcementFromForm(new URLSearchParams(raw));
        const saved = await app.createAnnouncement(input);
        if (json) return send(201, saved, true);
        response.writeHead(303, { Location: `/announcements/${encodeURIComponent(saved.id)}` });
        return response.end();
      }
      const announcementRoute = url.pathname.match(/^\/(api\/)?announcements\/([^/]+)(\/process)?$/);
      const attachmentRoute = url.pathname.match(/^\/announcements\/([^/]+)\/attachments\/([^/]+)$/);
      if (request.method === 'GET' && attachmentRoute) {
        const id = decodeURIComponent(attachmentRoute[1]);
        const attachmentId = decodeURIComponent(attachmentRoute[2]);
        const content = app.getAnnouncementAttachment(id, attachmentId);
        if (!content) return send(404, page('附件不存在', '<p>该附件原始文件未取得。</p>'));
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="original-attachment"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        return response.end(content);
      }
      if (announcementRoute && request.method === 'POST' && announcementRoute[3]) {
        const item = await app.processAnnouncement(decodeURIComponent(announcementRoute[2]));
        if (announcementRoute[1]) return send(200, item, true);
        response.writeHead(303, { Location: `/announcements/${encodeURIComponent(item.id)}` });
        return response.end();
      }
      if (announcementRoute && request.method === 'GET' && !announcementRoute[3]) {
        const item = app.getAnnouncement(decodeURIComponent(announcementRoute[2]));
        if (!item) return send(404, announcementRoute[1] ? { error: '公告不存在' } : page('公告不存在', '<p>未找到公告。</p>'), Boolean(announcementRoute[1]));
        return send(200, announcementRoute[1] ? item : announcementPage(item, item.jobIds.map(id => app.getJob(id))), Boolean(announcementRoute[1]));
      }
      if (request.method === 'GET' && ['/sources/sasac','/api/sources/sasac'].includes(url.pathname)) {const json=url.pathname.startsWith('/api/'),coverage=app.getSasacCoverage();return send(200,json?coverage:sasacSourcesPage(coverage),json);}
      if (request.method === 'GET' && url.pathname === '/sources/sasac/manual') {const sourceUrl=url.searchParams.get('url')??'',item=app.getSasacCoverage().latest?.listings.find(x=>x.url===sourceUrl);return send(200,newAnnouncementPage({manual:true,sourceUrl,title:item?.title??''}));}
      if (request.method === 'POST' && ['/sources/sasac/check','/api/sources/sasac/check','/sources/sasac/manual','/api/sources/sasac/manual'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/'),manual=url.pathname.endsWith('/manual');
        const input=await sourceInput(request,json,form=>manual?{...announcementFromForm(form),obtainedAt:form.get('obtainedAt')}:{articleUrls:(form.get('articleUrls')??'').split(/\s+/).filter(Boolean)});
        if(!input||typeof input!=='object'||Array.isArray(input)||('trigger' in input&&input.trigger!=='manual')||input.scheduledFor!=null)throw new ValidationError('Web来源检查仅允许手动触发');
        const saved=manual?await app.importSasacManual(input):await app.checkSasacSource({...input,trigger:'manual',scheduledFor:null});if(json)return send(manual?201:200,saved,true);response.writeHead(303,{Location:manual?'/announcements/'+encodeURIComponent(saved.id):'/sources/sasac'});return response.end();
      }
      if(request.method==='GET'&&['/sources/cmri','/api/sources/cmri'].includes(url.pathname)){const json=url.pathname.startsWith('/api/'),coverage=app.getCmriCoverage();return send(200,json?coverage:cmriSourcePage(coverage),json);}
      if(request.method==='POST'&&['/sources/cmri/check','/api/sources/cmri/check'].includes(url.pathname)){
        const json=url.pathname.startsWith('/api/');
        const input=await sourceInput(request,json,form=>({postIds:(form.get('postIds')??'').split(/[\s,，]+/).filter(Boolean)}));
        const run=await app.checkCmriSource({postIds:json?input.postIds:input.postIds?.length?input.postIds:undefined,pageSize:input.pageSize,trigger:'manual'});if(json)return send(200,run,true);response.writeHead(303,{Location:'/sources/cmri'});return response.end();
      }
      if (request.method === 'GET' && ['/sources/ccb', '/api/sources/ccb'].includes(url.pathname)) {
        const coverage = app.getCcbSourceCoverage();
        return send(200, url.pathname.startsWith('/api/') ? coverage : ccbSourcesPage(coverage), url.pathname.startsWith('/api/'));
      }
      if (request.method === 'POST' && ['/sources/ccb/check', '/api/sources/ccb/check'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');
        const input=await sourceInput(request,json,form=>({postIds:(form.get('postIds')??'').split(/[\s,]+/).filter(Boolean),announcementIds:(form.get('announcementIds')??'').split(/[\s,]+/).filter(Boolean)}));
        if (!input || typeof input !== 'object' || Array.isArray(input) || ('trigger' in input && input.trigger !== 'manual') || input.scheduledFor != null) throw new ValidationError('Web来源检查仅允许手动触发');
        const run = await app.checkCcbSource({ ...input, trigger: 'manual', scheduledFor: null });
        if (json) return send(200, run, true);
        response.writeHead(303, { Location: '/sources/ccb' }); return response.end();
      }
      if (request.method === 'GET' && ['/sources/icbc','/api/sources/icbc'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');const coverage=app.getIcbcCoverage();return send(200,json?coverage:icbcSourcePage(coverage),json);
      }
      if (request.method === 'POST' && ['/sources/icbc/check','/api/sources/icbc/check'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');
        const input=await sourceInput(request,json,form=>({postIds:(form.get('postIds')??'').split(/[\s,，]+/).filter(Boolean)}));
        const run=await app.checkIcbcSource({postIds:json?input.postIds:input.postIds?.length?input.postIds:undefined,pageSize:input.pageSize,trigger:'manual'});
        if(json)return send(200,run,true);response.writeHead(303,{Location:'/sources/icbc'});return response.end();
      }
      if (request.method === 'GET' && ['/sources/boc', '/api/sources/boc'].includes(url.pathname)) {
        const coverage = app.getBocSourceCoverage();
        return send(200, url.pathname.startsWith('/api/') ? coverage : bocSourcesPage(coverage), url.pathname.startsWith('/api/'));
      }
      if (request.method === 'POST' && ['/sources/boc/check', '/api/sources/boc/check'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');
        const input=await sourceInput(request,json,form=>{
          const announcementUrl=form.get('announcementUrl')?.trim(),title=form.get('targetTitle')?.trim();
          return {postIds:(form.get('postIds')??'').split(/\s+/).filter(Boolean),announcementUrls:announcementUrl?[announcementUrl]:[],...(title?{announcementScopes:{[announcementUrl]:{targetJob:{title,recruitmentUnit:form.get('targetUnit')?.trim()||null,department:form.get('targetDepartment')?.trim()||null,batch:form.get('targetBatch')?.trim()||null}}}}:{})};
        });
        const run = await app.checkBocSource({...input,trigger:'manual',scheduledFor:null});
        if (json) return send(200, run, true);
        response.writeHead(303, { Location: '/sources/boc' }); return response.end();
      }
      const monitoringRoute=url.pathname.match(/^\/(api\/)?monitoring-objects(?:\/([^/]+))?$/);
      if(monitoringRoute&&request.method==='GET'&&monitoringRoute[1]&&!monitoringRoute[2])return send(200,app.listMonitoringObjects(),true);
      if(monitoringRoute&&request.method==='POST') {
        const json=Boolean(monitoringRoute[1]),input=await sourceInput(request,json,form=>Object.fromEntries(['name','officialUrl','note','monitoringStatus'].filter(field=>form.has(field)).map(field=>[field,form.get(field)])));
        const saved=monitoringRoute[2]?app.updateMonitoringObject(decodeURIComponent(monitoringRoute[2]),input):app.createMonitoringObject(input);
        if(json)return send(monitoringRoute[2]?200:201,saved,true);
        response.writeHead(303,{Location:'/sources'});return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/api/sources') return send(200, app.getSourcesOverview(), true);
      if (request.method === 'GET' && url.pathname === '/api/source-health-events') return send(200, app.listSourceHealthEvents(), true);
      const settingsRoute=url.pathname.match(/^\/(api\/)?sources\/([a-z][a-z0-9-]+)\/settings$/);
      if(settingsRoute&&sourceAliases[settingsRoute[2]]&&request.method==='GET')return send(200,app.getSourceSettings(sourceAliases[settingsRoute[2]]),true);
      if(settingsRoute&&sourceAliases[settingsRoute[2]]&&request.method==='POST'){
        const json=Boolean(settingsRoute[1]),id=sourceAliases[settingsRoute[2]],capability=sourceCapabilities[id];
        const input=await sourceInput(request,json,form=>Object.fromEntries([capability.field,...(capability.urls?[capability.urls]:[])].map(field=>[field,(form.get(field)??'').split(/[\s,，]+/).filter(Boolean)])));
        const saved=app.setSourceSettings(id,input);if(json)return send(200,saved,true);response.writeHead(303,{Location:'/sources'});return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/sources/efunds') return send(200, sourcesPage(app.getSourceCoverage('efunds-social')));
      const expandedRoute=url.pathname.match(/^\/(api\/)?sources\/([a-z][a-z0-9-]+)$/);
      if(expandedRoute&&request.method==='GET'&&expandedSources.some(source=>source.id===expandedRoute[2])&&app.getExpandedSourceCoverage){
        const coverage=app.getExpandedSourceCoverage(expandedRoute[2]),source=app.getSourcesOverview().sources.find(source=>source.id===coverage.sourceId);
        if(!source)return send(404,{error:'来源未接入'},true);
        return send(200,expandedRoute[1]?coverage:page(source.name,`<p><a href="/sources">← 来源与设置</a></p><section class="panel"><h2>采集范围</h2><p>${escapeHtml(source.scope)}</p><p>${coverage.latest?escapeHtml(coverage.latest.status)+' · '+escapeHtml(coverage.latest.checkedAt)+' · 公开线索 '+coverage.latest.listCount+' 条':'尚无检查记录'}</p><p>${escapeHtml(coverage.latest?.error??'')}</p><ul>${(coverage.latest?.gaps??[]).map(gap=>`<li>${escapeHtml(gap)}</li>`).join('')}</ul><p>公开列示与待加工线索不代表本人符合或当前开放。手动检查请返回来源与设置。</p></section><details><summary>原文与检查历史</summary><pre>${escapeHtml(JSON.stringify(coverage.history,null,2))}</pre></details>`),Boolean(expandedRoute[1]));
      }
      if(['/settings','/api/settings'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');
        if(request.method==='GET') {
          const metadata=app.listCareerProfiles()[0],profile=metadata?app.getCareerProfile(metadata.id):null;
          return send(200,json?{...app.getLocalSettings(),profileAnalysis:profileAnalysisSummary(app.getProfileAnalysis()),identifiedFacts:identifiedFactRows(app.getQualificationProfile(),app.getProfileAnalysis()),qualificationStale:Boolean(app.getQualificationProfile()?.stale)}:settingsPage(app.getLocalSettings(),profile,app.getQualificationProfile(),app.listQualificationProfiles(),url.searchParams.get('saved')==='1'?'设置已保存':'',app.getProfileAnalysis()),json);
        }
        if(request.method==='POST') {
          const saved=app.saveSettings(await sourceInput(request,json,settingsFromForm));
          if(json)return send(200,{...saved.settings,profileAnalysis:profileAnalysisSummary(app.getProfileAnalysis()),identifiedFacts:identifiedFactRows(app.getQualificationProfile(),app.getProfileAnalysis()),qualificationStale:Boolean(app.getQualificationProfile()?.stale)},true);
          response.writeHead(303,{Location:'/settings?saved=1'});return response.end();
        }
      }
      if(request.method==='POST'&&['/settings/profile/retry','/api/profile-analysis/retry'].includes(url.pathname)){
        const json=url.pathname.startsWith('/api/'),input=await sourceInput(request,json);
        if(Object.keys(input).length)throw new ValidationError('重试仅接受空对象');
        const profile=app.listCareerProfiles()[0];if(!profile)throw new ValidationError('尚无个人资料');
        // Dispatch through the same bounded processor; never retry on GET.
        const result=await app.analyzeProfile(profile.id,{retry:true});
        if(json)return send(200,profileAnalysisSummary(result),true);
        response.writeHead(303,{Location:'/settings'});return response.end();
      }
      if(request.method==='POST'&&url.pathname==='/settings/profile') {
        const input=await sourceInput(request,false,form=>({text:form.get('text')}));
        if(typeof input.text!=='string'||!input.text.trim())throw new ValidationError('职业资料不能为空');
        app.saveCareerProfile({...input,sourceId:'manual',version:'manual-'+createHash('sha256').update(input.text).digest('hex').slice(0,16)});
        response.writeHead(303,{Location:'/settings?saved=1#personal-profile'});return response.end();
      }
      if(request.method==='GET'&&url.pathname==='/sources')return send(200,sourceConsolePage(app.getOperationsOverview(),Object.fromEntries(url.searchParams),Object.fromEntries(Object.values(sourceAliases).map(id=>[id,app.getSourceSettings(id)])),app.listSourceCheckTasks()));
      if(request.method==='GET'&&url.pathname==='/api/sources/efunds')return send(200,app.getSourceCoverage('efunds-social'),true);
      if(request.method==='GET'&&url.pathname==='/api/operations/progress')return send(200,app.getOperationsProgress(),true);
      if(request.method==='GET'&&url.pathname==='/api/operations')return send(200,app.getOperationsOverview(),true);
      if(request.method==='GET'&&['/sources/changes','/api/job-changes'].includes(url.pathname)) {
        const overview=app.getOperationsOverview(),date=url.searchParams.get('date')??overview.date,kind=url.searchParams.get('kind')??undefined,period=url.searchParams.get('period')??'day',items=app.getOperationalChanges({date,kind,period});
        return send(200,url.pathname.startsWith('/api/')?items:operationalChangesPage(overview,items,kind,date,period),url.pathname.startsWith('/api/'));
      }
      if(request.method==='POST'&&url.pathname==='/api/source-checks')return send(202,app.startSourceCheck(await sourceInput(request,true)),true);
      const resumeTaskRoute=url.pathname.match(/^\/api\/source-checks\/([^/]+)\/resume$/);
      if(request.method==='POST'&&resumeTaskRoute){const input=await sourceInput(request,true);if(Object.keys(input).length)throw new ValidationError('继续检查仅接受空对象');return send(202,app.resumeSourceCheck(decodeURIComponent(resumeTaskRoute[1])),true);}
      const checkTaskRoute=url.pathname.match(/^\/api\/source-checks\/([^/]+)$/);
      if(request.method==='GET'&&checkTaskRoute){const task=app.getSourceCheckTask(decodeURIComponent(checkTaskRoute[1]));return send(task?200:404,task??{error:'检查任务不存在'},true);}
      const discoveryRoute=url.pathname.match(/^\/api\/discovery\/([^/]+)$/);
      if(request.method==='POST'&&discoveryRoute){const input=await sourceInput(request,true);if(Object.keys(input).some(key=>key!=='enabled'))throw new ValidationError('发现入口参数无效');return send(200,app.setDiscoveryMonitoring(decodeURIComponent(discoveryRoute[1]),input.enabled),true);}
      if (request.method === 'POST' && ['/sources/efunds/check', '/api/sources/efunds/check'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');
        const input=await sourceInput(request,json);
        const run = await app.checkEfundsSource({ postIds: input.postIds, trigger: 'manual' });
        if (json) return send(200, run, true);
        response.writeHead(303, { Location: '/sources' });
        return response.end();
      }
      const correctionRoute = url.pathname.match(/^\/(api\/)?jobs\/([^/]+)\/corrections$/);
      const linkRoute = url.pathname.match(/^\/(api\/)?applications\/([^/]+)\/links$/);
      if ((correctionRoute || linkRoute) && ['GET', 'POST'].includes(request.method)) {
        const route = correctionRoute ?? linkRoute;
        const id = decodeURIComponent(route[2]);
        const json = Boolean(route[1]);
        if (request.method === 'GET') return send(200, correctionRoute ? app.listJobCorrections(id) : app.getApplicationLinks(id), true);
        const type = (request.headers['content-type'] ?? '').split(';')[0];
        if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        const raw = await body(request);
        let input;
        if (json) { try { input = JSON.parse(raw); } catch { throw new ValidationError('JSON内容无效'); } }
        else if (correctionRoute) {
          const job = app.getJob(id);
          if (!job) throw new ValidationError('岗位不存在');
          input = correctionFromForm(new URLSearchParams(raw), job);
        } else input = Object.fromEntries(new URLSearchParams(raw));
        const result = correctionRoute ? app.correctJob(id, input) : app.linkApplication(id, input);
        if (json) return send(200, result, true);
        response.writeHead(303, { Location: correctionRoute ? `/jobs/${encodeURIComponent(id)}` : '/applications' });
        return response.end();
      }
      if (['/qualification-profile','/api/qualification-profile'].includes(url.pathname)) {
        const json=url.pathname.startsWith('/api/');
        if(request.method==='GET')return send(200,json?(url.searchParams.get('history')==='1'?app.listQualificationProfiles():app.getQualificationProfile()):qualificationProfilePage(app.getQualificationProfile(),app.listQualificationProfiles()),json);
        if(request.method==='POST'){
          const input=await sourceInput(request,json,form=>qualificationFromForm(form,app.getQualificationProfile()));
          const profile=app.saveQualificationProfile(input);
          for(const job of app.listJobs())app.evaluateEligibility(job.id);
          if(json)return send(201,profile,true);
          response.writeHead(303,{Location:'/qualification-profile'});return response.end();
        }
      }
      if (['/career/refresh', '/api/career-refresh'].includes(url.pathname)) {
        const json = url.pathname.startsWith('/api/');
        if (request.method === 'GET' && json) return send(200, app.listCareerRefreshes(), true);
        if (request.method === 'POST') {
          const type = (request.headers['content-type'] ?? '').split(';')[0];
          if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
          const raw = await body(request); let input;
          try { input = json ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { throw new ValidationError('职业检查JSON无效'); }
          const result = await app.refreshCareerProfile(input);
          if (json) return send(200, result, true);
          response.writeHead(303, { Location: '/career' }); return response.end();
        }
      }
      if (request.method === 'GET' && ['/career', '/api/career-profiles'].includes(url.pathname)) return send(200, url.pathname.startsWith('/api/') ? app.listCareerProfiles() : careerPage(app.listCareerProfiles(), app.listCareerRefreshes()), url.pathname.startsWith('/api/'));
      const profileRoute = url.pathname.match(/^\/api\/career-profiles\/([^/]+)$/);
      if (request.method === 'GET' && profileRoute) { const profile = app.getCareerProfile(decodeURIComponent(profileRoute[1])); return send(profile ? 200 : 404, profile ?? { error: '档案不存在' }, true); }
      const matchingRoute = url.pathname.match(/^\/(api\/)?jobs\/([^/]+)\/match$/);
      if (request.method === 'GET' && matchingRoute && matchingRoute[1]) return send(200, url.searchParams.get('history') === '1' ? app.listMatches(decodeURIComponent(matchingRoute[2])) : app.getMatch(decodeURIComponent(matchingRoute[2])), true);
      if (request.method === 'POST' && (matchingRoute || ['/career', '/api/career-profiles'].includes(url.pathname))) {
        const json = url.pathname.startsWith('/api/');
        const type = (request.headers['content-type'] ?? '').split(';')[0];
        if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        const raw = await body(request); let input;
        try { input = json ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { throw new ValidationError('职业资料／匹配JSON无效'); }
        if (matchingRoute) {
          const result = await app.matchJob(decodeURIComponent(matchingRoute[2]), input);
          if (json) return send(200, result, true);
          response.writeHead(303, { Location: `/jobs/${encodeURIComponent(matchingRoute[2])}` }); return response.end();
        }
        const profile = app.saveCareerProfile(json ? input : { ...input, sourceId: 'manual' });
        if (json) { const { text, qualificationFacts, ...metadata } = profile; return send(201, metadata, true); }
        response.writeHead(303, { Location: '/career' }); return response.end();
      }
      const eligibilityRoute = url.pathname.match(/^\/(api\/)?jobs\/([^/]+)\/eligibility$/);
      if (eligibilityRoute && request.method === 'GET' && eligibilityRoute[1]) return send(200, url.searchParams.get('history') === '1' ? app.listEligibility(decodeURIComponent(eligibilityRoute[2])) : app.getEligibility(decodeURIComponent(eligibilityRoute[2])), true);
      if (eligibilityRoute && request.method === 'POST') {
        const json = Boolean(eligibilityRoute[1]);
        const type = (request.headers['content-type'] ?? '').split(';')[0];
        if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        const raw = await body(request);
        let input;
        try { input = json ? JSON.parse(raw) : (new URLSearchParams(raw).get('profile') ? { profile: JSON.parse(new URLSearchParams(raw).get('profile')) } : {}); } catch { throw new ValidationError('个人资格档案JSON无效'); }
        const result = app.evaluateEligibility(decodeURIComponent(eligibilityRoute[2]), input);
        if (json) return send(200, result, true);
        response.writeHead(303, { Location: `/jobs/${encodeURIComponent(eligibilityRoute[2])}` });
        return response.end();
      }
      const withLinks = application => ({ ...application, links: app.getApplicationLinks(application.id), priorCandidates: app.listApplications().filter(prior => prior.id !== application.id && prior.jobId !== application.jobId && prior.jobSnapshot.batch && application.jobSnapshot.batch && prior.jobSnapshot.batch !== application.jobSnapshot.batch && prior.jobSnapshot.title === application.jobSnapshot.title && prior.jobSnapshot.recruitmentUnit === application.jobSnapshot.recruitmentUnit && prior.jobSnapshot.department === application.jobSnapshot.department) });
      if (request.method === 'GET' && ['/followed', '/applications', '/api/followed', '/api/applied-jobs'].includes(url.pathname)) {
        const filters = Object.fromEntries(url.searchParams);
        const followed = ['/followed', '/api/followed'].includes(url.pathname);
        const jobs = app.listJobView(followed ? 'followed' : 'applied', filters);
        const json = url.pathname.startsWith('/api/');
        return send(200, json ? jobs : (followed ? followedPage(jobs, filters) : applicationsPage(jobs, filters)), json);
      }
      if (request.method === 'GET' && url.pathname === '/api/applications') return send(200, app.listApplications(), true);
      if (request.method === 'GET' && url.pathname === '/api/recruitment-review-plan') return send(200,app.listRecruitmentReviewPlan(),true);
      const recruitmentRoute=url.pathname.match(/^\/api\/jobs\/([^/]+)\/recruitment$/);
      if(request.method==='GET'&&recruitmentRoute)return send(200,app.getRecruitmentState(decodeURIComponent(recruitmentRoute[1])),true);
      const reminderRoute=url.pathname.match(/^\/(api\/)?jobs\/([^/]+)\/reminder-date$/);
      if(request.method==='POST'&&reminderRoute){
        const json=Boolean(reminderRoute[1]),type=(request.headers['content-type']??'').split(';')[0];
        if(type!==(json?'application/json':'application/x-www-form-urlencoded'))throw new ValidationError('请求内容类型无效');
        const raw=await body(request);let input;try{input=json?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));}catch{throw new ValidationError('待办JSON无效');}
        const result=app.setJobReminderDate(decodeURIComponent(reminderRoute[2]),input);if(json)return send(200,result,true);
        response.writeHead(303,{Location:'/jobs/'+encodeURIComponent(reminderRoute[2])});return response.end();
      }
      const personalRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(personal|applied)$/);
      const applicationRoute = url.pathname.match(/^\/(api\/)?applications\/([^/]+)(\/events)?$/);
      if (request.method === 'GET' && personalRoute) return send(200, app.getPersonalState(decodeURIComponent(personalRoute[1])), true);
      if (request.method === 'GET' && applicationRoute && applicationRoute[1] && !applicationRoute[3]) {
        const application = app.getApplication(decodeURIComponent(applicationRoute[2]));
        return send(application ? 200 : 404, application ?? { error: '投递记录不存在' }, true);
      }
      if (request.method === 'POST' && (personalRoute || applicationRoute)) {
        const json = url.pathname.startsWith('/api/');
        const contentType = (request.headers['content-type'] ?? '').split(';')[0];
        if (contentType !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        const raw = await body(request);
        let input;
        if (json) { try { input = JSON.parse(raw); } catch { throw new ValidationError('JSON内容无效'); } }
        else {
          input = Object.fromEntries(new URLSearchParams(raw));
          for (const field of ['appliedAt', 'occurredAt']) if (input[field]) input[field] = input[field] + '+08:00';
        }
        let result;
        if (personalRoute) {
          const jobId = decodeURIComponent(personalRoute[1]);
          if (personalRoute[2] === 'applied') result = { application: app.setApplied(jobId, input?.applied), personal: app.getPersonalState(jobId) };
          else result = app.setPersonalState(jobId, input);
        } else {
          const id = decodeURIComponent(applicationRoute[2]);
          result = applicationRoute[3] ? app.recordApplicationEvent(id, input) : app.updateApplication(id, input);
        }
        if (json) return send(200, result, true);
        response.writeHead(303, { Location: '/applications' });
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/') { response.writeHead(302, { Location: '/jobs' }); return response.end(); }
      if (request.method === 'GET' && url.pathname === '/jobs') return send(200, jobsPage(app.listJobView('all',Object.fromEntries(url.searchParams)),Object.fromEntries(url.searchParams)));
      if (request.method === 'GET' && url.pathname === '/jobs/new') return send(200, newJobPage());
      if (request.method === 'GET' && url.pathname === '/api/jobs') return send(200, app.listJobView('all',Object.fromEntries(url.searchParams)), true);
      const historyRoute = url.pathname.match(/^\/(api\/)?jobs\/([^/]+)\/history$/);
      if (request.method === 'GET' && historyRoute) {
        const job = app.getJob(decodeURIComponent(historyRoute[2]));
        if (!job) return send(404, historyRoute[1] ? { error: '岗位不存在' } : page('岗位不存在', '<p>未找到岗位。</p>'), Boolean(historyRoute[1]));
        const history = app.getJobHistory(job.id);
        return send(200, historyRoute[1] ? history : historyPage(job, history), Boolean(historyRoute[1]));
      }
      const route = url.pathname.match(/^\/(api\/)?jobs\/([^/]+)$/);
      if (request.method === 'GET' && route) {
        const job = app.getJobView(decodeURIComponent(route[2]));
        return job ? send(200, route[1] ? job : jobPage(job, app.listApplications(job.id).map(withLinks)), Boolean(route[1])) : send(404, route[1] ? { error: '岗位不存在' } : page('岗位不存在', '<p>未找到该岗位。</p>'), Boolean(route[1]));
      }
      if (request.method === 'POST' && ['/jobs', '/api/jobs'].includes(url.pathname)) {
        if (request.headers.origin && ![local, local.replace('127.0.0.1', 'localhost')].includes(request.headers.origin)) return send(403, page('拒绝访问', '<p>不允许其他网站写入本机数据。</p>'));
        const raw = await body(request);
        const json = url.pathname.startsWith('/api/');
        const contentType = (request.headers['content-type'] ?? '').split(';')[0];
        if (contentType !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new ValidationError('请求内容类型无效');
        let input;
        if (json) { try { input = JSON.parse(raw); } catch { throw new ValidationError('JSON内容无效'); } }
        else input = jobFromForm(new URLSearchParams(raw));
        const job = app.createJob(input);
        if (json) return send(201, job, true);
        response.writeHead(303, { Location: `/jobs/${encodeURIComponent(job.id)}` });
        return response.end();
      }
      return send(404, page('页面不存在', '<p>未找到该页面。</p>'));
    } catch (error) {
      const validation = error instanceof ValidationError;
      const message = validation ? error.message : '本机操作失败，请检查服务日志后重试';
      if (!validation) console.error(error);
      return send(validation ? 400 : 500, url.pathname.startsWith('/api/') ? { error: message } : page('无法保存', `<p>${escapeHtml(message)}</p><p><a href="/jobs/new">返回补录</a></p>`), url.pathname.startsWith('/api/'));
    }
    },{automatic});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createProductionApplication({ databasePath: resolve(process.env.JOBHUNTER_DB ?? '.data/job-hunter.sqlite'), verificationMode: process.env.JOBHUNTER_VERIFICATION === '1' });
  const port = Number(process.env.JOBHUNTER_PORT ?? 3210);
  const server = await startServer({ app, port });
  console.log(`JobHunter：http://127.0.0.1:${server.address().port}/today`);
  const shutdown = () => server.close(() => { app.close(); process.exit(0); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
