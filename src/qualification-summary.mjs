// Return a new list for summaries; persisted checks keep their original order.
export function prioritizedPendingChecks(checks) {
  const rank = check => ['requiredEducation','requiredCertificate','requiredMonths','domain','maxAge','minimumBirthDate','maximumBirthDate'].some(key => check.facts?.[key] != null && check.facts[key] !== '') ? 2 : check.gaps?.some(gap => typeof gap === 'string' && gap.trim()) ? 1 : 0;
  return checks.filter(check => check.status === 'pending')
    .sort((a, b) => rank(b) - rank(a));
}
