import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {createApplication,ValidationError} from '../src/application.mjs';
import {createMatchingProcessor} from '../src/matching-codex.mjs';
import {productionCodexCommand} from '../src/production-bootstrap.mjs';
import {dirname} from 'node:path';

const [databasePath, announcementId, option] = process.argv.slice(2);
if (!databasePath || !announcementId || process.argv.length > 5 || (option != null && option !== '--match') || !existsSync(databasePath)) {
  throw new Error('用法：node scripts/revalidate-announcement.mjs <已有数据库路径> <公告ID> [--match]；默认仅复验已保存结果；--match另执行最多一次真实匹配，受每日自动额度约束；不发送通知');
}
const noNetwork = async () => { throw new Error('原结果复验禁止外部请求'); };
const matchingProcessor=option==='--match'?createMatchingProcessor({workingRoot:dirname(resolve(databasePath)),command:productionCodexCommand}):null;
const app = createApplication({databasePath:resolve(databasePath),announcementProcessor:null,matchingProcessor,notificationTransport:null,sourceFetch:noNetwork,ccbSourceFetch:noNetwork,icbcFetch:noNetwork,cmriFetch:noNetwork,sasacFetch:noNetwork});
let lease;
try {
  // Share the existing maintenance/source mutex with background cycles.
  const lockDeadline=Date.now()+60000;
  while (!lease) {
    try { lease=app.acquireSourceCheckLock(); }
    catch(error) {
      if (!(error instanceof ValidationError) || error.message !== '后台正在检查，请查看现有检查进度' || Date.now()>=lockDeadline) throw error;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  const before=app.getAnnouncement(announcementId);
  const usage=app.getModelUsageSummary(),budget=app.getModelBudgetStatus();
  const result=await app.processAnnouncement(announcementId,{revalidateSavedOutput:true});
  if (!['processed','partial'].includes(result.status)) throw new Error(result.error ?? '复验未完成');
  if (JSON.stringify(usage)!==JSON.stringify(app.getModelUsageSummary()) || JSON.stringify(budget)!==JSON.stringify(app.getModelBudgetStatus())) throw new Error('复验意外改变模型用量');
  if (before.originalText!==result.originalText || before.contentVersion!==result.contentVersion) throw new Error('复验意外改变来源原件');
  let matching=null;
  if (option==='--match') {
    if (result.jobIds.length!==1) throw new Error('真实匹配限定为一个恢复岗位');
    matching=await app.withModelBatch(()=>app.matchJob(result.jobIds[0]),{automatic:true});
  }
  console.log(JSON.stringify({announcementId,status:result.status,newModelCalls:app.getModelUsageSummary().calls-usage.calls,matchingStatus:matching?.status??'not_requested',notificationsSent:0,originalPreserved:true,jobs:result.jobIds.map(id=>{const job=app.getJob(id);return {id,title:job.title,conditions:job.conditions.length,recruitmentStatus:app.getRecruitmentState(id).status};}),remainingExecutionIssues:app.listProcessingIssues().filter(x=>x.status==='failed').length},null,2));
  if (matching && matching.status!=='completed') throw new Error('岗位已恢复；匹配未完成，请核对保存的匹配诊断，不自动重试');
} finally { if(lease) app.releaseSourceCheckLock(lease); app.close(); }
