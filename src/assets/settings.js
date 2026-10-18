(() => {
 const panel=document.querySelector('#profile-analysis');
 if(!panel||!['pending','processing','deferred','interrupted'].includes(panel.dataset.status))return;
 let attempts=0;
 const poll=async()=>{
  if(document.hidden){setTimeout(poll,5000);return;}
  try{
   const response=await fetch('/api/settings',{cache:'no-store'});if(!response.ok)return;
   const result=await response.json(),state=result.profileAnalysis;
   if(state){panel.replaceChildren();const title=document.createElement('strong');title.textContent=state.label;panel.append(title);if(state.conflicts?.length){const p=document.createElement('p');p.textContent='自动识别与已确认的信息存在差异，请展开核对。';panel.append(p);}for(const text of state.gaps){const p=document.createElement('p');p.textContent=text;panel.append(p);}panel.dataset.status=state.status;}
   const stale=document.querySelector('#qualification-stale');if(stale)stale.hidden=!result.qualificationStale;
   const facts=document.querySelector('#identified-facts');
   if(facts&&Array.isArray(result.identifiedFacts)){
    facts.replaceChildren();const dl=document.createElement('dl');
    for(const row of result.identifiedFacts){const div=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=row.label;dd.textContent=row.value;div.append(dt,dd);dl.append(div);}
    if(result.identifiedFacts.length)facts.append(dl);else{const p=document.createElement('p');p.textContent='尚无已识别事实。';facts.append(p);}
   }
   if(state&&!['pending','processing'].includes(state.status)){const link=document.createElement('a');link.href='/settings';link.textContent='查看识别结果';panel.append(link);return;}
  }catch{/* Keep the saved form and allow a later retry. */}
  if(++attempts<90)setTimeout(poll,4000);
 };
 setTimeout(poll,1500);
})();
