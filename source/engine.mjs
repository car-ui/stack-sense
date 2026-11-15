import { validate } from './schema.mjs';
import { client, app, chooseDeployment, context } from './fit.mjs';
import { costBand, supporting } from './services.mjs';
import { assuranceSources } from './catalog.mjs';
import { recoveryPlan } from './recovery.mjs';
import { chooseArchitecture } from './architecture.mjs';

const VERSION = '1.5.1';
const warning = (code, severity, message, ...fields) => ({ code, severity, message, fields });
const emptyCost = () => ({ min: null, max: null, assumptions: ['No estimate was made without a viable input and deployment.'] });
const retired = [
  /\b(?:heroku free dynos?|google cloud iot core|azure sql edge|parse\.com|firebase dynamic links|atlas device sync|realm device sync)\b/i,
  /\b(?:node(?:\.js)? v?(?:12|14|16|18|20)|python (?:2\.7|3\.[789])|angularjs|centos (?:linux )?[678]|postgres(?:ql)? (?:9\.\d|10|11|12|13)|sql server 20(?:08|12|14|16))\b/i,
];

export function invalidResult(errors, scenarioId, assumptions = []) {
  return {
    ...(typeof scenarioId === 'string' ? { scenario_id: scenarioId } : {}),
    engine_version: VERSION, status: 'invalid_input',
    summary: 'Correct the listed scenario fields and run the recommendation again.',
    architecture_style: 'other', stack: null, estimated_monthly_cost_usd: emptyCost(),
    warnings: [], assumptions, validation_errors: errors,
  };
}

function systemsFor(d) {
  const items = d.infrastructure.existing_systems;
  const has = (pattern) => items.some((item) => pattern.test(item));
  return {
    retired: items.filter((item) => retired.some((rule) => rule.test(item))),
    retiredSql: has(/\bsql server 20(?:08|12|14|16)\b/i),
    sql: has(/\bsql server\b/i),
    sqlOnPrem: has(/on[- ]prem.*sql server|sql server.*on[- ]prem/i),
    entra: has(/\b(?:entra id|azure ad|azure active directory)\b/i),
    mysql: has(/\b(?:mysql|mariadb)\b/i),
    pg: has(/\bpostgres(?:ql)?\b/i),
    office: has(/\b(?:microsoft|office) 365\b/i),
    cloudDependencies: items.filter((item) => /\b(?:entra id|azure ad|azure active directory|(?:microsoft|office) 365|salesforce|google workspace|firebase authentication)\b/i.test(item)),
  };
}

function policies(c, add) {
  const { d, r, air, local } = c;
  const i = d.infrastructure;
  if (c.privateData && r.auth === 'none') {
    add('PROTECTED_DATA_REQUIRES_AUTH', 'critical',
      'The scenario classifies data as ' + d.context.data_classification + ' but defines no identity path. Supply an authentication requirement before selecting a protected deployment.',
      'context.data_classification', 'requirements.auth');
  }
  if (c.privateData && r.seo_critical) {
    add('PROTECTED_DATA_INDEXING', 'warning', 'Index a public landing surface and enforce authorization and private caching rules on protected content.',
      'context.data_classification', 'requirements.seo_critical');
  }
  const recovery = c.recovery;
  if (recovery.regional && ((recovery.rpo !== null && recovery.rpo < 15) || (recovery.rto !== null && recovery.rto < 60))) {
    add('RECOVERY_REGION_TARGET_UNSUPPORTED', 'critical',
      'The regional profile uses asynchronous replication. This catalog does not model regional targets below 15 minutes of data loss or 60 minutes of downtime.',
      'context.recovery_scope', 'context.recovery_point_minutes', 'context.recovery_time_minutes');
  } else if (recovery.rto !== null && recovery.rto < 5) {
    add('RECOVERY_TIME_TARGET_UNSUPPORTED', 'critical',
      'This catalog does not model complete service recovery in under five minutes. Database failover time alone does not establish end-to-end recovery.',
      'context.recovery_time_minutes', 'context.recovery_scope');
  }
  if (!c.staticSite && (recovery.regional || recovery.zonalStandby) && (!d.team.has_devops || d.team.size < 2)) {
    add('RECOVERY_OPERATIONS_REQUIRED', 'critical', 'The requested recovery profile needs an operations owner and coverage to test failover, restore and failback.',
      'team.has_devops', 'team.size', 'context.recovery_scope');
  }
  if (d.project.platforms.includes('api_only') && d.project.platforms.length > 1) {
    add('API_ONLY_CONFLICT', 'critical', 'api_only is exclusive. Choose API-only delivery or the target client platforms.', 'project.platforms');
  }
  if (d.compliance.includes('rbi_localisation') && !['none', 'india'].includes(i.data_residency)) {
    add('RBI_REGION_CONFLICT', 'critical', 'RBI payment-data localisation conflicts with the explicit non-India data location.', 'compliance', 'infrastructure.data_residency');
  }
  if ((local && !['any', 'none'].includes(i.cloud_preference)) || (!local && i.cloud_preference === 'none')) {
    add('PROVIDER_MODEL_CONFLICT', 'critical', 'The explicit provider and deployment model require incompatible operating environments.', 'infrastructure.cloud_preference', 'infrastructure.deployment_model');
  }
  if (i.data_residency === 'other' && (!d.context.residency_region.trim() || !local)) {
    add('UNVERIFIED_GEOGRAPHY', 'critical', 'The catalog cannot verify a cloud service set for an unspecified or unsupported country. Name a verified local facility or select a supported geography.',
      'infrastructure.data_residency', 'context.residency_region', 'infrastructure.deployment_model');
  }
  if (local && (r.payments || r.auth === 'phone_otp')) {
    add(air ? 'AIR_GAP_EXTERNAL_CHANNEL' : 'LOCAL_EXTERNAL_CHANNEL', 'critical', 'Live payment settlement or public SMS delivery requires a third-party rail outside this self-contained deployment profile. Define an approved boundary or change the requirement.',
      'infrastructure.deployment_model', 'requirements.payments', 'requirements.auth');
  }
  if (local && r.auth === 'social') {
    add(air ? 'AIR_GAP_FEDERATION' : 'LOCAL_EXTERNAL_FEDERATION', 'critical', 'Public social sign-in requires an external identity provider. Use local credentials or explicitly supported internal enterprise SSO.',
      'infrastructure.deployment_model', 'requirements.auth');
  }
  if (local && c.systems.cloudDependencies.length) {
    add('LOCAL_EXISTING_SAAS_CONFLICT', 'critical',
      'The listed integration needs an external cloud endpoint: ' + c.systems.cloudDependencies.join(', ') + '. Provide an approved local equivalent or change the deployment boundary.',
      'infrastructure.existing_systems', 'infrastructure.deployment_model');
  }
  if (r.offline_support && d.project.platforms.includes('api_only') && d.project.platforms.length === 1) {
    add('OFFLINE_REQUIRES_CLIENT', 'critical', 'Offline operation needs a client capable of persisting and replaying data. Select a client platform or remove the offline requirement.',
      'project.platforms', 'requirements.offline_support');
  }
  if (c.systems.retired.length) {
    add('RETIRED_EXISTING_SYSTEM', 'warning', 'Upgrade or isolate retired dependencies before reuse: ' + c.systems.retired.join(', ') + '.', 'infrastructure.existing_systems');
  }
  if (r.realtime && r.offline_support) {
    add('OFFLINE_REALTIME_BOUNDARY', 'warning', 'Live updates apply while connected. Offline clients need local state, versioned edits and reconciliation on reconnect.',
      'requirements.realtime', 'requirements.offline_support');
  }
  if (r.seo_critical && !c.browser) {
    add('SEO_NEEDS_WEB', 'warning', 'Search indexing needs a separately crawlable web surface. The chosen platform list contains no website.',
      'requirements.seo_critical', 'project.platforms');
  }
  if (d.timeline.mvp_weeks <= 3 && d.project.platforms.length >= 3) {
    add('MVP_SCOPE_RISK', 'warning', 'Three or more client platforms in three weeks or less is high risk. Stage releases and share contracts before committing to all client work.',
      'timeline.mvp_weeks', 'project.platforms', 'team.size');
  }
  if (c.ha && (!d.team.has_devops || d.team.size < 2)) {
    add('HA_OPERATIONS_RISK', Number(r.availability) >= 99.99 && (d.team.experience === 'beginner' || !d.team.has_devops) ? 'critical' : 'warning',
      'The availability target requires a staffed incident and recovery plan plus redundant capacity. Verify ownership and run failover drills before promising an SLO.',
      'requirements.availability', 'team.has_devops', 'team.size');
  }
  if (Number(r.availability) === 99.99 && d.team.has_devops && d.team.size >= 2) {
    add('VERIFY_END_TO_END_SLO', 'warning', 'Validate the full availability target across DNS, ingress, compute, storage, identity and external dependencies. A regional design can still share failure domains.',
      'requirements.availability', 'infrastructure.data_residency');
  }
  if (r.p95_latency_ms !== null && r.p95_latency_ms <= 50) {
    add('LATENCY_TOPOLOGY_RISK', 'warning', 'A sub-50 ms end-to-end p95 depends on client geography, connection reuse and measured query paths. Benchmark from representative networks.',
      'requirements.p95_latency_ms', 'infrastructure.data_residency');
  }
  if (r.full_text_search && d.context.search_corpus_gb !== null && c.searchGb > c.dataGb) {
    add('SEARCH_SIZE_REVIEW', 'info', 'The searchable corpus exceeds the stored-data estimate. Verify whether this is uncompressed source text or a sizing inconsistency.',
      'context.search_corpus_gb', 'scale.data_volume_gb_12_months');
  }
  if (local && !d.team.has_devops) {
    add('LOCAL_OPS_OWNER', 'warning', 'Assign someone to own capacity, guest patching, backup recovery and incident response at the facility.',
      'infrastructure.deployment_model', 'team.has_devops');
  }
  if (d.compliance.includes('gdpr')) add('GDPR_CONTROLS', 'warning',
    'Document data flows, a DPA, erasure/export and retention. If any processor or support plane transfers data, verify the applicable transfer mechanism.',
    'compliance', 'infrastructure.data_residency');
  if (d.compliance.includes('dpdp')) add('DPDP_CONTROLS', 'info',
    'Review current Indian data-protection requirements for notice, access controls, retention and processor agreements.',
    'compliance');
  if (d.compliance.includes('hipaa')) add('HIPAA_CONTRACT', 'warning',
    'Confirm the complete ePHI service scope and execute required BAAs. Keep ePHI out of external checkout, SMS and telemetry and audit least-privilege access.',
    'compliance', 'infrastructure.cloud_preference', 'requirements.auth');
  if (d.compliance.includes('pci_dss')) add('PCI_SCOPE', 'warning',
    'Confirm PCI scope with the processor and assessor. Keep raw card data out of app, storage and logs, verify the processor attestation and segment the environment.',
    'compliance', 'requirements.payments');
  if (d.compliance.includes('rbi_localisation')) add('RBI_DATA_PLANE', 'warning',
    'Keep in-scope payment data, replicas, backups and transaction logs in India. Obtain the regulated partner\'s approval for settlement, disbursal and incident workflows.',
    'compliance', 'infrastructure.data_residency');
  if (d.compliance.includes('soc2') || d.compliance.includes('iso27001')) add('AUDIT_PROGRAM', 'info',
    'Map controls, provider attestations, scope, access reviews and operational evidence. The organisation owns its audit or certification.',
    'compliance');
}

function resultFor(d, assumptions, fields) {
  return {
    ...(d.scenario_id !== undefined ? { scenario_id: d.scenario_id } : {}),
    engine_version: VERSION, assumptions, validation_errors: [], ...fields,
  };
}

function boundary(c, h, region, support) {
  const r = c.r;
  const scope = [h.choice, h.db[0]?.item.choice, support.find((item) => item.layer === 'storage')?.choice].filter(Boolean);
  const gates = c.d.compliance.map((program) => {
      const detail = {
        hipaa: 'Verify the exact service features and execute the required BAA before processing ePHI.',
        pci_dss: 'Confirm cardholder-data scope, provider and payment-processor attestations, and test network segmentation.',
        rbi_localisation: 'Confirm India placement for all in-scope payment data, backups and logs with the regulated partner.',
        gdpr: 'Review processor agreements, cross-border transfer mechanisms, retention and data-subject workflows.',
        dpdp: 'Review notice, retention, processor duties and access controls for the personal-data flows.',
        soc2: 'Confirm provider audit scope and define customer control ownership and evidence.',
        iso27001: 'Confirm certification scope and document the customer control responsibilities.',
      }[program];
      return { gate: program, check: detail, ...(assuranceSources[h.provider]?.[program] ?
        { evidence: assuranceSources[h.provider][program] } : {}) };
    });
  if (r.payments) gates.push({ gate: 'payment_processor', check: 'Confirm merchant-country eligibility, settlement rails, processor data geography and contracts before enabling live transactions.' });
  if (r.auth === 'phone_otp' || r.auth === 'social' || support.some((item) => item.choice.startsWith('Microsoft Entra'))) {
    gates.push({ gate: 'identity_processor', check: 'Verify identity or messaging processor region, metadata flows and contract before enabling the integration.' });
  }
  if (['llm_rag', 'training'].includes(r.ml_features)) gates.push({
    gate: 'model_capacity', check: 'Verify in-boundary model artifacts, accelerator availability and reserved capacity before committing to the model workload.',
  });
  if (h.maturity === 'edge_api') gates.push({
    gate: 'free_plan_headroom',
    check: 'Confirm that all served records are public. Measure per-request CPU, scanned rows and account-wide daily usage before relying on the free plan.',
    evidence: 'https://developers.cloudflare.com/d1/platform/pricing/',
  });
  if (c.privateData) gates.push({
    gate: 'protected_data_access',
    check: 'Verify server-side authorization and cache behavior for protected routes. Test backup and log access with least-privilege roles.' +
      (c.sensitive ? ' Verify encryption and key ownership for each durable copy.' : ''),
    evidence: 'https://docs.aws.amazon.com/wellarchitected/2022-03-31/framework/sec-07.html',
  });
  return { region, core_data_services: scope, launch_gates: gates,
    ...(c.d.context.data_classification !== 'unspecified' ? { data_classification: c.d.context.data_classification } : {}) };
}

export function recommend(input) {
  const { data: d, errors, assumptions } = validate(input);
  if (errors.length) return invalidResult(errors, d?.scenario_id, assumptions);
  const warnings = [];
  const add = (...args) => warnings.push(warning(...args));
  let residency = d.infrastructure.data_residency;
  if (residency === 'none' && d.compliance.includes('rbi_localisation')) {
    residency = 'india';
    assumptions.push('Inferred India data placement from RBI payment-data localisation.');
  } else if (residency === 'none' && d.compliance.includes('gdpr')) {
    residency = 'eu';
    assumptions.push('Selected an EU data plane for GDPR risk reduction when no residency was specified.');
  }

  const c = context(d, residency, systemsFor(d));
  if (d.scale.peak_concurrent_users === null) assumptions.push('Peak concurrency modeled as 2% of the larger user count, rounded up.');
  if (d.scale.data_volume_gb_12_months === null) assumptions.push('Stored data modeled as 0.2 MB per forecast user, rounded up.');
  if (d.context.peak_requests_per_second === null) assumptions.push('Peak request proxy uses ' + c.requestRate + ' per peak active client per second.');
  if (c.r.full_text_search && !c.staticSite && d.context.search_corpus_gb === null) assumptions.push('Searchable text modeled as ' +
    (c.r.file_media_storage ? '15% of stored data because media is included.' : 'the full stored dataset as a conservative proxy.'));
  if (c.lowEnd && c.mobile) assumptions.push('Read low-end device or 2G/3G wording as a client resource constraint.');
  if (d.team.languages.length === 0) assumptions.push('No known languages listed. Technology fit receives no language adjustment.');
  if (d.scale.users_12_months < d.scale.users_at_launch) {
    add('DECLINING_USERS', 'info', 'The launch forecast exceeds the 12-month forecast. The higher user estimate informs sizing.', 'scale.users_at_launch', 'scale.users_12_months');
  }
  policies(c, add);
  const stop = (message) => resultFor(d, assumptions, {
    status: 'infeasible', summary: message, architecture_style: 'other', stack: null,
    warnings, estimated_monthly_cost_usd: emptyCost(),
  });
  if (warnings.some((w) => w.severity === 'critical')) return stop('Resolve the critical constraints before choosing a deployable stack.');

  const deployment = chooseDeployment(c, (h, db) => {
    const plan = supporting(c, h, db);
    return { ...costBand(c, h, db, plan), plan };
  });
  if (!deployment.h) {
    if (deployment.blockedByBudget.length) {
      const cheapest = deployment.blockedByBudget.reduce((a, b) => a.max_usd <= b.max_usd ? a : b);
      add('BUDGET_HARD_CAP', 'critical', 'The lowest modeled ceiling among policy-compatible options is USD ' +
        cheapest.max_usd + ' for ' + cheapest.choice + '. It exceeds the hard cap of USD ' + d.budget.monthly_infra_usd + '.',
        'budget.monthly_infra_usd', 'context.budget_policy');
    } else if (c.recovery.active) {
      add('NO_RECOVERY_PROFILE', 'critical', 'No catalog profile can cover this recovery scope while preserving the requested geography, provider and dependencies.',
        'context.recovery_scope', 'context.recovery_point_minutes', 'context.recovery_time_minutes', 'infrastructure.data_residency');
    } else {
      add('NO_ELIGIBLE_TOPOLOGY', 'critical', 'No catalog profile fits the combined deployment, provider and region policy.',
        'infrastructure.deployment_model', 'infrastructure.cloud_preference', 'infrastructure.data_residency', 'compliance');
    }
    return { ...stop('No catalog profile fits the required policy and budget constraints.'),
      decision_trace: { eligible_hosting: [], excluded_hosting: deployment.excluded } };
  }

  const { h, region, hosting, db, shortlist, excluded } = deployment;
  const budget = d.budget.monthly_infra_usd;
  const freeApi = h.maturity === 'edge_api';
  const recovery = recoveryPlan(c, h, h.db[0]?.item.id);
  const band = {
    min: h.min, max: h.max, breakdown: h.costDrivers,
    budget_usd: budget, budget_fit: h.min > budget ? 'above_budget' : h.max > budget ? 'overlaps_budget' : 'within_budget',
    budget_policy: d.context.budget_policy,
    assumptions: [
      'Illustrative monthly USD operating band. Inputs are sizing proxies, not a measured request or billing forecast.',
      'Peak proxy: ' + c.peak + ' concurrent clients, ' + c.rps + ' requests or realtime events per second and ' + c.dataGb + ' GB total data.',
      'Placement: ' + region + '. ' + (freeApi ? 'Uses the free Worker and D1 plans.' :
        c.ha ? 'Budget includes redundant application and data capacity.' : 'Starts with modest regional capacity and backups.'),
      'Excludes taxes, team labor, initial hardware, domain purchases and transaction fees. Media and OTP allowances are modeled separately when requested.',
      freeApi ? 'The free estimate depends on account-wide plan quotas. Quota exhaustion can interrupt service.' :
        d.context.monthly_egress_gb === null ? 'Heavy internet egress is outside the baseline. Provide a monthly estimate to price it explicitly.' :
        h.maturity === 'static' ? 'Explicit egress is subject to public hosting plan terms.' :
          c.local ? 'Facility bandwidth is assumed prepaid. Check the circuit and egress agreement.' :
            'Explicit internet egress uses a rounded per-GB planning interval before free allowances and contract discounts.',
      ...(h.maturity === 'static' ? ['Assumes build and transfer remain within public static hosting quotas.'] : []),
      ...(freeApi ? ['Peak day forecast: ' + c.peakDayRequests + ' requests. Budget at most 50 scanned rows per request and keep owner-only imports under the daily write allowance.',
        'Published free limits are 100,000 Worker requests/day, 10 ms CPU per invocation, 500 MB per D1 database, 5 million rows read/day and 100,000 rows written/day.'] : []),
      ...(c.local ? ['Assumes existing hardware and network. Hardware replacement and secondary facilities need a separate budget.'] : []),
      ...(recovery?.secondary_region ? ['Warm HTTP and replica capacity in ' + recovery.secondary_region + ' is included. Verify replication volume, secondary region pricing and failover capacity.'] : []),
    ],
  };
  if (budget === 0 && !c.staticSite && !freeApi && (c.volume > 2 || !c.local)) {
    add('ZERO_BUDGET_DYNAMIC', 'critical', 'A production dynamic data plane needs recurring capacity or verified prepaid resources. The modeled floor is USD ' + band.min + '.',
      'budget.monthly_infra_usd', 'scale.peak_concurrent_users', 'requirements.availability');
    return { ...stop('The dynamic workload cannot fit the zero-infrastructure budget.'), estimated_monthly_cost_usd: band,
      decision_trace: { eligible_hosting: shortlist.map((row) => ({ ...row, selected: false })), excluded_hosting: excluded } };
  }
  if (freeApi) {
    assumptions.push('Free edge profile is scoped to publicly readable, non-sensitive data. Administrative writes use an operator-controlled path.');
    if (d.context.peak_day_requests === null) assumptions.push('Peak-day forecast uses the larger of ten minutes at peak RPS and two requests per forecast user.');
    add('EDGE_API_FREE_LIMITS', 'warning', 'Free service depends on available account quota and has no contracted availability in this profile. Benchmark CPU and query scans, monitor quotas, and plan a paid or regional migration before growth.',
      'context.peak_day_requests', 'scale.data_volume_gb_12_months', 'requirements.availability', 'budget.monthly_infra_usd');
  }
  if (recovery) add('RECOVERY_DRILL_PENDING', 'warning',
    'Measure achieved data loss and service recovery time in a representative outage drill. The planned topology and its thresholds are planning guidance, separate from the availability target.',
    'context.recovery_scope', 'context.recovery_point_minutes', 'context.recovery_time_minutes', 'requirements.availability');
  if (band.min > budget) add('BUDGET_BELOW_FLOOR', 'warning',
    'The illustrated topology exceeds the soft budget even at the modeled floor. The budget is relaxed from USD ' + budget + ' to at least USD ' + band.min + '.',
    'budget.monthly_infra_usd', 'scale.peak_concurrent_users');
  else if (band.max > budget) add('BUDGET_HEADROOM', 'warning',
    'The upper monthly estimate exceeds the budget. Meter workloads, enforce usage alerts and verify the region-specific bill.',
    'budget.monthly_infra_usd', 'scale.traffic_pattern');
  if (band.min > budget) assumptions.push('Relaxed monthly infrastructure budget only. Modeled floor USD ' + band.min + ' versus requested USD ' + budget + '.');
  if (h.maturity === 'static' && (c.actualUsers >= 100000 || c.d.scale.traffic_pattern !== 'steady')) add('EDGE_QUOTA_CHECK', 'warning',
    'The site is static. Verify build and asset transfer limits under launch spikes before relying on a zero-cost hosting band.',
    'scale.users_12_months', 'scale.traffic_pattern');
  if (h.id === 'run' && c.r.realtime) add('CLOUD_RUN_SOCKET_LIMITS', 'warning',
    'Plan for WebSocket reconnects before the Cloud Run request timeout. Share room state between instances, test reconnect storms and verify billing while sockets are open.',
    'requirements.realtime', 'requirements.p95_latency_ms', 'scale.peak_concurrent_users');
  if (c.r.auth === 'phone_otp') add('OTP_PROCESSOR_REVIEW', 'warning',
    'Verify country eligibility and residency of the SMS gateway and delivery logs. OTP delivery needs retry limits, abuse controls and a per-message budget.',
    'requirements.auth', 'infrastructure.data_residency', 'budget.monthly_infra_usd');
  if (c.r.payments) add('PAYMENT_PROCESSOR_REVIEW', 'warning',
    'Before going live, verify processor coverage for the requested country and rails and confirm any data residency or compliance obligations in the processor agreement.',
    'requirements.payments', 'infrastructure.data_residency', 'compliance');
  if (c.systems.sql && !c.systems.retiredSql) {
    if (h.db[0]?.item.id === 'legacySql') add('PRIVATE_SQL_PATH', 'info',
      'Validate network path, TLS, backups and disaster recovery for the existing SQL Server. Use a least-privilege account and a supported driver.',
      'infrastructure.existing_systems', 'infrastructure.data_residency');
    else add('LEGACY_MIGRATION_REVIEW', 'warning',
      'Treat existing SQL Server as an integration constraint. Confirm private connectivity and either migrate schema/data inside policy or use a narrow adapter.',
      'infrastructure.existing_systems', 'requirements.availability');
  }
  const support = h.plan;
  if (support.some((s) => s.choice.startsWith('Microsoft Entra'))) add('IDENTITY_BOUNDARY', 'warning',
    'Validate the existing Entra tenant geography, directory feature residency and metadata processing before using it for regulated or resident data.',
    'infrastructure.existing_systems', 'infrastructure.data_residency');
  if (c.systems.office && !c.air) {
    assumptions.push('Microsoft 365 is an existing integration target, not a new system of record. Enable document links or notifications only after tenant and residency review.');
  }
  const architecture = chooseArchitecture(c, h);
  const style = architecture.style;
  const summary = c.staticSite
    ? 'Publish prebuilt pages through ' + hosting.choice + '. The site needs neither a dynamic API nor a runtime database.'
    : freeApi ? 'Run a small public HTTP API on Cloudflare Workers Free with a D1 binding. Validate quota and CPU headroom before launch.' :
      'Start with a ' + style.replaceAll('_', ' ') + ' deployment on ' + hosting.choice + ' in ' + region + '. ' +
      (c.r.offline_support ? 'Keep writes durable on the client and sync when a connection returns.' :
        c.r.realtime ? 'Separate durable records from ephemeral socket traffic.' :
        c.regulated ? 'Keep restricted workflows, audit records and backups inside the approved data boundary.' :
          'Keep the data and application layers close and add supporting services only for requested capabilities.');
  const result = resultFor(d, assumptions, {
    status: warnings.some((w) => w.severity !== 'info') ? 'ok_with_warnings' : 'ok',
    summary, architecture_style: style,
    architecture_decision: architecture,
    stack: { frontend: client(c), backend: app(c, h), database: db, hosting, supporting: support },
    deployment: { provider: h.provider, region, model: h.model, boundary: boundary(c, h, region, support) },
    decision_trace: { eligible_hosting: shortlist, excluded_hosting: excluded },
    ...(recovery ? { recovery_plan: recovery } : {}),
    estimated_monthly_cost_usd: band, warnings,
  });
  if (d.context.budget_policy === 'soft' && band.max > budget) {
    const capped = recommend({ ...input, context: { ...input.context, budget_policy: 'hard_cap' } });
    if (capped.stack) {
      result.budget_alternative = {
        status: 'available', budget_usd: budget,
        method: 'Rerun the same inputs with a hard cap on the modeled upper monthly cost.',
        stack: Object.fromEntries(['frontend', 'backend', 'database', 'hosting']
          .map((layer) => [layer, capped.stack[layer].choice])),
        region: capped.deployment.region,
        estimated_monthly_cost_usd: {
          min: capped.estimated_monthly_cost_usd.min,
          max: capped.estimated_monthly_cost_usd.max,
        },
        new_tradeoffs: capped.warnings
          .filter(({ code }) => !warnings.some((item) => item.code === code))
          .map(({ code, message }) => ({ code, message })),
      };
    } else {
      result.budget_alternative = {
        status: 'unavailable', budget_usd: budget,
        method: 'Rerun the same inputs with a hard cap on the modeled upper monthly cost.',
        reason: capped.warnings.find(({ code }) => code === 'BUDGET_HARD_CAP')?.message ?? capped.summary,
      };
    }
  }
  return result;
}
