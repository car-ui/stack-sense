import { frontend, backend, database, hosts, regions } from './catalog.mjs';
import { recoveryExclusion, recoveryRequest } from './recovery.mjs';

export const none = (alternative, whyNot, justification, fields) => ({
  choice: 'None', justification, driven_by: fields,
  alternatives: [{ choice: alternative, why_not: whyNot }], tradeoffs: ['New requirements may introduce this layer.'],
});

function ranked(options, score) {
  return options.map((item) => {
    const signals = [];
    const add = (points, field, reason) => signals.push({ points, field, reason });
    score(item, add);
    return { item, signals, score: signals.reduce((sum, signal) => sum + signal.points, 0) };
  }).sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1));
}

function compare(winner, runner) {
  const factors = new Map();
  for (const [row, direction] of [[winner, 1], [runner, -1]]) {
    for (const signal of row.signals) {
      const value = factors.get(signal.field) || { field: signal.field, points: 0, selected: [], alternative: [] };
      value.points += signal.points * direction;
      value[direction === 1 ? 'selected' : 'alternative'].push(signal.reason);
      factors.set(signal.field, value);
    }
  }
  return [...factors.values()].filter((factor) => Math.abs(factor.points) > 0.005)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .map((factor) => ({ ...factor, points: Number(factor.points.toFixed(2)) }));
}

function describe(rows, fallback, extra = '') {
  const [{ item, score, signals }, runner] = rows;
  const positives = signals.filter((s) => s.points > 0).sort((a, b) => b.points - a.points);
  const negatives = signals.filter((s) => s.points < 0);
  const driver = [...positives.slice(0, 4), ...negatives.slice(0, 2)];
  const factors = runner ? compare(rows[0], runner) : [];
  const deciding = factors.filter((factor) => factor.points > 0).slice(0, 2);
  const offset = factors.find((factor) => factor.points < 0);
  const gap = runner ? Number((score - runner.score).toFixed(2)) : null;
  return {
    choice: item.choice,
    justification: [...new Set([item.benefit, ...driver.map((s) => s.reason), extra].filter(Boolean))].join(' '),
    driven_by: [...new Set(driver.map((s) => s.field))],
    alternatives: [runner ? {
      choice: runner.item.choice,
      why_not: score === runner.score ? 'Its total fit score tied. The stable catalogue ID resolves identical scores.' :
        ['It scored ' + (gap || 'less than 0.01') + ' points lower on combined fit.',
          ...deciding.map((factor) => factor.selected.find((reason) => !factor.alternative.includes(reason)) ||
            (factor.alternative.length ? 'The alternative scored lower on ' + factor.field + '.' : factor.selected[0])),
          ...(offset ? ['The alternative gained points on ' + offset.field + '.'] : [])].filter(Boolean).join(' '),
      score_gap: gap,
      factors,
    } : fallback],
    tradeoffs: [item.tradeoff],
    source: item.source,
    fit_score: Number(score.toFixed(2)),
  };
}

const languageFit = (item, c, add) => {
  const match = item.languages.find((lang) => c.d.team.languages.includes(lang));
  const effort = 2 + c.p.time_to_market + Number(c.small) * 2;
  if (match) add(effort, 'team.languages', 'The team already lists ' + match + '.');
  else if (item.languages.length && c.d.team.languages.length) add(-effort, 'team.languages', 'This option adds a language outside the listed team skills.');
};

export function context(d, residency, systems) {
  const r = d.requirements, p = d.priorities, s = d.scale;
  const actualUsers = Math.max(s.users_at_launch, s.users_12_months);
  const peak = s.peak_concurrent_users ?? Math.min(actualUsers, Math.ceil(actualUsers * 0.02));
  const requestRate = d.project.type === 'realtime_collab' && r.realtime ? 0.6 : r.realtime ? 0.15 : 0.25;
  const rps = d.context.peak_requests_per_second ?? Math.ceil(peak * requestRate);
  const peakDayRequests = d.context.peak_day_requests ?? Math.max(rps * 600, actualUsers * 2);
  const dataGb = s.data_volume_gb_12_months ?? Math.ceil(actualUsers * 0.0002);
  const recovery = recoveryRequest(d);
  const searchGb = d.context.search_corpus_gb ?? dataGb * (r.file_media_storage ? 0.15 : 1);
  const volume = Math.max(1, rps / 125, dataGb / (r.file_media_storage ? 250 : 90), r.realtime ? peak / 800 : peak / 3500);
  const regulated = d.compliance.some((v) => ['rbi_localisation', 'pci_dss', 'hipaa'].includes(v));
  const sensitive = d.context.data_classification === 'sensitive';
  const privateData = sensitive || d.context.data_classification === 'internal';
  const browser = d.project.platforms.includes('web');
  const mobile = d.project.platforms.includes('android') || d.project.platforms.includes('ios');
  const desktop = d.project.platforms.includes('desktop');
  const staticSite = d.project.type === 'content_site' && browser && !mobile && !desktop &&
    !r.realtime && !r.payments && r.auth === 'none' && !r.file_media_storage && r.ml_features === 'none' &&
    !r.multi_tenant && !regulated && !privateData && s.workload !== 'write_heavy';
  return {
    d, r, p, residency, systems, actualUsers, peak, rps, requestRate, peakDayRequests, dataGb, searchGb, volume,
    regulated, sensitive, privateData, browser, mobile, desktop, staticSite,
    small: d.team.size <= 3 || d.team.experience === 'beginner',
    quick: d.timeline.mvp_weeks <= 6,
    recovery,
    ha: Number(r.availability) >= 99.95 || (!staticSite && recovery.zonalStandby),
    lowLatency: r.p95_latency_ms !== null && r.p95_latency_ms <= 120,
    local: ['on_premise', 'air_gapped'].includes(d.infrastructure.deployment_model),
    air: d.infrastructure.deployment_model === 'air_gapped',
    lowEnd: /(?:low[- ]end android|\b2\s*gb\s*ram\b|\b2g\/3g\b)/i.test(d.project.description),
  };
}

export function client(c) {
  if (!c.browser && !c.mobile && !c.desktop) {
    return none('React + Vite', 'A browser client adds no value to the requested API-only delivery.',
      'Expose documented endpoints and an OpenAPI contract to client teams.', ['project.platforms']);
  }
  let webRows = ranked(frontend.filter((f) => {
    if (c.staticSite) return ['astro', 'html', 'next', 'react', 'vue'].includes(f.id);
    if (c.r.seo_critical) return ['next', 'blazor'].includes(f.id);
    return ['next', 'react', 'vue', 'blazor'].includes(f.id);
  }), (f, add) => {
    languageFit(f, c, add);
    if (f.id === 'astro') add(18, 'project.type', 'Content pages can be built before traffic arrives.');
    if (f.id === 'html') add(c.actualUsers < 1000 ? 12 : 8, 'scale.users_12_months', 'A small site can avoid a framework and keep the build simple.');
    if (f.id === 'next' && c.r.seo_critical) add(14, 'requirements.seo_critical', 'SEO-critical pages need crawlable HTML.');
    if (f.id === 'react' || f.id === 'vue') add(8, 'project.platforms', 'Interactive web views can ship as immutable assets.');
    if (f.id === 'react' && c.r.realtime) add(6, 'requirements.realtime', 'The client can keep frequent updates isolated in interactive views.');
    if (f.id === 'vue' && c.quick) add(3, 'timeline.mvp_weeks', 'A compact template workflow helps deliver a short MVP.');
    if (f.id === 'blazor' && c.d.project.type === 'internal_tool') add(14, 'project.type', 'Form-heavy internal pages benefit from shared .NET models.');
    if (f.id === 'blazor' && c.systems.sql) add(5, 'infrastructure.existing_systems', 'Shared .NET models fit the existing Microsoft data environment.');
    if (f.id === 'blazor' && c.r.offline_support) add(-10, 'requirements.offline_support', 'An interactive server circuit depends on connectivity.');
  });

  const mobileRows = ranked(frontend.filter((f) => ['rn', 'flutter'].includes(f.id) ||
    (f.id === 'kotlin' && c.d.project.platforms.includes('android') && !c.d.project.platforms.includes('ios'))), (f, add) => {
    languageFit(f, c, add);
    if (f.id === 'rn' || f.id === 'flutter') add(c.mobile && c.d.project.platforms.includes('ios') ? 14 : 6, 'project.platforms', 'A shared codebase reduces platform duplication.');
    if (f.id === 'rn' && c.browser) add(5, 'project.platforms', 'Share TypeScript validation and API contracts with the web client.');
    if (f.id === 'kotlin' && c.r.offline_support) add(15, 'requirements.offline_support', 'Use Room for the durable queue and WorkManager for network-aware retries.');
    if (f.id === 'kotlin' && c.lowEnd) add(8, 'project.description', 'The low-end or intermittent-connectivity description favors testing a native Android client.');
  });

  const parts = [];
  if (c.browser) {
    if (c.staticSite && webRows[0].item.id === 'next') {
      webRows = webRows.map((row) => row.item.id === 'next' ?
        { ...row, item: { ...row.item, choice: 'Next.js (static export)', benefit: 'Generates prebuilt HTML routes for static hosting.', tradeoff: 'Runtime SSR features cannot be used in a static export.' } } : row);
    }
    parts.push(describe(webRows, { choice: 'Astro', why_not: 'This configuration needs dynamic server-rendered routes.' },
      c.r.offline_support ? 'Use a Service Worker plus IndexedDB for drafts, an outbox and replay with idempotency keys.' : ''));
  }
  if (c.mobile) parts.push(describe(mobileRows, { choice: 'Flutter', why_not: 'The current client has stronger platform fit.' },
    c.r.offline_support && mobileRows[0].item.id !== 'kotlin'
      ? 'Use a local SQLite outbox and test background synchronization on each OS.' : ''));
  if (c.desktop) {
    const rows = ranked(frontend.filter((f) => ['tauri', 'flutter'].includes(f.id)), (f, add) => {
      languageFit(f, c, add);
      add(f.id === 'flutter' && c.mobile ? 10 : 6, 'project.platforms',
        f.id === 'flutter' ? 'The desktop target can reuse Flutter components.' : 'The desktop target can ship as a native package.');
    });
    parts.push(describe(rows, null, c.r.offline_support ? 'Persist drafts to local SQLite and replay once connected.' : ''));
  }
  if (parts.length === 1) return parts[0];
  return {
    choice: [...new Set(parts.map((part) => part.choice))].join(' (client) + '),
    justification: parts.map((part) => part.justification).join(' '),
    driven_by: [...new Set(parts.flatMap((part) => part.driven_by))],
    alternatives: parts.flatMap((part) => part.alternatives),
    tradeoffs: [...new Set(parts.flatMap((part) => part.tradeoffs)), 'Keep identity, schemas and regression checks consistent across client builds.'],
    sources: [...new Set(parts.map((part) => part.source))],
  };
}

export function app(c, host) {
  if (c.staticSite) return none('Node.js + Fastify', 'A server would add cost and patching without application writes or authentication.',
    'The public site can be built ahead of time and served as files.', ['project.type', 'requirements.auth', 'scale.workload']);
  const edge = host.maturity === 'edge_api';
  const rows = ranked(backend.filter((f) => (f.id === 'hono') === edge), (f, add) => {
    languageFit(f, c, add);
    if (edge) add(12, 'budget.monthly_infra_usd', 'This runtime keeps the small HTTP service inside the free Workers and D1 envelope.');
    add(1, 'project.type', 'A single deployable API keeps the initial service boundary explicit.');
    if (f.id === 'fastify') add(c.quick || c.small ? 6 : 3, 'team.size', 'A small HTTP surface keeps initial operational work low.');
    if (f.id === 'fastify' && c.r.realtime) add(5, 'requirements.realtime', 'Use one Node.js runtime for HTTP and a realtime route.');
    if (f.id === 'nest' && (c.r.multi_tenant || c.r.realtime)) add(8, c.r.realtime ? 'requirements.realtime' : 'requirements.multi_tenant',
      c.r.realtime ? 'Explicit modules separate socket events, accounts and business logic.' : 'Explicit modules keep tenant-aware authorization near the domain logic.');
    if (f.id === 'nest' && c.r.multi_tenant) add(4, 'requirements.multi_tenant', 'Request guards can centralize tenant context and authorization.');
    if (f.id === 'spring' && (c.regulated || c.d.project.type === 'fintech')) add(9 + c.p.security, 'project.type', 'A transaction boundary protects ledger writes and records auditable state changes.');
    if (f.id === 'dotnet' && c.systems.sql) add(11, 'infrastructure.existing_systems', 'Use the supported SQL Server driver and enterprise integration path.');
    if (f.id === 'dotnet' && c.r.auth === 'enterprise_sso') add(5, 'requirements.auth', 'OIDC middleware integrates with enterprise identity.');
    if (f.id === 'fastapi' && c.r.ml_features !== 'none') add(8, 'requirements.ml_features', 'A typed API works with Python model serving.');
    if (f.id === 'fastapi' && c.d.project.platforms.includes('api_only')) add(6, 'project.platforms', 'Generate OpenAPI contracts for external client teams.');
    if (f.id === 'fastapi' && c.r.offline_support) add(8, 'requirements.offline_support', 'Typed sync batches support idempotent retries and version negotiation.');
    if (f.id === 'django' && !c.r.realtime && (c.d.project.type === 'internal_tool' || c.d.project.type === 'ecommerce')) add(6, 'project.type', 'Use built-in administration and migrations for operational workflows.');
    if (f.id === 'go' && c.lowLatency) add(4 + c.p.performance, 'requirements.p95_latency_ms', 'A compact service and concurrent I/O suit tight response-time targets.');
    else if (f.id === 'go' && c.rps >= 500) add(4 + c.p.performance, 'context.peak_requests_per_second', 'A compact service and concurrent I/O suit the peak request proxy.');
    if ((f.id === 'laravel' || f.id === 'rails') && c.small && !c.r.realtime) add(5, 'team.size', 'Integrated application primitives reduce assembly for a small team.');
  });
  return describe(rows, edge ? { choice: 'Node.js + Fastify', why_not: 'The regional container profile adds a recurring compute and data baseline.' } : null, c.r.offline_support
    ? 'Use stable client-generated operation IDs, change cursors, version conflicts and retry-safe commits.' : '');
}

function dbRows(h, c) {
  if (c.staticSite) return [];
  if (h.maturity === 'edge_api') {
    return ranked(database.filter((db) => db.id === 'd1'), (db, add) => {
      add(8, 'scale.data_volume_gb_12_months', 'The estimated dataset fits the conservative 0.25 GB planning threshold.');
      add(8, 'scale.workload', 'Indexed, read-heavy queries can stay inside the D1 Free row budget.');
    });
  }
  const transactional = c.regulated || c.r.multi_tenant || c.r.payments ||
    ['fintech', 'marketplace', 'ecommerce'].includes(c.d.project.type) || c.d.context.data_profile === 'relational';
  const compact = c.rps <= 40 && c.peak <= 120 && c.dataGb <= 10 && !c.ha &&
    !transactional && c.d.scale.workload !== 'write_heavy' && !c.r.realtime;
  const managed = h.model === 'managed_cloud';
  const available = {
    aws: ['rds', 'dynamo'], gcp: ['cloudsql'], azure: ['azurepg', 'azuredb'],
  };
  const options = database.filter((db) => {
    if (db.id === 'legacySql') return c.r.ml_features !== 'llm_rag' && c.systems.sql && !c.systems.retiredSql && !c.ha &&
      !c.regulated && !c.r.full_text_search && (h.provider === 'azure' || h.provider === 'local') &&
      (h.model === 'on_premise' || h.model === 'managed_cloud' || (c.air && !c.systems.sqlOnPrem));
    if (db.id === 'sqlite') return c.r.ml_features !== 'llm_rag' && !managed && compact;
    if (db.id === 'mongo' || db.id === 'dynamo') return !transactional && !c.r.full_text_search &&
      c.r.ml_features !== 'llm_rag' && c.d.context.data_profile === 'document' &&
      (db.id === 'mongo' ? !managed : h.provider === 'aws' && managed);
    if (db.id === 'pg' || db.id === 'maria') return !managed &&
      (db.id === 'pg' || !c.r.multi_tenant && !c.r.full_text_search && c.r.ml_features !== 'llm_rag');
    return managed && available[h.provider]?.includes(db.id) &&
      (db.id !== 'azuredb' || !c.r.full_text_search && c.r.ml_features !== 'llm_rag');
  });
  return ranked(options, (db, add) => {
    add(3, 'scale.workload', 'The data layer is paired with the selected deployment model.');
    if (db.id === 'legacySql') add(30, 'infrastructure.existing_systems', 'Reuse the existing database via a TLS-protected private path; verify its facility and backups match residency.');
    if (db.id === 'sqlite') add(8 + c.p.cost, 'budget.monthly_infra_usd', 'Low concurrency and a small working set can use an embedded database.');
    if (db.id === 'mongo' || db.id === 'dynamo') add(14, 'context.data_profile', 'A document model fits independently retrieved aggregates.');
    if (db.id === 'dynamo' && c.d.context.vendor_lock_in === 'low') add(-9, 'context.vendor_lock_in', 'DynamoDB partition and query APIs add migration work when portability is important.');
    if (['rds', 'cloudsql', 'azurepg', 'pg'].includes(db.id)) {
      add(6, 'scale.workload', 'SQL transactions fit durable state and indexed access.');
      if (c.d.context.data_profile === 'document' && c.d.context.vendor_lock_in === 'low') add(5, 'context.vendor_lock_in', 'JSONB keeps document payloads on a portable PostgreSQL data model.');
      if (c.r.multi_tenant) add(7, 'requirements.multi_tenant', 'Enforce tenant keys and row-level policies alongside application checks.');
      if (c.r.full_text_search) add(6, 'requirements.full_text_search', 'Native text indexes can cover the first search workload.');
      if (c.r.ml_features === 'llm_rag') add(8, 'requirements.ml_features', 'Keep vector retrieval near the primary data where the pgvector extension is available.');
      if (c.d.context.data_profile === 'time_series') add(4, 'context.data_profile', 'Time-based partitioning supports retention and bounded scans.');
    }
    if (db.id === 'maria' && c.systems.mysql) add(15, 'infrastructure.existing_systems', 'Use MySQL-compatible schema and clients, with a migration compatibility check.');
    if (db.id === 'pg' && c.systems.pg) add(8, 'infrastructure.existing_systems', 'Reuse compatible PostgreSQL schemas and drivers.');
    if (db.id === 'azuredb' && (c.systems.sql || c.d.team.languages.includes('csharp'))) add(9, 'team.languages', 'T-SQL and .NET reduce data-layer retraining.');
  });
}

function exclusion(h, c) {
  const i = c.d.infrastructure;
  if (h.model !== i.deployment_model) return 'Requires a different deployment model.';
  if (i.cloud_preference === 'none' && h.provider !== 'local') return 'Requires a cloud provider.';
  if (!['any', 'none'].includes(i.cloud_preference) && i.cloud_preference !== h.provider) return 'Conflicts with the explicit provider.';
  if (h.maturity === 'static' && (!c.staticSite || c.residency !== 'none' || c.d.compliance.length)) {
    return 'Public edge hosting lacks the required runtime or regional control.';
  }
  if (c.residency !== 'none' && h.provider !== 'local' && !regions[h.provider]?.[c.residency]) return 'No catalogued region matches the data geography.';
  if (h.maturity === 'edge_api') {
    const { r, d } = c;
    if (c.privateData) return 'The free public profile does not meet the declared data classification.';
    if (c.staticSite || !['web_app', 'api_platform'].includes(d.project.type)) return 'Reserved for small public web apps and HTTP APIs with persistent reads.';
    if (d.compliance.length || i.existing_systems.length) return 'The free public data plane cannot verify regulated or existing-system boundaries.';
    if (c.mobile || c.desktop || c.ha || c.lowLatency || r.realtime || r.offline_support || r.full_text_search ||
        r.file_media_storage || r.payments || r.auth !== 'none' || r.multi_tenant || r.ml_features !== 'none' ||
        r.seo_critical || d.scale.workload !== 'read_heavy') {
      return 'The free profile assumes a read-heavy public HTTP API without advanced services or a strict SLO.';
    }
    if (!['general', 'relational'].includes(d.context.data_profile) || c.dataGb > 0.25 || c.rps > 20 || c.peakDayRequests > 40000) {
      return 'The data model, stored size or request forecast exceeds the conservative free-profile envelope.';
    }
    if (d.team.languages.length && !d.team.languages.some((lang) => ['typescript', 'javascript'].includes(lang))) {
      return 'The catalogued edge runtime requires JavaScript or TypeScript.';
    }
  }
  if (h.id === 'github' && c.d.context.monthly_egress_gb > 100) return 'Projected monthly egress exceeds the documented 100 GB soft bandwidth limit.';
  return null;
}

export function chooseDeployment(c, costOf) {
  const excluded = [];
  const blockedByBudget = [];
  const hardCap = c.d.context.budget_policy === 'hard_cap';
  const budget = c.d.budget.monthly_infra_usd;
  const options = hosts.flatMap((h) => {
    const reason = exclusion(h, c);
    if (reason) {
      excluded.push({ choice: h.choice, reason });
      return [];
    }
    const databases = dbRows(h, c);
    const candidates = databases.filter(({ item }) => !recoveryExclusion(c, h, item.id));
    const recoveryReason = recoveryExclusion(c, h, databases[0]?.item.id);
    if ((c.staticSite || databases.length) && !candidates.length && recoveryReason) {
      excluded.push({ choice: h.choice, reason: recoveryReason });
      return [];
    }
    if (!c.staticSite && !candidates.length) {
      excluded.push({ choice: h.choice, reason: 'No compatible database for this workload and provider.' });
      return [];
    }
    const variants = hardCap && candidates.length ? candidates : [candidates[0]];
    const priced = variants.map((db) => ({ db, cost: costOf(h, db?.item.id) }));
    const eligible = hardCap ? priced.filter(({ cost }) => cost.max <= budget) : priced;
    if (!eligible.length) {
      const cheapest = priced.reduce((a, b) => a.cost.max <= b.cost.max ? a : b);
      blockedByBudget.push({ choice: h.choice, min_usd: cheapest.cost.min, max_usd: cheapest.cost.max });
      excluded.push({ choice: h.choice, reason: 'Best modeled ceiling USD ' + cheapest.cost.max + ' exceeds the hard cap of USD ' + budget + '.' });
      return [];
    }
    const db = hardCap ? eligible.map((row) => row.db).filter(Boolean) : candidates;
    const cappedOut = hardCap ? priced.find((row) => row.db && row.cost.max > budget) : undefined;
    return [{ ...h, db, cappedOut, ...eligible[0].cost }];
  });
  const rows = ranked(options, (h, add) => {
    add(5, 'infrastructure.deployment_model', 'Fits the requested ' + h.model.replaceAll('_', ' ') + ' model.');
    if (!['none', 'any'].includes(c.d.infrastructure.cloud_preference)) {
      add(6, 'infrastructure.cloud_preference', 'Retains the explicit ' + h.provider.toUpperCase() + ' provider.');
    }
    if (c.residency !== 'none') add(4, 'infrastructure.data_residency', 'Place the data plane and backups in the selected geography.');
    if (h.maturity === 'static') add(32, 'project.type', 'Public files do not need an always-on server.');
    if (h.id === 'pages') add(2, 'scale.traffic_pattern', 'Cloudflare Pages serves static requests without metering them against Functions quotas.');
    if (h.maturity === 'edge_api') {
      add(5 + c.p.cost, 'budget.monthly_infra_usd', 'The $0 tier fits the forecast inside published quota headroom.');
      if (c.d.context.vendor_lock_in === 'low') add(-7, 'context.vendor_lock_in', 'Workers and D1 bindings add platform-specific migration work.');
    }
    if (h.id === 'run' && c.d.scale.traffic_pattern !== 'steady' && !c.r.realtime) add(5 + c.p.scalability, 'scale.traffic_pattern', 'Request-based autoscaling matches bursts without keeping full peak capacity idle.');
    if (h.id === 'run' && c.r.realtime) add(-6, 'requirements.realtime', 'Connection timeouts, active billing and cross-instance fanout add friction for persistent realtime.');
    if (h.id === 'fargate' && c.r.realtime) add(7 + c.p.security, 'requirements.realtime', 'Always-on container tasks avoid scale-to-zero and request time limits on persistent connections.');
    else if (h.id === 'fargate' && c.regulated) add(7 + c.p.security, 'compliance', 'Private tasks and a regional load balancer provide a configurable regulated data plane.');
    if (h.id === 'appservice' && c.systems.sql) add(12, 'infrastructure.existing_systems', 'Hybrid Connections or private networking can reach the existing SQL endpoint.');
    if (h.id === 'appservice' && c.d.team.languages.includes('csharp')) add(4, 'team.languages', 'Managed .NET hosting reduces delivery setup.');
    if (h.model === 'managed_cloud' && !c.d.team.has_devops) add(3 + c.p.maintainability, 'team.has_devops', 'Managed compute reduces infrastructure maintenance for the team.');
    if (h.provider !== 'edge' && c.d.context.vendor_lock_in === 'low') add(4, 'context.vendor_lock_in', 'Portable containers keep the application runtime transferable.');
    if (h.min > c.d.budget.monthly_infra_usd) add(-12 - c.p.cost * 2, 'budget.monthly_infra_usd', 'Its modeled floor exceeds the budget.');
    else if (h.max > c.d.budget.monthly_infra_usd) add(-3 - c.p.cost, 'budget.monthly_infra_usd', 'The high end could exceed the budget.');
    const modeledMidpoint = h.min / 2 + h.max / 2;
    add(-2 * modeledMidpoint / (80 + c.d.budget.monthly_infra_usd / c.p.cost), 'budget.monthly_infra_usd',
      'The modeled USD ' + h.min + '–' + h.max + ' per month affects ranking.');
  });
  if (!rows.length) return { h: null, excluded, blockedByBudget };
  const h = rows[0].item;
  const region = regions[h.provider]?.[c.residency === 'none' ? 'us' : c.residency] ||
    (h.provider === 'local' ? (c.residency === 'other' ? c.d.context.residency_region :
      c.residency === 'none' ? 'approved local facility' : 'approved ' + c.residency.toUpperCase() + ' facility') : 'public edge');
  const costAlternative = blockedByBudget.reduce((best, item) => !best || item.max_usd < best.max_usd ? item : best, null);
  const hosting = describe(rows, costAlternative ? {
    choice: costAlternative.choice,
    why_not: 'Its lowest modeled ceiling of USD ' + costAlternative.max_usd + ' exceeds the hard cap of USD ' + budget + '.',
  } : {
    choice: excluded[0]?.choice || 'Managed container platform',
    why_not: excluded[0]?.reason || 'It does not meet the required placement or operations boundary.',
  }, 'Placement: ' + region + '.' + (c.ha ? ' Provision redundant ingress and application capacity across fault domains.' : ''));
  const db = c.staticSite
    ? none('PostgreSQL', 'A live database adds no value for build-time pages.', 'Keep content in version-controlled files or Markdown.', ['project.type', 'scale.workload'])
    : describe(h.db, h.cappedOut ? {
      choice: h.cappedOut.db.item.choice,
      why_not: 'This hosting and database combination reaches USD ' + h.cappedOut.cost.max + ', above the hard cap of USD ' + budget + '.',
    } : h.maturity === 'edge_api' ? {
      choice: 'Cloud SQL for PostgreSQL',
      why_not: 'A dedicated managed instance has a recurring compute cost. Use it when quota or workload needs outgrow this profile.',
    } : {
      choice: h.db[0].item.id === 'pg' ? 'Managed relational database' : 'Self-managed PostgreSQL',
      why_not: 'Changing database ownership would add operations or cross the selected deployment boundary.',
    }, c.ha ? 'Use fault-domain redundancy and prove restore and failover behavior.' : '');
  const shortlist = rows.map(({ item, score }, index) => ({
    choice: item.choice, database: item.db[0]?.item.choice || 'None',
    min_usd: item.min, max_usd: item.max, fit_score: Number(score.toFixed(2)), selected: index === 0,
  }));
  return { hosting, db, h, region, shortlist, excluded };
}
