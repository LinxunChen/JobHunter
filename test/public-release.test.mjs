import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync,readFileSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exportPublicSource} from '../scripts/public-release.mjs';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
test('公开导出排除历史与私人目录，复制后的应用独立启动并保存个人配置',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jobhunter-public-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const output=join(dir,'source'),result=exportPublicSource({projectRoot,output});
 assert(result.files>100);
 for(const name of ['.git','.data','.scratch','.runtime','AGENTS.md'])assert.equal(existsSync(join(output,name)),false);
 assert.throws(()=>exportPublicSource({projectRoot,output}),/拒绝覆盖/);
 const {createApplication}=await import(pathToFileURL(join(output,'src/application.mjs')));
 const {startServer}=await import(pathToFileURL(join(output,'src/server.mjs')));
 const app=createApplication({databasePath:join(dir,'isolated/db.sqlite'),announcementProcessor:null,matchingProcessor:null});t.after(()=>app.close());
 assert.equal(app.getLocalSettings().careerDocumentId,'');
 assert.equal((await app.refreshCareerProfile()).status,'disabled');
 const server=await startServer({app,port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/settings`);
 assert.equal(response.status,200);assert((await response.text()).includes('设置你的求职目标'));
 app.saveLocalSettings({targetCities:['广州']});assert.deepEqual(app.getLocalSettings().targetCities,['广州']);
});

test('公开导出命中本地私密标记时拒绝生成，不输出命中原文',t=>{
 const dir=mkdtempSync(join(tmpdir(),'jobhunter-public-marker-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const name of ['src','scripts','ops','test','.data'])mkdirSync(join(dir,name));
 for(const name of ['README.md','package.json','package-lock.json','.gitignore','.gitattributes'])writeFileSync(join(dir,name),'public sample');
 writeFileSync(join(dir,'src/example.mjs'),'// private-canary-for-test');
 writeFileSync(join(dir,'.data/privacy-markers.json'),JSON.stringify(['private-canary-for-test']));
 const output=join(dir,'release');
 assert.throws(()=>exportPublicSource({projectRoot:dir,output}),error=>error.message.includes('src/example.mjs')&&!error.message.includes('private-canary-for-test'));
 assert.equal(existsSync(output),false);
 renameSync(join(dir,'src'),join(dir,'linked-source'));
 symlinkSync(join(dir,'linked-source'),join(dir,'src'));
 assert.throws(()=>exportPublicSource({projectRoot:dir,output}),/符号链接/);
 assert.equal(existsSync(output),false);
});
