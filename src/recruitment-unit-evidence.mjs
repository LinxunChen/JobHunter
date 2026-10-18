// Preserve institution context outside a cropped job body. A site brand or
// copyright alone is not an employer: require a matching recruitment statement.
export function readHtmlRecruitmentUnit({html,body,title,response,plain}) {
 const visible=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
 const pageTitle=plain(visible.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
 const footerStart=visible.search(/<(?:footer\b|div\b[^>]*class=["'][^"']*\bfooter\b)/i);
 const footer=footerStart<0?'':visible.slice(footerStart);
 const lines=plain(body).split(/[\r\n]+/).map(x=>x.trim()).filter(Boolean);
 const declared=lines.filter(x=>/^(?:招聘单位|招聘公司|用人单位|所属公司)\s*[:：]/.test(x));
 const units=[...new Set(declared.map(x=>x.replace(/^[^:：]+[:：]\s*/,'')).filter(x=>x&&!/^(?:未披露|未知|待核验|暂无|未明确)$/.test(x)))];
 const copyright=[...new Set([...footer.matchAll(/<(?:span|p)\b[^>]*>([^<]*版权所有\s*[:：][^<]*)<\/(?:span|p)>/gi)].map(x=>plain(x[1])))];
 const statements=[...footer.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(x=>plain(x[1])).filter(x=>/在招聘过程中/.test(x));
 const context=[pageTitle&&'官方网页标题：'+pageTitle,...copyright,...statements].filter(Boolean).join('\n');
 // Responsibilities can mention clients' subsidiaries or supervising vendors;
 // those words alone do not say this role is recruited by another employer.
 const sharedRecruitment=/(?:旗下|子公司|分公司)[^\n。；]{0,20}(?:统一招聘|联合招聘|招聘岗位|岗位招聘|代招)|(?:统一|面向|为|由)[^\n。；]{0,15}(?:旗下|子公司|分公司)[^\n。；]{0,15}招聘|(?:劳务派遣|外包岗位|外包招聘|外包用工|代招|实际用工单位|实际服务单位|签约主体)\s*[:：]/.test(plain(body));
 let value=null,basis=null,quotes=[],aliases=[];
 if(declared.length) {
  if(units.length===1&&declared.every(x=>x.endsWith(units[0]))) {value=units[0];basis='job_label';quotes=declared;}
 }else if(copyright.length===1&&pageTitle&&!sharedRecruitment) {
  const owner=copyright[0].replace(/^版权所有\s*[:：]\s*/,'').trim();
  const brand=pageTitle.replace(/(?:招聘官网|官方招聘|人才招聘|社会招聘|招聘)[\s-]*$/,'').trim();
  const shortOwner=owner.replace(/(?:管理)?(?:股份)?(?:有限责任公司|有限公司)$/,'');
  const statement=statements.find(x=>x.includes(brand+'在招聘过程中'));
  if(brand&&brand===shortOwner&&statement&&!/集团/.test(owner)) {value=owner;basis='official_recruitment_context';quotes=[pageTitle,copyright[0],statement];aliases=[brand];}
 }
 const evidence=value?{value,basis,aliases,title,sourceUrl:response.url,checkedAt:response.readAt,rawHash:response.rawHash,text:plain(body)+'\n'+context,quotes}:null;
 return {unit:value,evidence,context};
}

export function validRecruitmentUnitEvidence(evidence,{title,sourceUrl,checkedAt}) {
 return evidence&&['job_label','official_recruitment_context'].includes(evidence.basis)&&evidence.title===title&&evidence.sourceUrl===sourceUrl&&evidence.checkedAt===checkedAt&&
  typeof evidence.value==='string'&&!!evidence.value.trim()&&typeof evidence.text==='string'&&evidence.text.includes(evidence.value)&&
  /^[a-f0-9]{64}$/.test(evidence.rawHash??'')&&Array.isArray(evidence.quotes)&&evidence.quotes.length>0&&evidence.quotes.every(x=>typeof x==='string'&&x.trim()&&evidence.text.includes(x))&&
  evidence.quotes.some(x=>x.includes(evidence.value))&&Array.isArray(evidence.aliases)&&evidence.aliases.every(x=>typeof x==='string'&&x.trim()&&evidence.text.includes(x));
}
