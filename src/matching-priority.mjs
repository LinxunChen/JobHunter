// Classify the existing explained match; each caller retains its own action gates.
export function matchingPriority(output) {
  if(output?.recommendation)return output.recommendation.level==='priority'?'direct_extension':output.recommendation.level==='consider'?'transfer_with_gaps':null;
  const technical=output?.technical,scope=output?.scope,business=output?.business;
  if(!['high','medium'].includes(technical?.level)||!['high','medium'].includes(scope?.level)||output.route==='uncertain'||!(technical.directExperiences?.length||technical.transferableAbilities?.length))return null;
  return technical.directExperiences?.length&&business?.directExperiences?.length&&business.level!=='low'?'direct_extension':'transfer_with_gaps';
}
