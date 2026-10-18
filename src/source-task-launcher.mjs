import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function createSourceTaskLauncher({databasePath,workerPath=fileURLToPath(new URL('./run-source-task.mjs',import.meta.url))}) {
 return task=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[workerPath,databasePath,task.id],{detached:true,stdio:'ignore'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('独立检查进程中断，请查看已保存进度')));child.unref();
 });
}
