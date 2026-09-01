"use strict";

const assert = require("node:assert/strict");
const bonus = require("../assets/monthly-bonus-v44.js");

[
  [0, 0], [24, 0], [25, 40000], [26, 55000], [27, 70000],
  [28, 90000], [29, 110000], [30, 170000], [40, 170000],
  [41, 200000], [42, 215000], [43, 230000]
].forEach(([points, expected]) => assert.equal(bonus.amountForPoints(points), expected));

assert.deepEqual(bonus.calculateMonthlyBonus({ points: 25, installations: 18 }), {
  points: 25, installations: 18, baseTarget: 25, minimumInstallations: 19,
  pointsMissingToTarget: 0, installationsMissing: 1, targetReached: true,
  installationRequirementMet: false, eligible: false, scheduleAmount: 40000,
  estimatedBonus: 0, nextTier: { points: 26, missing: 1, amount: 55000 }
});
assert.equal(bonus.calculateMonthlyBonus({ points: 25, installations: 19 }).estimatedBonus, 40000);
assert.equal(bonus.calculateMonthlyBonus({ points: 41, installations: 19 }).nextTier.amount, 215000);

console.log("monthly bonus rules: ok");
