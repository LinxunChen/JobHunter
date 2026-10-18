import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProductionApplication } from './production-bootstrap.mjs';

export async function runScheduledOnce(options = {}) {
  const app = createProductionApplication(options);
  const tick=app.verificationMode?null:app.beginSchedulerActivity();let result;
  try { result=await app.runScheduledCycle();return result; } finally { if(tick)app.finishSchedulerActivity(tick,result);app.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('JOBHUNTER_DB=/absolute/path/job-hunter.sqlite node src/run-scheduled.mjs\n一次当前检查：09:00前只恢复/查询已授权结果；09:00后补当前。生产入口仅加载该数据库目录中credentials/pushplus.json；缺失或关闭时禁止发送，恢复核对模式不读取凭据。系统安装与启用由任务26确认。');
  } else if (process.argv.slice(2).length) {
    console.error('不接受旧日期、凭据或重复回放参数；使用 --help');process.exitCode = 2;
  } else {
    try {
      const result = await runScheduledOnce({ databasePath: resolve(process.env.JOBHUNTER_DB ?? '.data/job-hunter.sqlite'), verificationMode: process.env.JOBHUNTER_VERIFICATION === '1' });
      console.log(JSON.stringify({ status: result.status, runId: result.id ?? result.runId ?? null, nextCheckAt: result.nextCheckAt ?? result.retryAt ?? null, sources: result.sources?.map(x => ({ sourceId: x.sourceId, status: x.status })) ?? [], sendEnabled: result.notifications?.capability?.sendEnabled ?? false }));
    } catch { console.error('当前检查未完成；本机Web查看原文、步骤和恢复记录。');process.exitCode = 1; }
  }
}
