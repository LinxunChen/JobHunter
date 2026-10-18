import { beijingDay as day } from './beijing-time.mjs';
import {beginProcessingOwner,endProcessingOwner,processingOwnerAlive} from './processing-owner.mjs';
import {randomUUID} from 'node:crypto';
export function createNotificationOperations({db,application,now,transport,verificationMode,ValidationError}) {
  db.exec('CREATE TABLE IF NOT EXISTS notification_channel_state (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notification_verifications (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notification_attempts (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const parse=row=>row?JSON.parse(row.body):null;
  const stamp=()=>now().toISOString();
  const save=(table,value)=>{db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));return value;};
  const all=table=>db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all().map(parse);
  const get=(table,id)=>parse(db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id));
  const enabled=()=>!verificationMode&&transport?.enabled===true&&typeof transport.send==='function';
  const transaction=fn=>{const owns=!db.isTransaction;if(owns)db.exec('BEGIN IMMEDIATE');try{const result=fn();if(owns)db.exec('COMMIT');return result;}catch(error){if(owns)db.exec('ROLLBACK');throw error;}};
  const active=new Set();
  const contentSnapshot=({title,content,htmlContent,template,report})=>({title,content,htmlContent,template,report});
  const limited=async(fn,ms)=>{const controller=new AbortController();let timer;try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},ms);});return await Promise.race([fn(controller.signal),timeout]);}finally{clearTimeout(timer);}};
  const channel=()=>get('notification_channel_state','pushplus')??{};
  const stop=(field,code)=>save('notification_channel_state',{...channel(),id:'pushplus',[field]:code,stoppedAt:stamp()});
  const queryEnabled=()=>enabled()&&!channel().queryBlockedCode&&transport.queryEnabled===true&&typeof transport.query==='function';
  const reportCurrent=delivery=>{
    if(!delivery.report)return true;
    if(delivery.report.date!==day(stamp()))return false;
    const current=new Map(Object.values(application.getNotificationPreview().report.sections).flat().map(item=>[item.jobId,item]));
    return Object.values(delivery.report.sections).flat().every(item=>{
      const latest=current.get(item.jobId);
      return latest&&['deadline','qualification','progress','recommendation','applicationHref','applicationSteps','recruitmentStatus'].every(field=>latest[field]===item[field]);
    });
  };
  const actionable=delivery=>application.withReadSnapshot(()=>{
    if(delivery.kind==='verification')return true;
    if(!reportCurrent(delivery))return false;
    const events=new Map(application.getActionEvents().map(event=>[event.id,event]));
    let opportunities;
    return delivery.eventIds.every(id=>{
    const event=events.get(id);if(!event||event.monitoringSuppressed||application.wasReminderPaused(id))return false;
    if(event.type==='source_persistent_failure')return application.getSourceMonitoringStatus(event.sourceId).enabled&& application.listSourceHealthEvents().find(item=>item.id===event.sourceEventId)?.status==='active';
    const personal=application.getPersonalState(event.jobId);
    if(!application.isJobMonitoringEnabled(event.jobId)||personal.notInterested||personal.remindersPaused)return false;
    if(event.type==='opportunity'){opportunities??=application.getToday().opportunities;return opportunities.some(item=>item.jobId===event.jobId&&(!event.opportunity.registrationAllowed||item.registrationAllowed));}
    if(event.registrationPrompt){const state=application.getRecruitmentState(event.jobId);if(personal.applied||state.registrationRemindersSuppressed||state.status!=='publicly_listed_open'||!application.getMatch(event.jobId)?.qualificationAllowsAction)return false;}
    return true;
    });
  });
  const operations={
    resumeUnsubmittedNotification(id,{refreshContent=false}={}){
      return transaction(()=>{
        let delivery=get('notification_deliveries',id);const attempts=delivery?.attemptIds.map(attemptId=>get('notification_attempts',attemptId))??[];
        if(delivery?.kind!=='daily_digest'||delivery.status!=='cancelled'||day(delivery.createdAt)!==day(stamp())||delivery.report?.date!==day(stamp())||attempts.length!==1||!attempts.every(attempt=>attempt?.status==='cancelled'&&attempt.category==='pre_dispatch_cancelled'&&!attempt.transportStartedAt))throw new ValidationError('仅当日明确未提交的首次取消日报可以恢复');
        if(refreshContent){
          const current=application.getNotificationPreview();
          const ids=report=>Object.values(report.sections).flat().map(item=>item.jobId).sort();
          if(JSON.stringify(ids(current.report))!==JSON.stringify(ids(delivery.report)))throw new ValidationError('岗位集合已变化，不能以原事件恢复日报');
          delivery={...delivery,...contentSnapshot(current),supersededContent:contentSnapshot(delivery)};
        }
        if(!actionable(delivery))throw new ValidationError('当前岗位或个人状态已变化，不能恢复旧正文');
        return save('notification_deliveries',{...delivery,status:'retry_wait',retryAt:stamp(),updatedAt:stamp(),resumedUnsubmittedAt:stamp(),reason:'发送前误取消经当前内容复核后恢复；原尝试及正文保留'});
      });
    },
    cancelPausedNotificationRetries(){for(const delivery of application.listActiveOperationIds('notification_deliveries',['retry_wait']).map(id=>get('notification_deliveries',id)))if(delivery.status==='retry_wait'&&!actionable(delivery))save('notification_deliveries',{...delivery,status:'cancelled',reason:'监控暂停或当前内容失效，旧提醒不补发',updatedAt:stamp()});},
    getNotificationStatus(){application.assertHistoryReady();return {sendEnabled:enabled()&&!channel().sendBlockedCode,sendBlockedCode:channel().sendBlockedCode??null,queryBlockedCode:channel().queryBlockedCode??null,queryEnabled:queryEnabled(),mode:enabled()?(transport.simulated?'controlled':'configured'):'disabled',date:day(stamp()),usedAttempts:db.prepare("SELECT count(*) n FROM history_records WHERE kind='notification_attempts' AND date=?").get(day(stamp())).n,maxDailySendAttempts:3,reason:enabled()?null:'未配置真实发送或恢复核对模式不可发送'};},
    createNotificationVerification(){return save('notification_verifications',{id:randomUUID(),kind:'verification',title:'[JobHunter]接入验证',content:'[JobHunter]接入验证：本机台账记录接口接受与最终结果。接口接受不等于送达，服务报告已发送不等于本人已阅读。',eventIds:[],createdAt:stamp(),status:'pending'});},
    listVerificationDrafts:()=>all('notification_verifications'),
    getNotificationLedger({cursor}={}){
      const history=application.listHistoryPage({kind:'notification_deliveries',cursor}),deliveries=history.items.map(item=>get('notification_deliveries',item.id));
      const attempts=deliveries.flatMap(delivery=>delivery.attemptIds.map(id=>get('notification_attempts',id)).filter(Boolean));
      const pending=table=>db.prepare(`SELECT body FROM ${table} WHERE json_extract(body,'$.status')='pending' ORDER BY rowid DESC LIMIT 20`).all().map(parse);
      return {capability:operations.getNotificationStatus(),verifications:pending('notification_verifications'),deliveries,attempts,drafts:pending('notification_drafts'),nextCursor:history.nextCursor};
    },
    getVerificationDraft:id=>get('notification_verifications',id),
    listNotificationAttempts:()=>all('notification_attempts'),
    listNotificationDeliveries:()=>all('notification_deliveries'),
    listNotificationWork:()=>application.listActiveOperationIds('notification_deliveries',queryEnabled()?['retry_wait','accepted','unknown']:['retry_wait']).map(id=>get('notification_deliveries',id)),
    getNotificationDelivery:id=>get('notification_deliveries',id),
    recoverNotificationAttempts(){
      return transaction(()=>{let recovered=0;for(const attempt of application.listActiveOperationIds('notification_attempts',['reserved']).map(id=>get('notification_attempts',id))){
        if(attempt.status!=='reserved'||Date.parse(attempt.sendDeadlineAt)>Date.parse(stamp())||active.has(attempt.deliveryId)||(attempt.owner&&processingOwnerAlive(attempt.owner)!==false))continue;
        save('notification_attempts',{...attempt,status:'unknown',category:'process_interrupted_acceptance_unknown',recoveredAt:stamp()});
        const delivery=get('notification_deliveries',attempt.deliveryId);save('notification_deliveries',{...delivery,status:'unknown',finalResult:'unknown',updatedAt:stamp()});recovered++;
      }return {recovered,usedAttempts:operations.getNotificationStatus().usedAttempts};});
    },
    reconcileNotificationResult(attemptId,{shortCode,status,observedAt=stamp()}={}){
      if(!queryEnabled())throw new ValidationError('结果查询能力未授权启用');
      const attempt=get('notification_attempts',attemptId);
      if(!attempt?.shortCode||attempt.shortCode!==shortCode||![2,3].includes(status)||!Number.isFinite(Date.parse(observedAt)))throw new ValidationError('可靠最终结果须对应既有消息流水号及最终状态');
      const delivery=get('notification_deliveries',attempt.deliveryId);
      if(['service_reported_sent','final_failed'].includes(delivery.status))return delivery;
      const finalStatus=status===2?'service_reported_sent':'final_failed';
      return transaction(()=>{save('notification_attempts',{...attempt,status:finalStatus,serviceStatus:status,resultObservedAt:observedAt});
      return save('notification_deliveries',{...delivery,status:finalStatus,finalResult:status===2?'service_sent_not_read':'failed',updatedAt:stamp()});});
    },
    async queryNotificationResult(id){
      if(!queryEnabled())return {status:'query_disabled',reason:'接口已接受时最终结果仍未知；未授权查询能力'};
      const delivery=get('notification_deliveries',id);if(!delivery)throw new ValidationError('通知台账不存在');
      const attempt=get('notification_attempts',delivery.attemptIds.at(-1));
      if(!attempt.shortCode||['service_reported_sent','final_failed'].includes(delivery.status)||(attempt.completedQueryNodes??0)>=3)return delivery;
      const elapsed=Date.parse(stamp())-Date.parse(attempt.finishedAt),node=elapsed>=600000?3:elapsed>=120000?2:elapsed>=30000?1:0;
      if(node<=(attempt.completedQueryNodes??0))return {status:'not_due'};
      // Persist the query slot before the request; a crashed query cannot reopen its budget.
      const reserved=transaction(()=>{const current=get('notification_attempts',attempt.id);if(node<=(current.completedQueryNodes??0))return null;const entry={node,at:stamp(),status:'reserved'};return save('notification_attempts',{...current,completedQueryNodes:node,queryHistory:[...current.queryHistory,entry]});});
      if(!reserved)return {status:'not_due'};
      let response,category;try{response=await limited(signal=>transport.query({shortCode:attempt.shortCode,signal}),transport.simulated?transport.queryTimeoutMs??10000:10000);}catch{category='query_network_or_timeout';}
      if([900,901,903,905,401,403].includes(response?.code))stop('queryBlockedCode',response.code);
      const valid=response?.code===200&&[0,1,2,3].includes(response.status);
      const current=get('notification_attempts',attempt.id),history=current.queryHistory.map(entry=>entry.node===node?{...entry,status:valid?'received':'unknown',serviceStatus:valid?response.status:null,code:Number.isInteger(response?.code)?response.code:null,category:valid?null:category??'query_response_invalid',finishedAt:stamp()}:entry);
      save('notification_attempts',{...current,queryHistory:history});
      if(valid&&[2,3].includes(response.status))return operations.reconcileNotificationResult(attempt.id,{shortCode:attempt.shortCode,status:response.status});
      if(node===3){const latest=get('notification_deliveries',id);if(!['service_reported_sent','final_failed'].includes(latest.status))return save('notification_deliveries',{...latest,status:'unknown',finalResult:'unknown',updatedAt:stamp()});}
      return get('notification_deliveries',id);
    },
    async sendNotification(id){
      if(!enabled())return {status:'disabled',reason:operations.getNotificationStatus().reason};
      if(channel().sendBlockedCode)return {status:'channel_blocked',code:channel().sendBlockedCode,reason:'发送能力已因服务限流／凭据／权限停止，需要人工核查'};
      const verification=get('notification_verifications',id);
      if(!verification)application.prepareDailyActions();
      let created=false;
      const reserved=transaction(()=>{
        const previous=get('notification_deliveries',id);if(previous?.status==='retry_wait'&&!actionable(previous))return save('notification_deliveries',{...previous,status:'cancelled',reason:'复核后当前内容已无行动价值，保留原尝试',updatedAt:stamp()});if(previous&&(previous.status!=='retry_wait'||Date.parse(previous.retryAt)>Date.parse(stamp())))return previous;
        if(operations.getNotificationStatus().usedAttempts>=3)return {status:'budget_exhausted',reason:'本日额度已用尽、尚未微信提醒'};
        const currentDraft=verification??application.getNotificationDraft(id);if(!previous&&currentDraft?.date&&currentDraft.date!==day(stamp()))return {status:'stale_draft',reason:'旧日期摘要保留Web，不回放；请生成当前事项'};
        if(!previous&&!verification&&currentDraft?.status==='suppressed')return {status:'no_action',reason:'当前内容已取消，不创建发送尝试'};
        const attemptId=randomUUID(),at=stamp();
        const draft=previous??verification??application.handoffNotificationDraft(id,{attemptId});
        if(draft.kind==='verification')save('notification_verifications',{...draft,status:'held_for_delivery',attemptId});
        const attempt={owner:beginProcessingOwner(),id:attemptId,deliveryId:id,date:day(at),status:'reserved',createdAt:at,sendDeadlineAt:new Date(Date.parse(at)+15000).toISOString(),simulated:transport.simulated===true,kind:draft.kind,queryHistory:[]};
        save('notification_attempts',attempt);created=true;
        return save('notification_deliveries',{...(previous?.resumedUnsubmittedAt?{resumedUnsubmittedAt:previous.resumedUnsubmittedAt}:{}),...(previous?.supersededContent?{supersededContent:previous.supersededContent}:{}),id,draftId:id,kind:draft.kind,title:draft.title??'[JobHunter]求职行动提醒',content:draft.content,htmlContent:draft.htmlContent??null,template:draft.template??'txt',...(draft.report?{report:draft.report}:{}),eventIds:draft.eventIds,attemptIds:[...(previous?.attemptIds??[]),attemptId],status:'in_progress',finalResult:'unknown',createdAt:previous?.createdAt??at,updatedAt:at});
      });
      if(!created||reserved.status!=='in_progress'||active.has(id))return reserved;
      // Only the caller that created this reservation may dispatch it.
      const last=get('notification_attempts',reserved.attemptIds.at(-1));
      if(last.status!=='reserved'||last.dispatchClaimedAt)return reserved;
      save('notification_attempts',{...last,dispatchClaimedAt:stamp()});active.add(id);
      try{
        if(!actionable(reserved)){save('notification_attempts',{...get('notification_attempts',last.id),status:'cancelled',category:'pre_dispatch_cancelled',finishedAt:stamp()});return save('notification_deliveries',{...reserved,status:'cancelled',reason:'发送前复核：监控暂停或内容失效',updatedAt:stamp()});}
        // Recheck after yielding, but start the network timeout only after local work.
        const result=await Promise.resolve().then(()=>{
          if(!actionable(reserved))return {outcome:'cancelled'};
          save('notification_attempts',{...get('notification_attempts',last.id),transportStartedAt:stamp()});
          return limited(signal=>transport.send({title:reserved.title,content:reserved.template==='html'?reserved.htmlContent:reserved.content,template:reserved.template,signal}),transport.simulated?transport.sendTimeoutMs??15000:15000);
        });
        if([900,901,903,905,401,403].includes(result?.code))stop('sendBlockedCode',result.code);
        const accepted=result?.code===200&&typeof result.shortCode==='string'&&result.shortCode.length>0&&result.shortCode.length<=100;
        const definiteConnectionFailure=result?.outcome==='not_accepted'&&result.category==='connection_pre_submission'&&result.retryable===true;
        const status=result?.outcome==='cancelled'?'cancelled':accepted?'accepted':definiteConnectionFailure&&!actionable(reserved)?'cancelled':definiteConnectionFailure?(reserved.attemptIds.length<2?'retry_wait':'final_failed'):!Number.isInteger(result?.code)||[200,500].includes(result.code)?'unknown':'final_failed';
        return transaction(()=>{const attempt=save('notification_attempts',{...get('notification_attempts',last.id),status,code:Number.isInteger(result?.code)?result.code:null,shortCode:accepted?result.shortCode:null,category:accepted?null:result?.outcome==='cancelled'?'pre_dispatch_cancelled':definiteConnectionFailure?'connection_pre_submission':status==='unknown'?'acceptance_unknown':'service_rejected',finishedAt:stamp()});
        return save('notification_deliveries',{...reserved,status,finalResult:status==='final_failed'?'failed':'unknown',shortCode:attempt.shortCode,retryAt:status==='retry_wait'?new Date(Date.parse(stamp())+60000).toISOString():null,updatedAt:stamp()});});
      }catch{
        return transaction(()=>{save('notification_attempts',{...get('notification_attempts',last.id),status:'unknown',category:'network_or_timeout_acceptance_unknown',finishedAt:stamp()});
        return save('notification_deliveries',{...reserved,status:'unknown',finalResult:'unknown',updatedAt:stamp()});});
      }finally{active.delete(id);endProcessingOwner(last.owner);}
    },
  };
  return operations;
}
