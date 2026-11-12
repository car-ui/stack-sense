const enumOf = (values, fallback) => ({ type: 'enum', values: values.split(' '), fallback });
const int = (min, fallback, max) => ({ type: 'integer', min, max, fallback });
const number = (min, fallback) => ({ type: 'number', min, fallback });
const str = (fallback) => ({ type: 'string', fallback });
const flag = { type: 'boolean', fallback: false };
const list = (values, min = 0, fallback) => ({
  type: 'list', values: values?.split(' '), min, fallback
});

export const schema = {
  project: {
    name: str(''), type: enumOf('content_site web_app saas_b2b ecommerce marketplace social realtime_collab fintech healthtech data_analytics iot ai_ml_product internal_tool gaming api_platform other'),
    description: str(''), platforms: list('web android ios desktop api_only', 1),
  },
  scale: {
    users_at_launch: int(0), users_12_months: int(0),
    peak_concurrent_users: int(0, null), traffic_pattern: enumOf('steady spiky seasonal', 'steady'),
    workload: enumOf('read_heavy balanced write_heavy', 'balanced'),
    data_volume_gb_12_months: number(0, null),
  },
  team: {
    size: int(1), experience: enumOf('beginner intermediate senior mixed'),
    languages: list(), has_devops: flag,
  },
  budget: { monthly_infra_usd: number(0) },
  timeline: { mvp_weeks: int(1) },
  infrastructure: {
    cloud_preference: enumOf('any aws gcp azure none', 'any'),
    deployment_model: enumOf('managed_cloud self_hosted_cloud_vm on_premise air_gapped', 'managed_cloud'),
    data_residency: enumOf('none india eu us other', 'none'), existing_systems: list(undefined, 0, []),
  },
  requirements: {
    realtime: flag, offline_support: flag, full_text_search: flag, file_media_storage: flag,
    payments: flag, auth: enumOf('none email_password social phone_otp enterprise_sso', 'none'),
    multi_tenant: flag, ml_features: enumOf('none inference_api llm_rag training', 'none'),
    seo_critical: flag, availability: enumOf('99 99.9 99.95 99.99', '99.9'),
    p95_latency_ms: { ...int(1, null), nullable: true },
  },
  compliance: list('gdpr dpdp hipaa pci_dss rbi_localisation soc2 iso27001', 0, []),
  priorities: Object.fromEntries(['cost', 'time_to_market', 'scalability', 'performance', 'maintainability', 'security']
    .map((key) => [key, int(1, 3, 5)])),
  context: {
    data_classification: enumOf('unspecified public internal sensitive', 'unspecified'),
    recovery_point_minutes: { ...int(0, null), nullable: true },
    recovery_time_minutes: { ...int(1, null), nullable: true },
    recovery_scope: enumOf('zone_outage region_outage', 'zone_outage'),
    peak_requests_per_second: int(0, null),
    peak_day_requests: int(0, null),
    budget_policy: enumOf('soft hard_cap', 'soft'),
    monthly_egress_gb: number(0, null),
    search_corpus_gb: number(0, null),
    vendor_lock_in: enumOf('low medium high', 'medium'),
    data_profile: enumOf('general relational document time_series', 'general'),
    residency_region: str(''),
  },
};

const own = (obj, key) => Object.hasOwn(obj, key);
const plain = (obj) => obj !== null && typeof obj === 'object' && !Array.isArray(obj);

export function validate(input) {
  const errors = [];
  const assumptions = [];
  const fail = (field, message) => errors.push({ field, message });
  if (!plain(input)) {
    fail('$', 'Expected a JSON object.');
    return { errors, assumptions, data: null };
  }

  function read(obj, key, rule, path) {
    if (!own(obj, key)) {
      if (rule.fallback === undefined) fail(path, 'Required field is missing.');
      else assumptions.push(path + ' defaulted to ' + JSON.stringify(rule.fallback) + '.');
      return rule.fallback;
    }
    const value = obj[key];
    if (value === null && rule.nullable) return value;
    switch (rule.type) {
      case 'enum':
        if (!rule.values.includes(value)) fail(path, 'Choose one of: ' + rule.values.join(', ') + '.');
        break;
      case 'number':
      case 'integer': {
        const valid = rule.type === 'integer' ? Number.isSafeInteger(value) : Number.isFinite(value);
        if (!valid || value < rule.min || (rule.max !== undefined && value > rule.max)) {
          const range = rule.max === undefined ? 'at least ' + rule.min : 'between ' + rule.min + ' and ' + rule.max;
          fail(path, 'Expected a ' + (rule.type === 'integer' ? 'safe integer ' : 'finite number ') + range + '.');
        }
        break;
      }
      case 'list':
        if (!Array.isArray(value)) {
          fail(path, 'Expected an array.');
          break;
        }
        if (value.length < rule.min) fail(path, 'Select at least ' + rule.min + ' item(s).');
        value.forEach((item, i) => {
          if (typeof item !== 'string' || !item.trim()) fail(path + '[' + i + ']', 'Expected a non-empty string.');
          else if (rule.values && !rule.values.includes(item)) fail(path + '[' + i + ']', 'Choose one of: ' + rule.values.join(', ') + '.');
          else if (path === 'team.languages' && item !== item.toLowerCase()) fail(path + '[' + i + ']', 'Use a lower-case language name.');
        });
        return [...new Set(value)];
      default:
        if (typeof value !== rule.type) fail(path, 'Expected a ' + rule.type + '.');
    }
    return value;
  }

  const data = {};
  if (own(input, 'scenario_id')) {
    if (typeof input.scenario_id === 'string') data.scenario_id = input.scenario_id;
    else fail('scenario_id', 'Expected a string.');
  }
  for (const [key, rules] of Object.entries(schema)) {
    if (typeof rules.type === 'string') {
      data[key] = read(input, key, rules, key);
      continue;
    }
    const group = own(input, key) ? input[key] : {};
    if (!plain(group)) fail(key, 'Expected a JSON object.');
    data[key] = Object.fromEntries(Object.entries(rules).map(([name, rule]) =>
      [name, read(plain(group) ? group : {}, name, rule, key + '.' + name)]));
  }
  return { data, assumptions, errors };
}
