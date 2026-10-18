import {accessSync,constants,existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {productionCodexCommand} from '../src/production-bootstrap.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,''),node=process.execPath;
const python=join(root,'.runtime/attachment-venv/bin/python');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const present=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

/** Metadata and project templates only. Never read credentials/DB or run launchctl. */
export function createRuntimePlan({projectRoot=root,launchAgents=join(homedir(),'Library/LaunchAgents'),uid=process.getuid()}={}) {
  const databasePath=join(projectRoot,'.data/job-hunter.sqlite'),logs=join(projectRoot,'.runtime/service-logs'),directory=join(projectRoot,'.runtime/service-install-plan');
  const targets=Object.fromEntries(['web','scheduler'].map(kind=>[kind,join(launchAgents,`local.jobhunter.${kind}.plist`)]));
  const blocked=Object.values(targets).filter(present).map(path=>`已有配置，拒绝覆盖：${path}`);
  if(present(launchAgents)){const entry=lstatSync(launchAgents);if(!entry.isDirectory()||entry.isSymbolicLink()||(entry.mode&0o077))blocked.push('LaunchAgents目录不安全；不自动改权限或跟随链接');}
  for(const executable of [node,productionCodexCommand,python])try{accessSync(executable,constants.X_OK);}catch{blocked.push(`运行时不可执行：${executable}`);}
  if(present(logs)){const entry=lstatSync(logs);if(!entry.isDirectory()||entry.isSymbolicLink()||(entry.mode&0o077))blocked.push('日志目录不安全；不自动更改已有配置');}
  const substitutions={__ABSOLUTE_NODE22__:node,__PROJECT_ROOT__:projectRoot,__DATABASE_PATH__:databasePath,__EXISTING_ATTACHMENT_PYTHON__:python,__PRIVATE_LOG_DIRECTORY__:logs,__RUNTIME_PATH__:`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin:${dirname(productionCodexCommand)}`};
  const plists=Object.fromEntries(['web','scheduler'].map(kind=>[kind,readFileSync(new URL(`./job-hunter-${kind}.plist.template`,import.meta.url),'utf8').replace(/__[A-Z0-9_]+__/g,key=>{if(!Object.hasOwn(substitutions,key))throw Error('模板路径尚未完整绑定');return xml(substitutions[key]);})]));
  const service=kind=>`gui/${uid}/local.jobhunter.${kind}`;
  return {systemChanges:false,mainBranchSwitch:false,projectRoot,node,codexCommand:productionCodexCommand,attachmentPython:python,databasePath,credentialPath:join(projectRoot,'.data/credentials/pushplus.json'),port:3210,host:'127.0.0.1',logs,directory,targets,installReady:!blocked.length,blocked,plists,
    warnings:['本工具不读取凭据或数据库，不安装／启用／停用系统服务。','Web启用前需正常停止占用3210的本项目手动Web，核对当前PID，不按旧PID杀进程。','服务读取项目根当前已集成代码，不自动切换main；未来切换后须重启Web并核对新版本。','按用户登录加载；重启后需登录，睡眠不强制唤醒，Life既有服务及Codex认证仍须可用。','一分钟轮询不保证精确09:00送达；周日／跨日／睡眠行为需实际观察。'],
    commands:{prepare:[`${quote(node)} ${quote(join(projectRoot,'ops/runtime-plan.mjs'))} --prepare`],install:[`/bin/mkdir -p ${quote(launchAgents)}`,`/bin/mkdir -m 700 -p ${quote(logs)}`,...['web','scheduler'].map(kind=>`(set -C; umask 077; /bin/cat ${quote(join(directory,kind+'.plist'))} > ${quote(targets[kind])})`),`/usr/bin/plutil -lint ${Object.values(targets).map(quote).join(' ')}`],enable:['web','scheduler'].flatMap(kind=>[`/bin/launchctl enable ${service(kind)}`,`/bin/launchctl bootstrap gui/${uid} ${quote(targets[kind])}`]),status:['web','scheduler'].map(kind=>`/bin/launchctl print ${service(kind)}`),disable:['scheduler','web'].flatMap(kind=>[`/bin/launchctl disable ${service(kind)}`,`/bin/launchctl bootout ${service(kind)}`])}};
}

/** Prepare reviewable XML only inside the project; refuse existing artifacts. */
export function prepareRuntimePlan(options={}) {
  const plan=createRuntimePlan(options);if(!plan.installReady)throw Error(plan.blocked.join('；'));
  const runtime=dirname(plan.directory);if(present(runtime)&&(!lstatSync(runtime).isDirectory()||lstatSync(runtime).isSymbolicLink()))throw Error('项目运行目录不安全');
  if(present(plan.directory))throw Error('项目计划已有成果，拒绝覆盖');
  mkdirSync(runtime,{recursive:true,mode:0o700});mkdirSync(plan.directory,{mode:0o700});
  for(const [kind,content] of Object.entries(plan.plists))writeFileSync(join(plan.directory,kind+'.plist'),content,{flag:'wx',mode:0o600});
  writeFileSync(join(plan.directory,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  return plan;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);if(args.length>1||(args.length&&!['--plan','--prepare'].includes(args[0]))){console.error('只允许 --plan 或项目内 --prepare；没有系统执行功能。');process.exitCode=2;}
  else try{const plan=args[0]==='--prepare'?prepareRuntimePlan():createRuntimePlan();console.log(JSON.stringify(plan,null,2));}catch{console.error('常驻计划未完成；检查运行时及既有配置，不自动覆盖或安装。');process.exitCode=1;}
}
