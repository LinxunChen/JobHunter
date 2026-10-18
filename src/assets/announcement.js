const form = document.querySelector('[data-announcement-form]');
if (form) form.addEventListener('submit', async event => {
  event.preventDefault();
  const message = form.querySelector('[role=status]');
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = '正在保存公告与附件…';
  try {
    const fields = new FormData(form);
    const attachments = [];
    const kinds = { txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    for (const file of fields.getAll('files')) {
      if (!file.size) continue;
      if (file.size > 8 * 1024 * 1024) throw new Error('单附件请控制在8MiB内');
      const contentBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('本机文件读取失败'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(file);
      });
      attachments.push({ name: file.name, mediaType: kinds[file.name.split('.').at(-1).toLowerCase()] ?? file.type, contentBase64 });
    }
    for (const name of String(fields.get('missingAttachments') ?? '').split(/\r?\n/)) if (name.trim()) attachments.push({ name: name.trim() });
    const input = Object.fromEntries(['title', 'originalText', 'sourceUrl', 'evidenceUse', 'publishedAt', ...(form.dataset.endpoint ? ['obtainedAt'] : [])].map(field => [field, fields.get(field)]));
    const response = await fetch(form.dataset.endpoint ?? '/api/announcements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, attachments }) });
    const saved = await response.json();
    if (!response.ok) throw new Error(saved.error ?? '保存失败');
    location.assign(`/announcements/${encodeURIComponent(saved.id)}`);
  } catch (error) { message.textContent = error.message; button.disabled = false; }
});
