import {readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,relative,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const topFiles=['README.md','package.json','package-lock.json','.gitignore','.gitattributes'];
const directories=['src','scripts','ops','test'];
const extensions=/\.(?:mjs|js|json|css|py|swift|txt|template|md|html|png|jpe?g|gif|pdf|docx?|xlsx?)$/i;
function filesIn(directory) {
 if(lstatSync(directory).isSymbolicLink())throw new Error('公开源码目录不接受符号链接');
 return readdirSync(directory).sort().flatMap(name=>{
  const file=join(directory,name),stat=lstatSync(file);
  if(stat.isSymbolicLink())throw new Error('公开源码包含符号链接，拒绝导出');
  if(name.startsWith('.'))return [];
  if(stat.isDirectory())return filesIn(file);
  if(!stat.isFile()||!extensions.test(name))throw new Error('公开目录含未审核文件类型，拒绝导出');
  return [file];
 });
}
export function exportPublicSource({projectRoot=root,output=join(projectRoot,'.runtime/public-release'),privateMarkers=[]}={}) {
 projectRoot=resolve(projectRoot);output=resolve(output);
 if(existsSync(output))throw new Error('导出目标已存在，拒绝覆盖');
 const account=basename(homedir());
 const markers=[homedir(),...(['root','user','admin','test','runner'].includes(account)?[]:[account]),...privateMarkers].filter(x=>typeof x==='string'&&x.length>=4);
 const seed=join(projectRoot,'.data/local-settings.json');
 if(existsSync(seed)){
  const settings=JSON.parse(readFileSync(seed,'utf8'));
  markers.push(...[settings.careerDocumentId,settings.careerSettingsPath].filter(Boolean));
 }
 const extra=join(projectRoot,'.data/privacy-markers.json');
 if(existsSync(extra)){
  const value=JSON.parse(readFileSync(extra,'utf8'));
  if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||x.length<2))throw new Error('本地隐私标记格式无效');
  markers.push(...value);
 }
 const files=[...topFiles.map(name=>join(projectRoot,name)),...directories.flatMap(name=>filesIn(join(projectRoot,name)))];
 const data=files.map(file=>{
  if(lstatSync(file).isSymbolicLink())throw new Error('公开源码不接受链接');
  const bytes=readFileSync(file),text=bytes.toString('utf8');
  if(/https?:\/\/chatgpt\.com\/c\/|siyuan:\/\//.test(text)||markers.some(marker=>bytes.includes(Buffer.from(marker)))||/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)||/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{30,})\b/.test(text))throw new Error('隐私扫描未通过：'+relative(projectRoot,file)+'（仅报告文件名）');
  return {path:relative(projectRoot,file),bytes};
 });
 mkdirSync(dirname(output),{recursive:true,mode:0o700});
 mkdirSync(output,{mode:0o700});
 try{
  for(const item of data){const file=join(output,item.path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,item.bytes,{flag:'wx'});}
 }catch(error){rmSync(output,{recursive:true,force:true});throw error;}
 return {output,files:data.length,gitHistoryIncluded:false,privateDirectoriesIncluded:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 try{
  if(args.length&&!(args.length===2&&args[0]==='--output'))throw new Error('用法：node scripts/public-release.mjs [--output 新目录]');
  console.log(JSON.stringify(exportPublicSource(args.length?{output:args[1]}:{}),null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
