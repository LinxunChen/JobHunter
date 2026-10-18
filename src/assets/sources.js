(() => {
 const editor=document.querySelector('#object-editor');if(!editor)return;
 const form=document.querySelector('#object-form'),error=document.querySelector('#editor-error'),progress=document.querySelector('#check-progress'),filters=document.querySelector('.source-filters');
 let returnFocus=null,pollTimer=null,runtimeTimer=null,starting=false,runtimeInFlight=false;
 const feedbackTargets=new Map();
 const open=dialog=>{returnFocus=document.activeElement;dialog.showModal();};
 const close=dialog=>{dialog.close();returnFocus?.focus();};
 document.querySelectorAll('[data-open-dialog]').forEach(button=>button.addEventListener('click',()=>open(document.getElementById(button.dataset.openDialog))));
 document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>close(button.closest('dialog'))));
 document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('close',()=>returnFocus?.focus()));
 filters.querySelectorAll('select').forEach(select=>select.addEventListener('change',()=>filters.requestSubmit()));
 const request=async(url,data)=>{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'操作失败，请重试');return value;
 };
 const edit=id=>{
  const row=id?document.querySelector(`[data-object-id="${CSS.escape(id)}"]`):null;
  form.reset();form.elements.id.value=id??'';form.elements.name.value=row?.dataset.name??'';form.elements.officialUrl.value=row?.dataset.url??'';form.elements.note.value=row?.dataset.note??'';
  document.querySelector('#editor-title').textContent=id?'编辑目标机构':'新增目标机构';
  const remove=document.querySelector('#remove-object');remove.hidden=!id;remove.textContent=row?.dataset.monitoring==='removed'?'恢复监控':'移出监控';remove.dataset.status=row?.dataset.monitoring==='removed'?'active':'removed';error.textContent='';
  open(editor);form.elements.name.focus();
 };
 document.querySelector('#add-object').addEventListener('click',()=>edit());
 document.querySelectorAll('[data-edit-object]').forEach(button=>button.addEventListener('click',()=>edit(button.dataset.editObject)));
 const save=async(fields)=>{
  const controls=[...form.querySelectorAll('button')];controls.forEach(button=>button.disabled=true);error.textContent='';
  try{const id=form.elements.id.value;await request('/api/monitoring-objects'+(id?'/'+encodeURIComponent(id):''),fields);location.reload();}
  catch(reason){error.textContent=reason.message;controls.forEach(button=>button.disabled=false);}
 };
 form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())save({name:form.elements.name.value,officialUrl:form.elements.officialUrl.value,note:form.elements.note.value});});
 document.querySelector('#remove-object').addEventListener('click',event=>save({monitoringStatus:event.currentTarget.dataset.status}));
 document.querySelectorAll('[data-toggle-object],[data-toggle-discovery]').forEach(input=>input.addEventListener('change',async()=>{
  const checked=input.checked,previous=!checked;input.disabled=true;
  const row=input.closest('tr'),status=row?.querySelector('[data-row-status]')??progress;
  try{
   await request(input.dataset.toggleObject?'/api/monitoring-objects/'+encodeURIComponent(input.dataset.toggleObject):'/api/discovery/'+encodeURIComponent(input.dataset.toggleDiscovery),input.dataset.toggleObject?{monitoringStatus:checked?'active':'paused'}:{enabled:checked});
   // Re-render counts, filtering, dialog state and disabled buttons from the same application result.
   location.reload();
  }catch(reason){input.checked=previous;status.textContent=reason.message;input.disabled=false;}
 }));
 const feedback=button=>button.closest('tr,.discovery-row')?.querySelector('[data-check-feedback]')??progress;
 const show=(node,text,href,label)=>{
  node.textContent=text;if(href){const link=document.createElement('a');link.href=href;link.textContent=' '+label;node.append(link);}
 };
 const time=value=>value?new Date(Date.parse(value)+28800000).toISOString().slice(0,16).replace('T',' '):'未记录';
 const refreshResults=async()=>{
  const response=await fetch(location.href,{cache:'no-store'});if(!response.ok)throw Error('结果刷新失败');
  const fresh=new DOMParser().parseFromString(await response.text(),'text/html');
  const revision=fresh.querySelector('#check-progress')?.dataset.revision;
  for(const selector of ['.runtime-panel','.changes-panel','.exceptions-panel']){
   const existing=document.querySelector(selector),next=fresh.querySelector(selector);
   // Keep an expanded diagnosis open while its current contents update.
   const opened=[...existing.querySelectorAll('details[open]')].map(node=>[...existing.querySelectorAll('details')].indexOf(node));
   existing.innerHTML=next.innerHTML;opened.forEach(index=>existing.querySelectorAll('details')[index]?.setAttribute('open',''));
  }
  document.querySelectorAll('[data-object-id]').forEach(row=>{
   const next=fresh.querySelector(`[data-object-id="${CSS.escape(row.dataset.objectId)}"]`),cell=row.querySelector('[data-source-state]');
   if(next&&cell)cell.innerHTML=next.querySelector('[data-source-state]').innerHTML;
   const dialog=document.getElementById('detail-'+row.dataset.objectId),nextDialog=fresh.getElementById('detail-'+row.dataset.objectId);
   if(dialog&&!dialog.open&&nextDialog){const button=dialog.querySelector('[data-close-dialog]');dialog.innerHTML=nextDialog.innerHTML;dialog.querySelector('[data-close-dialog]').replaceWith(button);}
  });
  for(const attribute of ['data-discovery-state','data-source-evidence'])document.querySelectorAll(`[${attribute}]`).forEach(node=>{
   const next=fresh.querySelector(`[${attribute}="${CSS.escape(node.getAttribute(attribute))}"]`);
   if(next){node.innerHTML=next.innerHTML;node.className=next.className;}
  });
  if(revision)progress.dataset.revision=revision;
 };
 const runtimePoll=async()=>{
  clearTimeout(runtimeTimer);if(document.hidden||runtimeInFlight)return;runtimeInFlight=true;
  try{const response=await fetch('/api/operations/progress',{cache:'no-store'});if(!response.ok)throw Error();const view=await response.json();
   if(document.hidden)return;
   const wasBusy=progress.dataset.sourceBusy==='true';
   if(view.revision!==progress.dataset.revision||Boolean(view.busy)!==wasBusy)await refreshResults();
   if(view.busy){
    const p=view.busy.progress;
    if(view.busy.runId&&p){const date=view.busy.date&&view.busy.date!==view.date?view.busy.date+' ':'';const text=`${date}每日周期已检查 ${p.checked}/${p.total} 个来源 · ${p.currentSourceName??p.currentStep??'准备检查'} · 已运行 ${p.elapsedMinutes} 分钟`;show(progress,text,'/runs','查看进度 →');const status=document.querySelector('[data-runtime-progress]');if(status)status.textContent=text;}
    else if(!progress.dataset.taskId)show(progress,'来源检查正在执行；完成后可立即检查');
    progress.dataset.runId=view.busy.runId??'';progress.dataset.sourceBusy='true';
   }else{progress.dataset.runId='';progress.dataset.sourceBusy='';if(wasBusy&&!progress.dataset.taskId)show(progress,'检查已结束，可立即检查需要的来源');}
   const signal=document.querySelector('[data-scheduler-status]'),activity=document.querySelector('[data-scheduler-activity]');
   if(signal){signal.textContent={checking:'调度在线',online:'调度在线',stale:'信号较旧',no_signal:'暂无后台信号'}[view.scheduler.status]??'待核验';signal.className=view.scheduler.status==='stale'?'warning':'';}
   if(activity)activity.textContent='最近活动 '+time(view.scheduler.lastActivityAt);
  }catch{show(progress,'进度暂未取得，请刷新查看持久记录','/runs','运行详情 →');}
  finally{runtimeInFlight=false;if(!document.hidden)runtimeTimer=setTimeout(runtimePoll,10000);}
 };
 const poll=async(id,node=progress,wanted=[])=>{
  clearTimeout(pollTimer);if(document.hidden)return;
  if(node!==progress)feedbackTargets.set(node,{id,wanted});
  try{const response=await fetch('/api/source-checks/'+encodeURIComponent(id));const task=await response.json();if(!response.ok)throw Error(task.error||'进度查询失败');
   const done=task.results?.length??0,total=task.sourceIds?.length??0;
   const text=task.status==='running'?`后台检查 ${done}/${total}${task.stage==='jobs'?' · 核验资格与匹配':task.currentSourceId?' · 正在检查当前来源':''}…`:`${{completed:'检查完成',partial:'已完成，有待处理',failed:'检查失败',interrupted:'检查中断'}[task.status]??'待确认'} · 已检查 ${done}/${total}${task.error?' · '+task.error:''}`;
   const updateFeedback=finished=>feedbackTargets.forEach((target,element)=>{
    if(target.id!==id)return;
    const included=target.wanted.every(sourceId=>task.sourceIds.includes(sourceId));
    const prefix=included?'':finished?'本次任务未包含本机构，请再次点击检查。':'现有任务未包含本机构；完成后请再检查。';
    show(element,prefix+text+(finished?'；结果已更新':''),finished?null:'#check-progress','查看进度 →');
    if(finished)feedbackTargets.delete(element);
   });
   show(progress,text);updateFeedback(false);
   if(task.status==='running')pollTimer=setTimeout(()=>poll(id,node,wanted),1800);
   else{progress.dataset.taskId='';document.querySelectorAll('[data-check-sources]').forEach(button=>button.removeAttribute('aria-busy'));await refreshResults();show(progress,text+'；页面结果已更新');updateFeedback(true);}
  }catch(reason){show(progress,reason.message+'，可刷新查看持久记录');feedbackTargets.forEach((target,element)=>{if(target.id===id)show(element,reason.message+'，可刷新查看持久记录');});}
 };
 document.querySelectorAll('[data-check-sources]').forEach(button=>button.addEventListener('click',async()=>{
  if(starting)return;
  const node=feedback(button),wanted=button.dataset.checkSources==='all'?[]:button.dataset.checkSources.split(',');
  if(progress.dataset.taskId){show(node,'查看正在执行的任务…');return poll(progress.dataset.taskId,node,wanted);}
  starting=true;button.disabled=true;show(node,'正在启动检查…');show(progress,'正在启动检查…');
  try{const value=await request('/api/source-checks',wanted.length?{sourceIds:wanted}:{});
   if(value.status==='busy'){show(node,'每日周期正在运行，本次未另开检查','/runs','查看现有进度 →');show(progress,'每日周期正在运行，本次未另开检查','/runs','查看现有进度 →');progress.dataset.runId=value.runId;runtimePoll();return;}
   progress.dataset.taskId=value.id;button.setAttribute('aria-busy','true');poll(value.id,node,wanted);
  }catch(reason){show(node,reason.message);show(progress,reason.message);}
  finally{starting=false;const row=button.closest('tr');button.disabled=row?row.dataset.integration!=='implemented'||row.dataset.monitoring!=='active':button.closest('.discovery-row')?!button.closest('.discovery-row').querySelector('input').checked:false;}
 }));
 document.querySelectorAll('[data-resume-task]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const task=await request('/api/source-checks/'+encodeURIComponent(button.dataset.resumeTask)+'/resume',{});if(task.status==='busy'){progress.dataset.runId=task.runId;runtimePoll();return;}progress.dataset.taskId=task.id;poll(task.id);}catch(reason){show(progress,reason.message);}finally{button.disabled=false;}}));
 document.addEventListener('visibilitychange',()=>{clearTimeout(runtimeTimer);clearTimeout(pollTimer);if(!document.hidden){if(progress.dataset.taskId)poll(progress.dataset.taskId);runtimePoll();}});
 if(progress.dataset.taskId)poll(progress.dataset.taskId);runtimePoll();
})();
