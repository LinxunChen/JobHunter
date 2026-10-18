import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createApplication} from '../src/application.mjs';
import {expandedSources,expandedMethod} from '../src/expanded-source-catalog.mjs';

const options=new Map();
for(let i=2;i<process.argv.length;i+=2){if(!['--database','--source','--output','--apply'].includes(process.argv[i])||!process.argv[i+1])throw Error('参数：--database <sqlite> --source <sourceId> [--output <目录>] 或 --database <sqlite> --apply <plan.json>');options.set(process.argv[i],process.argv[i+1]);}
if(!options.has('--database'))throw Error('必须明确指定 --database；默认只在副本验证，--apply 才修改指定库');
const databasePath=resolve(options.get('--database'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeApp=path=>createApplication({databasePath:path,now:()=>new Date(),announcementProcessor:null,matchingProcessor:null,careerSource:null,notificationTransport:null});
const readJobs=db=>db.prepare('SELECT id,body FROM jobs').all();
const writeJson=(path,value)=>{writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(path,0o600);};

if(options.has('--apply')) {
 const plan=JSON.parse(readFileSync(resolve(options.get('--apply')),'utf8'));
 if(plan.version!==1||plan.databasePath!==databasePath||!Array.isArray(plan.changes)||!plan.changes.length)throw Error('计划无效、目标库不一致或没有可补齐项');
 const original=new DatabaseSync(databasePath,{readOnly:true});
 try {
  // Verify the entire reviewed scope before any application initialization or
  // write. A changed record requires a fresh preview, never a silent overwrite.
  for(const change of plan.changes){const row=original.prepare('SELECT body FROM jobs WHERE id=?').get(change.jobId);if(!row||hash(row.body)!==change.precondition)throw Error('岗位已变化，重新生成预览：'+change.jobId);}
  const directory=resolve('.runtime/recruitment-unit-repair-'+Date.now());mkdirSync(directory,{recursive:true,mode:0o700});
  await backup(original,join(directory,'before.sqlite'));chmodSync(join(directory,'before.sqlite'),0o600);
  const app=safeApp(databasePath);
  try {
   const results=[];
   for(const change of plan.changes){const result=app.recordJobRecruitmentUnitEvidence(change.jobId,{sourceId:change.sourceId,externalId:change.externalId,evidence:change.evidence});if(!['enriched','unchanged'].includes(result.status))throw Error('补齐发生冲突：'+change.jobId);results.push({jobId:change.jobId,title:result.job.title,recruitmentUnit:app.getSourceJob(change.jobId).recruitmentUnit,status:result.status});}
   writeJson(join(directory,'receipt.json'),{databasePath,backup:join(directory,'before.sqlite'),results});console.log(JSON.stringify({applied:results.length,backup:join(directory,'before.sqlite'),receipt:join(directory,'receipt.json')}));
  }finally{app.close();}
 }finally{original.close();}
}else {
 const source=expandedSources.find(x=>x.id===options.get('--source'));if(!source)throw Error('必须指定已登记的 --source');
 const directory=resolve(options.get('--output')??'.runtime/recruitment-unit-preview-'+Date.now());mkdirSync(directory,{recursive:true,mode:0o700});
 const original=new DatabaseSync(databasePath,{readOnly:true});let rows;
 try {rows=readJobs(original);await backup(original,join(directory,'verification.sqlite'));chmodSync(join(directory,'verification.sqlite'),0o600);}finally{original.close();}
 const targets=rows.map(row=>({row,job:JSON.parse(row.body)})).filter(x=>!x.job.recruitmentUnit&&x.job.sourceIdentities?.some(s=>s.sourceId===source.id));
 const app=safeApp(join(directory,'verification.sqlite'));
 try {
  const ids=[...new Set(targets.map(x=>x.job.sourceIdentities.find(s=>s.sourceId===source.id).externalId))],runs=[];
  for(let i=0;i<ids.length;i+=20){const run=await app[expandedMethod(source.id)]({postIds:ids.slice(i,i+20),processJobs:false});runs.push({id:run.id,status:run.status,gaps:run.gaps,businessGaps:run.businessGaps});}
  const changes=[],pending=[];
  for(const {row,job}of targets){const updated=app.getSourceJob(job.id),evidence=updated.recruitmentUnitEvidence;if(updated.recruitmentUnit&&evidence){changes.push({jobId:job.id,title:job.title,sourceId:source.id,externalId:job.sourceIdentities.find(s=>s.sourceId===source.id).externalId,before:job.recruitmentUnit,after:updated.recruitmentUnit,precondition:hash(row.body),evidence});}else pending.push({jobId:job.id,title:job.title,reason:'官网证据未同时核验或获取失败'});}
  const plan={version:1,databasePath,createdAt:new Date().toISOString(),sourceId:source.id,changes,pending,runs};
  writeJson(join(directory,'plan.json'),plan);
  console.log(JSON.stringify({mode:'preview',originalDatabaseWritten:false,targetCount:targets.length,ready:changes.length,pending,plan:join(directory,'plan.json'),verificationDatabase:join(directory,'verification.sqlite'),runs},null,2));
 }finally{app.close();}
}
