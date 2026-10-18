// These are source evidence mappings, not extraction rules or official recruitment batch IDs.
export const bocAssociationRules = [{
  id: 'boc-fire-social-2026',
  announcementUrl: 'https://www.boc.cn/aboutboc/bi4/202607/t20260721_25680323.html',
  platformUrl: 'https://chrcmp.chinahr.com/pages/boc-social/',
  scopeQuote: '境内分行消防安全岗。', jobTitle: '消防安全岗', label: '2026消防专项',
  projectId: '5a5eca587465574d615d99cc',
  institutionRoots: [{ id: '62972609fe6d10053ae18c76', name: '北京市分行' }],
}];

export function matchBocAssociation(post, companies, projectToken, platformUrl, rules) {
  const company = companies.find(item => item.id === post.companyId);
  if (!company || company.name !== post.companyName || company.token !== projectToken) return null;
  const ancestors = [], visited = new Set();
  let node = company;
  while (node && ancestors.length < 32) {
    if (visited.has(node.id) || node.projectId !== company.projectId || node.token !== projectToken) return null;
    visited.add(node.id);
    ancestors.push({ id: node.id, name: node.name, parentId: node.parentId ?? null, projectId: node.projectId });
    node = companies.find(item => item.id === node.parentId);
  }
  const matches = rules.filter(rule => rule.platformUrl === platformUrl && rule.jobTitle === post.name && Array.isArray(post.jobLabel) && post.jobLabel.includes(rule.label) && rule.projectId === company.projectId && rule.institutionRoots.some(root => ancestors.some(item => item.id === root.id && item.name === root.name)));
  if (matches.length !== 1) return null;
  return { rule: matches[0], scope: { ruleId: matches[0].id, label: matches[0].label, jobTitle: post.name, platformUrl, projectId: company.projectId, ancestors } };
}

export function hasBocPlatformLink(html, baseUrl, platformUrl) {
  const normalize = value => { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.hostname + url.pathname.replace(/\/$/, '') : null; };
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].some(match => {
    try { return normalize(new URL(match[1], baseUrl).href) === normalize(platformUrl); } catch { return false; }
  });
}
