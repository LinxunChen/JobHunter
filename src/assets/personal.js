document.addEventListener('change', async event => {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement) || !checkbox.dataset.action) return;
  const section = checkbox.closest('[data-personal-controls]');
  const status = section.querySelector('[role="status"]');
  const value = checkbox.checked;
  const action = checkbox.dataset.action;
  const controls = section.querySelectorAll('input[data-action]');
  controls.forEach(control => { control.disabled = true; });
  status.textContent = '正在保存…';
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(checkbox.dataset.jobId)}/${action === 'applied' ? 'applied' : 'personal'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [action]: value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    status.textContent = '已保存';
    location.reload();
  } catch (error) {
    checkbox.checked = !value;
    controls.forEach(control => { control.disabled = false; });
    status.textContent = `保存失败：${error.message}。请重试。`;
  }
});

// One preference applies to each view of the same complete job table.
const columnPreferenceKey = 'jobhunter.job-columns.v2';
function setJobColumn(table, column, visible) {
  table.querySelectorAll('[data-job-column]').forEach(cell => {
    if (cell.dataset.jobColumn === column) cell.hidden = !visible;
  });
  const visibleColumns=[...table.querySelectorAll('thead [data-job-column]')].filter(cell=>!cell.hidden).length;
  table.querySelectorAll('[data-job-group-heading]').forEach(heading=>{heading.colSpan=visibleColumns;});
}
document.querySelectorAll('[data-job-table]').forEach(table => {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(columnPreferenceKey)); } catch { /* Browser storage may be unavailable. */ }
  table.querySelectorAll('[data-job-column-toggle]').forEach(toggle => {
    if (!toggle.disabled && typeof saved?.[toggle.dataset.jobColumnToggle] === 'boolean') toggle.checked = saved[toggle.dataset.jobColumnToggle];
    setJobColumn(table, toggle.dataset.jobColumnToggle, toggle.checked);
    toggle.addEventListener('change', () => {
      setJobColumn(table, toggle.dataset.jobColumnToggle, toggle.checked);
      const preference = {};
      table.querySelectorAll('[data-job-column-toggle]').forEach(control => { preference[control.dataset.jobColumnToggle] = control.checked; });
      try { localStorage.setItem(columnPreferenceKey, JSON.stringify(preference)); } catch { /* Current choice still works without persistence. */ }
    });
  });
});
