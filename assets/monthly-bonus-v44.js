(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BPGOMonthlyBonus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BASE_TARGET = 25;
  const MIN_INSTALLATIONS = 19;

  function amountForPoints(value) {
    const points = Math.max(0, Number(value) || 0);
    if (points < 25) return 0;
    if (points < 26) return 40000;
    if (points < 27) return 55000;
    if (points < 28) return 70000;
    if (points < 29) return 90000;
    if (points < 30) return 110000;
    if (points <= 40) return 170000;
    if (points < 42) return 200000;
    return 200000 + Math.floor(points - 41) * 15000;
  }

  function nextTierForPoints(value) {
    const points = Math.max(0, Number(value) || 0);
    const tiers = [25, 26, 27, 28, 29, 30, 41, 42];
    const next = tiers.find((tier) => points < tier);
    if (next) return { points: next, missing: Math.max(0, next - points), amount: amountForPoints(next) };
    const nextPoint = Math.floor(points) + 1;
    return { points: nextPoint, missing: nextPoint - points, amount: amountForPoints(nextPoint) };
  }

  function calculateMonthlyBonus(input) {
    const points = Math.max(0, Number(input && input.points) || 0);
    const installations = Math.max(0, Math.floor(Number(input && input.installations) || 0));
    const scheduleAmount = amountForPoints(points);
    const installationRequirementMet = installations >= MIN_INSTALLATIONS;
    const targetReached = points >= BASE_TARGET;
    return {
      points,
      installations,
      baseTarget: BASE_TARGET,
      minimumInstallations: MIN_INSTALLATIONS,
      pointsMissingToTarget: Math.max(0, BASE_TARGET - points),
      installationsMissing: Math.max(0, MIN_INSTALLATIONS - installations),
      targetReached,
      installationRequirementMet,
      eligible: targetReached && installationRequirementMet,
      scheduleAmount,
      estimatedBonus: installationRequirementMet ? scheduleAmount : 0,
      nextTier: nextTierForPoints(points)
    };
  }

  return { BASE_TARGET, MIN_INSTALLATIONS, amountForPoints, nextTierForPoints, calculateMonthlyBonus };
});
