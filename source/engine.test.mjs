import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recommend } from './engine.mjs';

const load = async (id) => JSON.parse(await readFile(new URL('./scenarios/' + id + '.json', import.meta.url), 'utf8'));
const mandatory = () => ({
  project: { type: 'web_app', platforms: ['web'] },
  scale: { users_at_launch: 200, users_12_months: 1000 },
  team: { size: 2, experience: 'intermediate', languages: ['python'] },
  budget: { monthly_infra_usd: 120 },
  timeline: { mvp_weeks: 6 },
});

test('six official scenarios produce stable and distinct plans', async () => {
  const results = [];
  for (let i = 1; i <= 6; i++) {
    const input = await load('P' + i);
    const output = recommend(input);
    assert.match(output.status, /^ok/);
    assert.deepEqual(recommend(structuredClone(input)), output);
    assert.deepEqual(recommend({ ...input, scenario_id: 'unseen' }).stack, output.stack);
    for (const part of [...['frontend', 'backend', 'database', 'hosting'].map((key) => output.stack[key]), ...output.stack.supporting]) {
      assert.ok(part.choice && part.justification && part.driven_by.length && part.alternatives.length && part.tradeoffs.length);
    }
    assert.ok(output.estimated_monthly_cost_usd.min <= output.estimated_monthly_cost_usd.max);
    results.push(output);
  }
  assert.equal(new Set(results.map((r) => JSON.stringify(r.stack))).size, 6);
  const [p1, p2, p3, p4, p5, p6] = results;
  assert.equal(p1.architecture_style, 'static');
  assert.equal(p1.stack.backend.choice, 'None');
  assert.equal(p1.stack.database.choice, 'None');
  assert.equal(p1.estimated_monthly_cost_usd.max, 0);
  assert.match(p2.deployment.region, /Mumbai|India/);
  assert.match(p2.stack.frontend.choice, /Next.js.*React Native/);
  assert.ok(p3.stack.supporting.some((s) => /Yjs/.test(s.choice)));
  assert.equal(p4.deployment.provider, 'aws');
  assert.match(p4.deployment.region, /Mumbai/);
  assert.ok(p4.warnings.some((w) => w.code === 'PCI_SCOPE'));
  assert.equal(p5.architecture_style, 'hybrid');
  assert.match(p5.stack.database.choice, /Existing Microsoft SQL Server/);
  assert.ok(p6.stack.supporting.some((s) => /sync outbox/.test(s.choice)));
});

test('mandatory-only scenario records derived sizing and defaults', () => {
  const output = recommend(mandatory());
  assert.match(output.status, /^ok/);
  assert.ok(output.assumptions.some((entry) => entry.includes('2%')));
  assert.ok(output.assumptions.some((entry) => entry.includes('0.25 per')));
  assert.ok(output.assumptions.some((entry) => entry.includes('steady')));
});

test('strict validation collects missing fields, invalid types and indexed entries', () => {
  assert.equal(recommend(null).validation_errors[0].field, '$');
  assert.ok(recommend({}).validation_errors.length >= 9);
  const input = mandatory();
  input.project.type = 'spaceship';
  input.project.platforms = ['web', 'space'];
  input.scale.users_12_months = -2;
  input.team.languages = [null, 'Python'];
  input.budget.monthly_infra_usd = '120';
  input.requirements = { availability: 99.9, payments: 'false' };
  input.priorities = { cost: 7 };
  const output = recommend(input);
  assert.equal(output.status, 'invalid_input');
  assert.equal(output.stack, null);
  assert.deepEqual(output.validation_errors.map(({ field }) => field), [
    'project.type', 'project.platforms[1]', 'scale.users_12_months', 'team.languages[0]',
    'team.languages[1]', 'budget.monthly_infra_usd', 'requirements.payments', 'requirements.availability', 'priorities.cost',
  ]);
});

test('provider, RBI region and incompatible internet dependencies fail closed', () => {
  const input = mandatory();
  input.compliance = ['rbi_localisation'];
  input.requirements = { payments: true };
  input.infrastructure = { deployment_model: 'air_gapped', cloud_preference: 'aws', data_residency: 'eu' };
  const output = recommend(input);
  assert.equal(output.status, 'infeasible');
  assert.equal(output.stack, null);
  for (const code of ['PROVIDER_MODEL_CONFLICT', 'RBI_REGION_CONFLICT', 'AIR_GAP_EXTERNAL_CHANNEL']) {
    assert.ok(output.warnings.some((item) => item.code === code && item.severity === 'critical'));
  }
});

test('supported offline facility stays on operator-managed infrastructure', () => {
  const input = mandatory();
  input.infrastructure = { deployment_model: 'air_gapped', cloud_preference: 'none', data_residency: 'other' };
  assert.equal(recommend(input).status, 'infeasible');
  input.context = { residency_region: 'Approved Singapore facility' };
  input.requirements = { auth: 'enterprise_sso', file_media_storage: true, full_text_search: true };
  const result = recommend(input);
  assert.equal(result.deployment.provider, 'local');
  assert.match(result.stack.hosting.choice, /Podman/);
  assert.match(result.stack.database.choice, /PostgreSQL/);
  assert.match(result.stack.supporting.find((s) => s.layer === 'storage').choice, /SeaweedFS/);
  assert.match(result.stack.supporting.find((s) => s.layer === 'auth').choice, /Keycloak/);
  assert.ok(result.stack.supporting.every((s) => !/Cloudflare|GitHub|Stripe|Entra/.test(s.choice)));
});

test('large dynamic workload with zero budget is infeasible', () => {
  const input = mandatory();
  input.budget.monthly_infra_usd = 0;
  input.scale.peak_concurrent_users = 750_000;
  const result = recommend(input);
  assert.equal(result.status, 'infeasible');
  assert.ok(result.warnings.some((w) => w.code === 'ZERO_BUDGET_DYNAMIC'));
  assert.ok(result.estimated_monthly_cost_usd.min > 0);
});

test('high volume of public prebuilt content stays static', async () => {
  const input = await load('P1');
  input.scale.users_12_months = 2_000_000;
  input.scale.peak_concurrent_users = 25_000;
  input.scale.traffic_pattern = 'seasonal';
  const output = recommend(input);
  assert.equal(output.architecture_style, 'static');
  assert.equal(output.stack.backend.choice, 'None');
  assert.ok(output.warnings.some((w) => w.code === 'EDGE_QUOTA_CHECK'));
});

test('language and database workload changes affect the relevant layer', async () => {
  const input = await load('P6');
  const before = recommend(input);
  input.team.languages = ['go'];
  assert.notEqual(recommend(input).stack.backend.choice, before.stack.backend.choice);
  const api = mandatory();
  api.project = { type: 'api_platform', platforms: ['api_only'] };
  api.infrastructure = { cloud_preference: 'aws' };
  api.context = { data_profile: 'document' };
  const document = recommend(api);
  assert.match(document.stack.database.choice, /DynamoDB/);
  assert.equal(document.stack.frontend.choice, 'None');
  api.requirements = { payments: true };
  assert.match(recommend(api).stack.database.choice, /PostgreSQL/);
});

test('legacy lifecycle warning prevents reuse of retired SQL Server', async () => {
  const input = await load('P5');
  input.infrastructure.existing_systems.push('SQL Server 2014', 'Node.js 18', 'Google Cloud IoT Core');
  const output = recommend(input);
  assert.ok(output.warnings.some((w) => w.code === 'RETIRED_EXISTING_SYSTEM'));
  assert.doesNotMatch(output.stack.database.choice, /Existing/);
  assert.equal(output.deployment.provider, 'azure');
});

test('99.99 target requires an operations owner and missing budget is validation error', () => {
  const input = mandatory();
  input.team = { size: 1, experience: 'beginner', languages: [] };
  input.requirements = { availability: '99.99' };
  const output = recommend(input);
  assert.equal(output.status, 'infeasible');
  assert.ok(output.warnings.some((w) => w.code === 'HA_OPERATIONS_RISK' && w.severity === 'critical'));
  delete input.budget;
  assert.equal(recommend(input).status, 'invalid_input');
});

test('static search and offline reading have no dynamic data-plane dependencies', async () => {
  const input = await load('P1');
  input.requirements.full_text_search = true;
  input.requirements.offline_support = true;
  input.context = { monthly_egress_gb: 120 };
  const result = recommend(input);
  assert.equal(result.stack.database.choice, 'None');
  assert.equal(result.stack.backend.choice, 'None');
  assert.ok(result.stack.supporting.some((part) => part.choice === 'Pagefind'));
  assert.ok(result.stack.supporting.some((part) => part.choice === 'Service Worker Cache API'));
  assert.ok(result.decision_trace.excluded_hosting.some(({ choice, reason }) =>
    choice === 'GitHub Pages' && reason.includes('100 GB')));
  assert.equal(result.estimated_monthly_cost_usd.max, 0);
});

test('explicit egress increases modeled costs without changing a fixed provider', () => {
  const input = mandatory();
  input.infrastructure = { cloud_preference: 'aws', data_residency: 'india' };
  const baseline = recommend(input);
  input.context = { monthly_egress_gb: 1000 };
  const metered = recommend(input);
  assert.equal(metered.deployment.provider, 'aws');
  assert.equal(metered.deployment.region, baseline.deployment.region);
  const row = metered.estimated_monthly_cost_usd.breakdown.find(({ driver }) => driver.startsWith('Internet egress'));
  assert.deepEqual([row.min, row.max], [70, 150]);
  assert.equal(metered.estimated_monthly_cost_usd.max - baseline.estimated_monthly_cost_usd.max, 150);
});

test('search corpus changes search topology separately from total media storage', () => {
  const input = mandatory();
  input.infrastructure = { cloud_preference: 'aws' };
  input.scale.data_volume_gb_12_months = 1000;
  input.requirements = { full_text_search: true, file_media_storage: true };
  const small = recommend(input);
  assert.equal(small.stack.supporting.find((part) => part.layer === 'search').choice, 'PostgreSQL full-text search');
  input.context = { search_corpus_gb: 600 };
  const large = recommend(input);
  assert.equal(large.stack.supporting.find((part) => part.layer === 'search').choice, 'OpenSearch');
  assert.ok(large.estimated_monthly_cost_usd.breakdown.some((row) => row.driver === 'Dedicated search nodes'));
  assert.equal(large.stack.database.choice, small.stack.database.choice);
});

test('auth and realtime selections account for production state dependencies', () => {
  const input = mandatory();
  input.project = { type: 'api_platform', platforms: ['api_only'] };
  input.context = { data_profile: 'document' };
  input.infrastructure = { cloud_preference: 'aws' };
  input.requirements = { auth: 'email_password' };
  const result = recommend(input);
  assert.match(result.stack.database.choice, /DynamoDB/);
  assert.ok(result.estimated_monthly_cost_usd.breakdown.some((row) => row.driver === 'Separate PostgreSQL store for identity'));
  input.context.vendor_lock_in = 'low';
  assert.match(recommend(input).stack.database.choice, /PostgreSQL/);
  input.infrastructure.cloud_preference = 'gcp';
  input.requirements.realtime = true;
  const sockets = recommend(input);
  assert.ok(sockets.stack.supporting.some((part) => part.layer === 'cache' && part.choice === 'Valkey'));
  assert.ok(sockets.estimated_monthly_cost_usd.breakdown.some((row) => row.driver.includes('Valkey')));
});

test('recognized cloud integrations are hard conflicts in a disconnected facility', () => {
  const input = mandatory();
  input.infrastructure = { deployment_model: 'air_gapped', existing_systems: ['Microsoft 365', 'On-site LDAP'] };
  const blocked = recommend(input);
  assert.equal(blocked.status, 'infeasible');
  assert.ok(blocked.warnings.some((w) => w.code === 'LOCAL_EXISTING_SAAS_CONFLICT' && w.severity === 'critical'));
  input.infrastructure.existing_systems.shift();
  assert.equal(recommend(input).deployment.provider, 'local');
});

test('host trace preserves data-plane policy and reconciles winner and cost', async () => {
  const p4 = recommend(await load('P4'));
  const { eligible_hosting: eligible, excluded_hosting: excluded } = p4.decision_trace;
  assert.equal(eligible.length, 1);
  assert.ok(eligible[0].selected);
  assert.equal(eligible[0].choice, p4.stack.hosting.choice);
  assert.equal(eligible[0].max_usd, p4.estimated_monthly_cost_usd.max);
  assert.ok(excluded.some((row) => row.choice === 'Google Cloud Run' && /provider/.test(row.reason)));
  const gates = p4.deployment.boundary.launch_gates;
  assert.ok(gates.some((gate) => gate.gate === 'pci_dss' && gate.evidence.includes('aws.amazon.com')));
  assert.ok(gates.some((gate) => gate.gate === 'payment_processor'));
  assert.ok(p4.deployment.boundary.core_data_services.includes(p4.stack.database.choice));
});

test('scored runner-up explains the margin with scenario-specific factors', async () => {
  const result = recommend(await load('P3'));
  const alternative = result.stack.backend.alternatives[0];
  assert.ok(alternative.score_gap > 0);
  assert.ok(alternative.factors.some((factor) => factor.field === 'requirements.multi_tenant' && factor.points > 0));
  assert.match(alternative.why_not, /tenant/i);
});

const publicDirectory = () => ({
  ...mandatory(),
  project: { name: 'Community directory', type: 'api_platform', platforms: ['api_only'] },
  scale: { users_at_launch: 100, users_12_months: 800, peak_concurrent_users: 16,
    workload: 'read_heavy', data_volume_gb_12_months: 0.1 },
  team: { size: 1, experience: 'intermediate', languages: ['typescript'] },
  budget: { monthly_infra_usd: 0 },
  requirements: { availability: '99' },
  context: { peak_day_requests: 3000, budget_policy: 'hard_cap' },
});

test('small public API can fit a modeled zero budget with verified profile limits', () => {
  const result = recommend(publicDirectory());
  assert.equal(result.status, 'ok_with_warnings');
  assert.equal(result.architecture_style, 'serverless');
  assert.equal(result.stack.frontend.choice, 'None');
  assert.match(result.stack.backend.choice, /Hono/);
  assert.equal(result.stack.database.choice, 'Cloudflare D1 Free');
  assert.equal(result.stack.hosting.choice, 'Cloudflare Workers Free');
  assert.equal(result.estimated_monthly_cost_usd.max, 0);
  assert.ok(result.warnings.some(({ code }) => code === 'EDGE_API_FREE_LIMITS'));
  assert.ok(result.deployment.boundary.launch_gates.some(({ gate }) => gate === 'free_plan_headroom'));
});

test('free dynamic profile rejects excess demand, dependencies, residency and strict SLOs', () => {
  for (const modify of [
    (input) => { input.context.peak_day_requests = 40001; },
    (input) => { input.scale.data_volume_gb_12_months = 0.251; },
    (input) => { input.infrastructure = { data_residency: 'india' }; },
    (input) => { input.infrastructure = { cloud_preference: 'aws' }; },
    (input) => { input.requirements.auth = 'email_password'; },
    (input) => { input.requirements.p95_latency_ms = 60; },
    (input) => { input.compliance = ['soc2']; },
  ]) {
    const input = publicDirectory();
    modify(input);
    const blocked = recommend(input);
    assert.equal(blocked.status, 'infeasible');
    assert.equal(blocked.stack, null);
    assert.ok(blocked.decision_trace.excluded_hosting.some(({ choice }) => choice === 'Cloudflare Workers Free'));
  }
});

test('hard cap changes the realtime plan without changing EU placement', async () => {
  const input = await load('P3');
  const soft = recommend(input);
  assert.equal(soft.estimated_monthly_cost_usd.budget_fit, 'overlaps_budget');
  input.context = { budget_policy: 'hard_cap' };
  const capped = recommend(input);
  assert.equal(capped.deployment.provider, 'gcp');
  assert.match(capped.deployment.region, /Belgium/);
  assert.equal(capped.stack.frontend.choice, soft.stack.frontend.choice);
  assert.equal(capped.stack.backend.choice, soft.stack.backend.choice);
  assert.ok(capped.estimated_monthly_cost_usd.max <= input.budget.monthly_infra_usd);
  assert.ok(capped.decision_trace.excluded_hosting.some(({ choice, reason }) =>
    choice.includes('Fargate') && /hard cap/.test(reason)));
  assert.match(capped.stack.hosting.alternatives[0].why_not, /hard cap/);
  assert.ok(capped.warnings.some(({ code }) => code === 'CLOUD_RUN_SOCKET_LIMITS'));
  assert.equal(soft.budget_alternative.status, 'available');
  assert.equal(soft.budget_alternative.stack.hosting, capped.stack.hosting.choice);
  assert.equal(soft.budget_alternative.estimated_monthly_cost_usd.max, capped.estimated_monthly_cost_usd.max);
  assert.ok(soft.budget_alternative.new_tradeoffs.some(({ code }) => code === 'CLOUD_RUN_SOCKET_LIMITS'));
  assert.equal(capped.budget_alternative, undefined);
});

test('budget comparison explains when a strict cap has no compatible stack', async () => {
  for (const id of ['P2', 'P6']) {
    const input = await load(id);
    const soft = recommend(input);
    assert.equal(soft.budget_alternative.status, 'unavailable');
    assert.match(soft.budget_alternative.reason, /lowest modeled ceiling/);
    assert.equal(soft.budget_alternative.budget_usd, input.budget.monthly_infra_usd);
  }
});

test('hard cap never substitutes an unapproved provider for a regulated workload', async () => {
  const input = await load('P4');
  input.context = { budget_policy: 'hard_cap' };
  input.budget.monthly_infra_usd = 500;
  const capped = recommend(input);
  assert.equal(capped.status, 'infeasible');
  assert.equal(capped.stack, null);
  assert.ok(capped.warnings.some(({ code, severity }) => code === 'BUDGET_HARD_CAP' && severity === 'critical'));
  assert.ok(capped.decision_trace.excluded_hosting.some(({ choice, reason }) =>
    choice === 'Google Cloud Run' && /explicit provider/.test(reason)));
});

test('hard cap checks other compatible databases before eliminating a host', () => {
  const input = mandatory();
  input.project = { type: 'api_platform', platforms: ['api_only'] };
  input.infrastructure = { cloud_preference: 'aws' };
  input.requirements = { auth: 'email_password' };
  input.context = { data_profile: 'document' };
  const preferred = recommend(input);
  assert.match(preferred.stack.database.choice, /DynamoDB/);
  input.context.budget_policy = 'hard_cap';
  input.budget.monthly_infra_usd = 155;
  const capped = recommend(input);
  assert.match(capped.stack.database.choice, /PostgreSQL/);
  assert.match(capped.stack.database.alternatives[0].choice, /DynamoDB/);
  assert.match(capped.stack.database.alternatives[0].why_not, /hard cap/);
  assert.ok(capped.estimated_monthly_cost_usd.max <= 155);
});

test('RAG never promises pgvector while selecting SQLite or existing SQL Server', () => {
  const input = mandatory();
  input.scale = { users_at_launch: 30, users_12_months: 40, peak_concurrent_users: 10,
    data_volume_gb_12_months: 2 };
  input.infrastructure = { deployment_model: 'self_hosted_cloud_vm', cloud_preference: 'aws',
    data_residency: 'india', existing_systems: [] };
  input.requirements = { ml_features: 'llm_rag' };
  input.context = { budget_policy: 'hard_cap' };
  input.budget.monthly_infra_usd = 500;
  const tooSmall = recommend(input);
  assert.equal(tooSmall.status, 'infeasible');
  assert.ok(tooSmall.warnings.some(({ code }) => code === 'BUDGET_HARD_CAP'));
  input.budget.monthly_infra_usd = 600;
  const rag = recommend(input);
  assert.match(rag.stack.database.choice, /PostgreSQL/);
  assert.match(rag.stack.supporting.find(({ layer }) => layer === 'ml').choice, /pgvector/);
  input.infrastructure = { deployment_model: 'managed_cloud', cloud_preference: 'azure',
    data_residency: 'india', existing_systems: ['On-prem SQL Server 2019'] };
  input.context = {};
  const legacy = recommend(input);
  assert.match(legacy.stack.database.choice, /PostgreSQL/);
  assert.doesNotMatch(legacy.stack.database.choice, /Existing Microsoft SQL Server/);
});

test('capability variations keep selected services compatible with their data store', async () => {
  let viable = 0;
  for (let i = 1; i <= 6; i++) {
    const base = await load('P' + i);
    for (const model of ['managed_cloud', 'self_hosted_cloud_vm', 'on_premise', 'air_gapped']) {
      for (const ml of ['none', 'inference_api', 'llm_rag']) {
        for (const search of [false, true]) {
          const input = structuredClone(base);
          input.infrastructure = { ...input.infrastructure, deployment_model: model,
            cloud_preference: ['on_premise', 'air_gapped'].includes(model) ? 'none' : 'any' };
          input.requirements = { ...input.requirements, ml_features: ml, full_text_search: search };
          const result = recommend(input);
          if (!result.stack) continue;
          viable++;
          const { database, supporting } = result.stack;
          if (ml === 'llm_rag') {
            assert.match(database.choice, /PostgreSQL/);
            assert.ok(supporting.some(({ layer, choice }) => layer === 'ml' && /pgvector/.test(choice)));
          }
          const nativeSearch = supporting.find(({ layer, choice }) => layer === 'search' &&
            /PostgreSQL full-text search|SQLite FTS5/.test(choice));
          if (nativeSearch) {
            assert.match(database.choice, nativeSearch.choice.startsWith('SQLite') ? /SQLite/ : /PostgreSQL/);
          }
          if (['on_premise', 'air_gapped'].includes(model)) {
            assert.equal(result.deployment.provider, 'local');
            assert.ok(supporting.every(({ choice }) => !/Cloudflare|Stripe|Razorpay|Microsoft Entra|Amazon S3|Azure Blob/.test(choice)));
          }
        }
      }
    }
  }
  assert.ok(viable >= 40);
});

test('uptime does not imply recovery targets and slower objectives use PITR', () => {
  const input = mandatory();
  const baseline = recommend(input);
  assert.equal(baseline.recovery_plan, undefined);
  input.context = { recovery_point_minutes: 30, recovery_time_minutes: 240 };
  const restore = recommend(input);
  assert.equal(restore.recovery_plan.strategy, 'point_in_time_restore');
  assert.equal(restore.recovery_plan.verification, 'pending_restore_drill');
  assert.deepEqual(restore.recovery_plan.targets_minutes, { max_data_loss: 30, max_service_downtime: 240 });
  assert.equal(restore.estimated_monthly_cost_usd.max, baseline.estimated_monthly_cost_usd.max);
  assert.ok(restore.warnings.some(({ code }) => code === 'RECOVERY_DRILL_PENDING'));
});

test('a staffed zero-loss zonal request uses synchronous managed PostgreSQL and prices redundancy', () => {
  const input = mandatory();
  input.team.has_devops = true;
  input.infrastructure = { cloud_preference: 'gcp', data_residency: 'india' };
  const baseline = recommend(input);
  input.context = { recovery_point_minutes: 0, recovery_time_minutes: 20 };
  const standby = recommend(input);
  assert.equal(standby.recovery_plan.strategy, 'synchronous_zonal_standby');
  assert.equal(standby.recovery_plan.targets_minutes.max_data_loss, 0);
  assert.equal(standby.recovery_plan.secondary_region, null);
  assert.match(standby.deployment.region, /Mumbai/);
  assert.ok(standby.estimated_monthly_cost_usd.max > baseline.estimated_monthly_cost_usd.max);
  input.requirements = { file_media_storage: true };
  assert.equal(recommend(input).status, 'infeasible');
});

test('regional standby preserves the provider and geography, and flows into a hard cap', () => {
  const input = mandatory();
  input.budget.monthly_infra_usd = 1000;
  input.team.has_devops = true;
  input.infrastructure = { data_residency: 'india' };
  input.context = { recovery_scope: 'region_outage', recovery_point_minutes: 30, recovery_time_minutes: 120 };
  const standby = recommend(input);
  assert.equal(standby.deployment.provider, 'aws');
  assert.match(standby.deployment.region, /Mumbai/);
  assert.match(standby.recovery_plan.secondary_region, /Hyderabad/);
  assert.equal(standby.recovery_plan.strategy, 'regional_warm_standby');
  assert.ok(standby.estimated_monthly_cost_usd.breakdown.some(({ driver }) => /Recovery-region PostgreSQL/.test(driver)));
  input.context.budget_policy = 'hard_cap';
  input.budget.monthly_infra_usd = 120;
  const blocked = recommend(input);
  assert.equal(blocked.status, 'infeasible');
  assert.ok(blocked.warnings.some(({ code }) => code === 'BUDGET_HARD_CAP'));
});

test('catalog fails closed on unsupported recovery scope, unstaffed failover, and invalid targets', () => {
  const input = mandatory();
  input.context = { recovery_scope: 'region_outage', recovery_point_minutes: 0 };
  assert.ok(recommend(input).warnings.some(({ code }) => code === 'RECOVERY_REGION_TARGET_UNSUPPORTED'));
  input.context.recovery_point_minutes = 30;
  assert.ok(recommend(input).warnings.some(({ code }) => code === 'RECOVERY_OPERATIONS_REQUIRED'));
  input.team.has_devops = true;
  input.infrastructure = { cloud_preference: 'azure', data_residency: 'india' };
  const unsupported = recommend(input);
  assert.equal(unsupported.status, 'infeasible');
  assert.ok(unsupported.warnings.some(({ code }) => code === 'NO_RECOVERY_PROFILE'));
  input.context.recovery_time_minutes = 0;
  assert.equal(recommend(input).status, 'invalid_input');
});

test('public cases explain the selected architecture, data path and realistic alternative', async () => {
  const expected = ['static', 'monolith', 'service_oriented', 'modular_monolith', 'hybrid', 'serverless'];
  for (const [index, style] of expected.entries()) {
    const result = recommend(await load('P' + (index + 1)));
    const decision = result.architecture_decision;
    assert.equal(result.architecture_style, style);
    assert.equal(decision.style, style);
    assert.ok(decision.justification && decision.driven_by.length && decision.data_flow.length >= 3);
    assert.ok(decision.alternatives[0].choice && decision.alternatives[0].why_not && decision.tradeoffs.length);
  }
});

test('changing data classification prevents an unauthenticated public plan', () => {
  const input = publicDirectory();
  assert.equal(recommend(input).stack.hosting.choice, 'Cloudflare Workers Free');
  input.context.data_classification = 'internal';
  const blocked = recommend(input);
  assert.equal(blocked.status, 'infeasible');
  assert.equal(blocked.stack, null);
  assert.ok(blocked.warnings.some(({ code }) => code === 'PROTECTED_DATA_REQUIRES_AUTH'));
  input.requirements.auth = 'email_password';
  assert.ok(recommend(input).decision_trace.excluded_hosting.some(({ choice, reason }) =>
    choice === 'Cloudflare Workers Free' && /classification/.test(reason)));
});

test('sensitive data adds regional key management and audited access to the plan and price', () => {
  const input = mandatory();
  input.requirements = { auth: 'email_password', file_media_storage: true };
  input.infrastructure = { cloud_preference: 'aws', data_residency: 'india' };
  const baseline = recommend(input);
  input.context = { data_classification: 'sensitive' };
  const protectedResult = recommend(input);
  assert.equal(protectedResult.deployment.provider, 'aws');
  assert.match(protectedResult.deployment.region, /Mumbai/);
  assert.ok(protectedResult.stack.supporting.some(({ layer, choice }) => layer === 'other' && choice === 'AWS Key Management Service'));
  assert.ok(protectedResult.estimated_monthly_cost_usd.max > baseline.estimated_monthly_cost_usd.max);
  assert.ok(protectedResult.deployment.boundary.launch_gates.some(({ gate }) => gate === 'protected_data_access'));
});

test('collaboration plan prices a socket gateway and pairs fanout with durable state', async () => {
  const input = await load('P3');
  const result = recommend(input);
  const realtime = result.stack.supporting.find(({ layer }) => layer === 'realtime');
  assert.match(realtime.choice, /Hocuspocus/);
  assert.match(realtime.justification, /Database extension.*Valkey/);
  assert.ok(result.estimated_monthly_cost_usd.breakdown.some(({ driver }) => driver === 'Realtime gateway compute'));
  input.context = { recovery_point_minutes: 0, recovery_time_minutes: 30 };
  assert.equal(recommend(input).status, 'infeasible');
});
