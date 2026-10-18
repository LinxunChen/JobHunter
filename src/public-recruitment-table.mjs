import {createHash} from 'node:crypto';
import {readHtmlTables} from './boc-html.mjs';

// Read leaf tables only: legacy portals wrap the actual matrix in layout tables.
// A digest identifies a row in this matrix; it is not an official vacancy code.
export function readPublicRecruitmentTable(html,{plain}) {
 const visible=html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,x=>' '.repeat(x.length)),stack=[],matches=[];
 for(const tag of visible.matchAll(/<\/?table\b[^>]*>/gi)){
  if(!/^<\//.test(tag[0])){if(stack.length)stack.at(-1).nested=true;stack.push({start:tag.index,nested:false});}
  else {const frame=stack.pop();if(!frame)throw Error('官方岗位表边界不完整');if(!frame.nested){const fragment=html.slice(frame.start,tag.index+tag[0].length);if(/职位名称/.test(plain(fragment)))matches.push(...readHtmlTables(fragment,{plain,sourceOffset:frame.start}).filter(t=>t.columns===3&&t.rows[0]?.cells.map(c=>c.text.trim()).join('|')==='职位名称|部门|工作地点'));}}
 }
 if(stack.length||matches.length!==1)throw Error('官方岗位表边界或职位名称、部门、工作地点列未唯一核验');
 const rows=matches[0].rows.slice(1).map(row=>{
  const [title,department,location]=row.cells.map(c=>c.text.trim());
  if(!title||!department||!location)throw Error('官方岗位表必要字段为空');
  return {title,department,locations:[location],externalId:createHash('sha256').update(JSON.stringify([title,department,location])).digest('hex'),identityKind:'table_row_digest'};
 });
 if(new Set(rows.map(r=>r.externalId)).size!==rows.length)throw Error('官方岗位表重复身份，未确认覆盖完整');
 return rows;
}
