import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRuntimePlan,prepareRuntimePlan} from '../ops/runtime-plan.mjs';

test('常驻计划只读列出固定路径与启停命令，项目内准备不安装且拒绝覆盖既有配置', t => {
  const directory=mkdtempSync(join(tmpdir(),'jobhunter-runtime-plan-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const projectRoot=join(directory,'project'),launchAgents=join(directory,'LaunchAgents');mkdirSync(projectRoot);mkdirSync(launchAgents,{mode:0o700});
  const options={projectRoot,launchAgents,uid:501};const plan=createRuntimePlan(options);
  assert.equal(plan.systemChanges,false);assert.equal(plan.installReady,true);assert.equal(plan.databasePath,join(projectRoot,'.data/job-hunter.sqlite'));assert.equal(plan.port,3210);assert.equal(plan.mainBranchSwitch,false);assert.match(plan.plists.web,/<key>KeepAlive<\/key><true\/>/);assert.match(plan.plists.scheduler,/<key>StartInterval<\/key><integer>60<\/integer>/);assert.match(plan.plists.scheduler,/<key>RunAtLoad<\/key><true\/>/);assert.match(plan.plists.web,/127\.0\.0\.1/);assert.match(plan.plists.web,/JOBHUNTER_PORT/);assert.match(plan.plists.web,/\/Applications\/ChatGPT.app/);
  assert.match(plan.plists.web,/<key>Umask<\/key><integer>63<\/integer>/);assert.match(plan.plists.scheduler,/<key>Umask<\/key><integer>63<\/integer>/);
  assert.equal(readdirSync(projectRoot).length,0);assert.equal(readdirSync(launchAgents).length,0);assert(plan.commands.disable.some(command=>command.includes('launchctl disable gui/501/local.jobhunter.scheduler')));assert(plan.commands.disable.some(command=>command.includes('launchctl bootout gui/501/local.jobhunter.web')));
  const prepared=prepareRuntimePlan(options);assert.equal(statSync(prepared.directory).mode&0o777,0o700);assert.equal(statSync(join(prepared.directory,'web.plist')).mode&0o777,0o600);assert.equal(readdirSync(launchAgents).length,0);
  execFileSync('/usr/bin/plutil',['-lint',join(prepared.directory,'web.plist'),join(prepared.directory,'scheduler.plist')]);
  assert.throws(()=>prepareRuntimePlan(options),/拒绝覆盖/);
  const existing=join(launchAgents,'local.jobhunter.web.plist');writeFileSync(existing,'existing-user-configuration',{mode:0o600});const blocked=createRuntimePlan(options);assert.equal(blocked.installReady,false);assert.equal(readFileSync(existing,'utf8'),'existing-user-configuration');assert.throws(()=>prepareRuntimePlan(options),/已有配置/);
});

test('系统目录链接不能作为安装目标；CLI计划无写入且不提供系统执行入口', t => {
  const directory=mkdtempSync(join(tmpdir(),'jobhunter-runtime-plan-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const projectRoot=join(directory,'project'),outside=join(directory,'outside'),launchAgents=join(directory,'LaunchAgents');mkdirSync(projectRoot);mkdirSync(outside,{mode:0o700});symlinkSync(outside,launchAgents);
  const plan=createRuntimePlan({projectRoot,launchAgents,uid:501});assert.equal(plan.installReady,false);assert.throws(()=>prepareRuntimePlan({projectRoot,launchAgents,uid:501}),/目录不安全/);assert.equal(readdirSync(outside).length,0);assert.equal(readdirSync(projectRoot).length,0);
  const output=execFileSync(process.execPath,['ops/runtime-plan.mjs','--plan'],{cwd:new URL('../',import.meta.url),encoding:'utf8'}),actual=JSON.parse(output);assert.equal(actual.systemChanges,false);assert.equal(actual.projectRoot,new URL('../',import.meta.url).pathname.replace(/\/$/,''));assert.equal(actual.node,process.execPath);assert.equal(actual.codexCommand,'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.throws(()=>execFileSync(process.execPath,['ops/runtime-plan.mjs','--install'],{cwd:new URL('../',import.meta.url),stdio:'pipe'}),error=>error.status===2);
});
