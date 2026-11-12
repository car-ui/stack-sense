import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { recommend } from './engine.mjs';

const models = ['managed_cloud', 'self_hosted_cloud_vm', 'on_premise', 'air_gapped'];
const preferences = ['any', 'aws', 'gcp', 'azure', 'none'];
const locations = ['none', 'india', 'eu', 'us', 'other'];
const budgets = [0, 150, 3000];
const budgetPolicies = ['soft', 'hard_cap'];
const fixtures = await Promise.all(Array.from({ length: 6 }, (_, i) =>
  readFile(new URL('./scenarios/P' + (i + 1) + '.json', import.meta.url), 'utf8').then(JSON.parse)));
const elapsed = [];
const counts = {};

for (const base of fixtures) {
  for (const model of models) for (const provider of preferences) for (const region of locations) for (const budget of budgets) for (const budgetPolicy of budgetPolicies) {
    const input = {
      ...base,
      infrastructure: {
        ...base.infrastructure, deployment_model: model, cloud_preference: provider, data_residency: region,
      },
      budget: { monthly_infra_usd: budget },
      context: { ...base.context, budget_policy: budgetPolicy },
    };
    const started = performance.now();
    const result = recommend(input);
    elapsed.push(performance.now() - started);
    counts[result.status] = (counts[result.status] || 0) + 1;
    assert.deepEqual(result, recommend(structuredClone(input)));
    const local = model === 'on_premise' || model === 'air_gapped';
    const blocked = (local && !['any', 'none'].includes(provider)) || (!local && provider === 'none') ||
      region === 'other' || (base.compliance.includes('rbi_localisation') && !['none', 'india'].includes(region));
    if (blocked) assert.equal(result.status, 'infeasible');
    if (!result.stack) {
      assert.equal(result.status, 'infeasible');
      assert.ok(result.warnings.some(({ severity }) => severity === 'critical'));
      continue;
    }
    assert.equal(result.deployment.model, model);
    if (local) assert.equal(result.deployment.provider, 'local');
    if (!['any', 'none'].includes(provider)) assert.equal(result.deployment.provider, provider);
    const band = result.estimated_monthly_cost_usd;
    assert.ok(Number.isFinite(band.min) && Number.isFinite(band.max) && band.min <= band.max);
    assert.equal(result.decision_trace.eligible_hosting.filter(({ selected }) => selected).length, 1);
    assert.ok(band.max <= budget || result.warnings.some(({ code }) => code.startsWith('BUDGET_')));
    if (budgetPolicy === 'hard_cap') assert.ok(band.max <= budget);
    if (base.compliance.includes('rbi_localisation')) assert.match(result.deployment.region, /Mumbai|Pune|INDIA/);
  }
}

elapsed.sort((a, b) => a - b);
const percentile = (p) => Number(elapsed[Math.ceil(elapsed.length * p) - 1].toFixed(3));
console.log(JSON.stringify({
  scenario_variants: elapsed.length, deterministic_replays: elapsed.length, statuses: counts,
  node: process.version, os: process.platform, median_ms: percentile(0.5), p95_ms: percentile(0.95),
  max_ms: percentile(1),
}, null, 2));
