import { readFileSync } from 'node:fs';
import { recommend } from './engine.mjs';

// One field changes per run. These values are probes, not representative forecasts.
const probes = {
  'project.name': ['Sensitivity probe'],
  'project.description': ['Low-end Android clients on intermittent 2G/3G networks.'],
  'project.type': ['content_site', 'realtime_collab'],
  'project.platforms': [['web'], ['android']],
  'scale.users_at_launch': [0, 1000000],
  'scale.users_12_months': [100, 1000000],
  'scale.peak_concurrent_users': [10, 100000],
  'scale.traffic_pattern': ['steady', 'spiky'],
  'scale.workload': ['read_heavy', 'write_heavy'],
  'scale.data_volume_gb_12_months': [0.1, 2000],
  'team.size': [1, 20],
  'team.experience': ['beginner', 'senior'],
  'team.languages': [['typescript'], ['go']],
  'team.has_devops': [false, true],
  'budget.monthly_infra_usd': [0, 10000],
  'timeline.mvp_weeks': [2, 52],
  'infrastructure.cloud_preference': ['aws', 'gcp'],
  'infrastructure.deployment_model': ['managed_cloud', 'air_gapped'],
  'infrastructure.data_residency': ['india', 'eu'],
  'infrastructure.existing_systems': [[], ['SQL Server 2019']],
  'requirements.realtime': [false, true],
  'requirements.offline_support': [false, true],
  'requirements.full_text_search': [false, true],
  'requirements.file_media_storage': [false, true],
  'requirements.payments': [false, true],
  'requirements.auth': ['none', 'social'],
  'requirements.multi_tenant': [false, true],
  'requirements.ml_features': ['none', 'llm_rag'],
  'requirements.seo_critical': [false, true],
  'requirements.availability': ['99', '99.99'],
  'requirements.p95_latency_ms': [50, 2000],
  compliance: [[], ['gdpr']],
  'priorities.cost': [1, 5],
  'priorities.time_to_market': [1, 5],
  'priorities.scalability': [1, 5],
  'priorities.performance': [1, 5],
  'priorities.maintainability': [1, 5],
  'priorities.security': [1, 5],
  'context.data_classification': ['public', 'sensitive'],
  'context.peak_requests_per_second': [1, 10000],
  'context.peak_day_requests': [1000, 1000000],
  'context.budget_policy': ['soft', 'hard_cap'],
  'context.monthly_egress_gb': [0, 5000],
  'context.search_corpus_gb': [0.1, 1000],
  'context.vendor_lock_in': ['low', 'high'],
  'context.data_profile': ['relational', 'document'],
  'context.recovery_point_minutes': [0, 120],
  'context.recovery_time_minutes': [20, 600],
};

const read = (obj, path) => path.split('.').reduce((value, key) => value?.[key], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
}
const choices = (result) => result.stack && Object.fromEntries(
  ['frontend', 'backend', 'database', 'hosting'].map((key) => [key, result.stack[key].choice]));
const core = (result) => JSON.stringify({ status: result.status, stack: choices(result) });
const material = (result) => JSON.stringify({
  status: result.status, architecture: result.architecture_style, stack: choices(result),
  supporting: result.stack?.supporting.map(({ layer, choice }) => [layer, choice]),
  region: result.deployment?.region,
  cost: [result.estimated_monthly_cost_usd.min, result.estimated_monthly_cost_usd.max],
  warnings: result.warnings.map(({ code, severity }) => [code, severity]),
  budget_alternative: result.budget_alternative?.status,
});
const scores = (result) => JSON.stringify(result.stack && Object.fromEntries(
  ['frontend', 'backend', 'database', 'hosting'].map((key) => [key, {
    fit_score: result.stack[key].fit_score,
    component_scores: result.stack[key].component_scores?.map(({ fit_score }) => fit_score),
  }])));

const cases = Array.from({ length: 6 }, (_, index) =>
  JSON.parse(readFileSync(new URL('./scenarios/P' + (index + 1) + '.json', import.meta.url))));
const summary = { scenario_count: cases.length, fields: {}, total_variants: 0, invalid_variants: 0,
  core_changed: 0, material_changed: 0, score_changed: 0 };
for (const [field, values] of Object.entries(probes)) {
  const row = { variants: 0, core_changed: 0, material_changed: 0, score_changed: 0 };
  for (const scenario of cases) {
    const baseline = recommend(scenario);
    for (const value of values) {
      if (JSON.stringify(read(scenario, field)) === JSON.stringify(value)) continue;
      const changed = structuredClone(scenario);
      set(changed, field, value);
      const result = recommend(changed);
      if (result.status === 'invalid_input') {
        summary.invalid_variants++;
        throw new Error(field + ' produced invalid input in ' + scenario.scenario_id + ': ' + JSON.stringify(result.validation_errors));
      }
      row.variants++;
      row.core_changed += Number(core(result) !== core(baseline));
      row.material_changed += Number(material(result) !== material(baseline));
      row.score_changed += Number(scores(result) !== scores(baseline));
    }
  }
  summary.fields[field] = row;
  for (const key of ['variants', 'core_changed', 'material_changed', 'score_changed']) summary[key === 'variants' ? 'total_variants' : key] += row[key];
}
summary.fields_with_material_change = Object.values(summary.fields).filter(({ material_changed }) => material_changed > 0).length;
summary.fields_with_score_change = Object.values(summary.fields).filter(({ score_changed }) => score_changed > 0).length;
if (summary.fields['project.name'].material_changed || summary.fields['project.name'].score_changed) {
  throw new Error('Display-only project.name changed a decision or score.');
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
