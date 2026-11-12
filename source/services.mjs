const service = (layer, choice, justification, driven_by, alternative, whyNot, tradeoff) => ({
  layer, choice, justification, driven_by, alternatives: [{ choice: alternative, why_not: whyNot }], tradeoffs: [tradeoff],
});

const cloudStorage = {
  aws: 'Amazon S3', gcp: 'Google Cloud Storage', azure: 'Azure Blob Storage', local: 'SeaweedFS',
};
const keyManagement = {
  aws: 'AWS Key Management Service',
  gcp: 'Google Cloud KMS',
  azure: 'Azure Key Vault',
  local: 'OpenBao + encrypted volumes',
};
const managedDbBand = {
  rds: [18, 50], cloudsql: [16, 43], azurepg: [19, 55], azuredb: [15, 55], legacySql: [5, 25], dynamo: [2, 35],
};
// Rounded planning intervals, before contract discounts. See catalog pricing references.
const egressRates = { aws: [0.07, 0.15], gcp: [0.08, 0.20], azure: [0.08, 0.16] };
const roundUp = (value, unit) => Math.ceil(value / unit) * unit;

export function costBand(c, h, db, plan) {
  if (h.maturity === 'edge_api') {
    return {
      min: 0, max: 0, costDrivers: [
        { driver: 'Workers Free HTTP compute + static assets', min: 0, max: 0 },
        { driver: 'D1 Free database within account quotas', min: 0, max: 0 },
      ],
    };
  }
  const rows = [];
  const add = (driver, min, max) => rows.push({ driver, min, max });
  const component = (layer) => plan.find((part) => part.layer === layer);
  const [hostMin, hostMax] = h.band;
  const edge = h.maturity === 'static';
  const weight = c.staticSite ? 1 : c.volume ** 0.68;
  const haFactor = c.ha ? 2.1 : 1;
  const dbWeight = Math.max(1, weight * (c.d.scale.workload === 'write_heavy' ? 1.15 : 0.8));
  const computeMin = hostMin * weight * haFactor;
  const computeMax = hostMax * weight * haFactor;
  const splitRealtime = c.r.realtime && c.peak >= 1000;
  add(splitRealtime ? 'Ingress + API compute' : 'Ingress + compute',
    computeMin * (splitRealtime ? 0.7 : 1), computeMax * (splitRealtime ? 0.7 : 1));
  if (splitRealtime) add('Realtime gateway compute', computeMin - computeMin * 0.7, computeMax - computeMax * 0.7);
  if (managedDbBand[db]) add('Database capacity + backups', managedDbBand[db][0] * dbWeight * haFactor,
    managedDbBand[db][1] * dbWeight * haFactor);
  else if (db && db !== 'sqlite') add('Additional database capacity + backups', 4 * weight * haFactor, 18 * weight * haFactor);
  if (component('storage')) {
    const hasEgress = c.d.context.monthly_egress_gb !== null;
    add(hasEgress ? 'Object storage + request allowance' : 'Object storage + baseline media transfer',
      c.dataGb * 0.025, c.dataGb * (hasEgress ? 0.06 : 0.1));
  }
  const egress = c.d.context.monthly_egress_gb;
  const rates = egressRates[h.provider];
  if (egress !== null && rates) add('Internet egress (' + egress + ' GB)', egress * rates[0], egress * rates[1]);
  if (component('cache')) add('Valkey capacity' + (c.r.realtime ? ' and fanout' : ''), 12 * weight * haFactor, 34 * weight * haFactor);
  if (component('search')?.choice === 'OpenSearch') add('Dedicated search nodes', 45 * weight * haFactor, 135 * weight * haFactor);
  if (c.r.auth === 'phone_otp') add('Metered OTP allowance', 4, Math.min(400, 12 + c.actualUsers * 0.0003));
  if (component('auth')?.choice === 'Keycloak') {
    const authFactor = c.regulated || c.r.auth === 'enterprise_sso' ? 2 : 1;
    add('Identity service capacity', 2 * weight * authFactor * haFactor, 9 * weight * authFactor * haFactor);
    if (['sqlite', 'mongo', 'dynamo'].includes(db)) {
      add('Separate PostgreSQL store for identity', (h.model === 'managed_cloud' ? 18 : 4) * haFactor, 50 * haFactor);
    }
  }
  if (c.r.ml_features === 'inference_api') add('CPU inference workers', 12 * weight, 55 * weight);
  if (c.r.ml_features === 'llm_rag') add('RAG serving and vector storage', 90 * weight, 420 * weight);
  if (c.r.ml_features === 'training') add('Burst training GPU jobs', 150 * weight, 900 * weight);
  if (component('queue')) {
    const broker = component('queue').choice === 'RabbitMQ';
    add(broker ? 'RabbitMQ broker + workers' : 'Background outbox workers',
      (broker ? 8 : 4) * weight * haFactor, (broker ? 25 : 12) * weight * haFactor);
  }
  if (component('observability')) add('Metrics storage + retained logs', 2 * weight, 10 * weight);
  if (c.sensitive) add('Key management + audit retention', 4 * weight, 18 * weight);
  if (c.recovery.regional) {
    const [dbMin, dbMax] = managedDbBand[db];
    add('Recovery-region ingress + warm compute', hostMin * weight, hostMax * weight);
    add('Recovery-region PostgreSQL replica', dbMin * dbWeight, dbMax * dbWeight);
    add('Replication transfer + backup allowance', 5 + c.dataGb * 0.015, 25 + c.dataGb * 0.08);
  }
  if (c.systems.sqlOnPrem && db === 'legacySql' && h.provider === 'azure') add('Hybrid relay and private connectivity', 8, 28);
  if (!edge) add('General networking and telemetry allowance', 1 * weight, 8 * weight);
  const min = Math.floor(rows.reduce((sum, row) => sum + row.min, 0));
  const max = roundUp(rows.reduce((sum, row) => sum + row.max, 0), 5);
  return { min, max, costDrivers: rows.map(({driver, min: low, max: high}) =>
    ({ driver, min: Number(low.toFixed(2)), max: Number(high.toFixed(2)) })) };
}

export function supporting(c, h, db) {
  const r = c.r;
  const list = [];
  const add = (...args) => list.push(service(...args));
  const region = h.provider === 'local' ? 'approved facility' : 'selected region';
  if (h.maturity === 'static') {
    add('cdn', h.choice + ' delivery', 'Serve public build assets through the hosting provider and keep private data out of the published bundle.',
      ['project.type', 'scale.workload'], 'Amazon CloudFront', 'The bundled delivery path avoids a separate distribution.',
      'Public assets are cached internationally and subject to platform quotas.');
  } else if (c.staticSite) {
    add('other', 'Nginx', 'Serve the immutable build directly and cache public assets behind the regional or local ingress.',
      ['project.type', 'infrastructure.deployment_model'], 'Node.js application server', 'No runtime application logic is needed.',
      'Own TLS configuration when hosting the reverse proxy yourself.');
  }

  if (r.auth !== 'none') {
    const entra = c.systems.entra && h.provider === 'azure' && r.auth === 'enterprise_sso' && !c.air && !c.regulated;
    let choice = entra ? 'Microsoft Entra ID (existing tenant)' : 'Keycloak';
    let purpose = {
      email_password: 'Run password and recovery flows with rate limits, MFA policy and breach monitoring.',
      social: 'Broker an approved OIDC identity provider and keep application roles in the local realm.',
      phone_otp: 'Use a reviewed authenticator extension with a region-approved SMS gateway. Store short-lived OTP state locally and apply per-number throttles.',
      enterprise_sso: 'Use OIDC or SAML with scoped group-to-role mapping and least-privilege service identities.',
    }[r.auth];
    if (entra) purpose += ' Confirm tenant residency and map application roles to existing groups.';
    else {
      purpose += ' Deploy the identity realm and its database in the ' + region + '.';
      if (['sqlite', 'mongo', 'dynamo'].includes(db)) {
        purpose += ' Use a separate supported PostgreSQL instance for the identity realm, included in the cost band.';
      } else {
        purpose += ' Use a separate logical database or schema with its own account on the selected relational platform.';
      }
    }
    add('auth', choice, purpose, ['requirements.auth', 'infrastructure.existing_systems', 'infrastructure.data_residency'],
      entra ? 'Keycloak' : 'Microsoft Entra ID', entra ? 'An additional identity realm duplicates the existing enterprise directory.' :
        'An external directory adds an account and an independent data plane.', 'Account lifecycle, recovery and federation scopes require explicit configuration.');
  }

  if (r.file_media_storage) {
    add('storage', cloudStorage[h.provider], (c.local ?
      'Host private object storage inside the facility. Issue scoped upload credentials from the API.' :
      'Use a private bucket in the same region as the API with short-lived signed uploads and encryption.') +
      (r.offline_support ? ' Resume or retry media transfer independently from sync metadata.' : '') +
      (c.regulated || c.sensitive ? ' Separate restricted document buckets, audit access and keep backups within policy.' : ''),
      ['requirements.file_media_storage', 'infrastructure.data_residency', 'requirements.offline_support'],
      'Database BLOB columns', 'Independent object retention and direct upload reduce transactional I/O.', 'Lifecycle rules and egress need budgeting and review.');
  }

  if (r.full_text_search) {
    if (c.staticSite) {
      add('search', 'Pagefind', 'Index generated HTML at build time and query the index in the browser. Deploy the index with the same static release.',
        ['project.type', 'requirements.full_text_search'], 'OpenSearch', 'An always-on search cluster would add compute to a prebuilt site.',
        'Rebuild the index when publishing and test index download size on slower clients.');
    } else {
      const large = c.searchGb >= 500;
      const native = db === 'sqlite' ? 'SQLite FTS5' : 'PostgreSQL full-text search';
      add('search', large ? 'OpenSearch' : native, large ? 'Use a co-located index for heavy text retrieval, with the primary store as source of truth.' :
        'Start with a native text index in the data store and measure query latency on the target corpus.',
        ['requirements.full_text_search', 'context.search_corpus_gb', 'scale.data_volume_gb_12_months'], large ? native : 'OpenSearch',
        large ? 'Separate indexing and ranking can isolate large search load from OLTP.' : 'A separate cluster adds synchronization and operating cost.',
        large ? 'Expect eventual consistency and duplicate index storage.' : 'Advanced typo tolerance or faceting may need another index later.');
    }
  }

  const needsRealtimeFanout = r.realtime && (c.peak >= 1000 || c.ha || h.id === 'run');
  if (r.realtime) {
    const collab = c.d.project.type === 'realtime_collab';
    add('realtime', collab ? 'Yjs + Hocuspocus' : 'WebSockets (application transport)', collab ?
      'Authorize each document and store binary Yjs state through the Database extension. ' +
        (needsRealtimeFanout ? 'Use the Redis extension with regional Valkey for cross-instance fanout. ' : '') +
        'Test the persistence interval and reconnect behavior.' :
      'Use authenticated channels, bounded reconnect backoff and durable messages where delivery matters.',
      ['requirements.realtime', 'project.type', 'requirements.p95_latency_ms'], collab ? 'WebSocket transport without a CRDT' : 'Periodic HTTP polling',
      collab ? 'Transport alone does not resolve concurrent document edits.' : 'Polling adds load and delays updates under peak concurrency.',
      collab && needsRealtimeFanout ? 'Fanout delivers each update to the other instances. Hot-room load and the interval between durable writes need measurement.' :
        'Test reconnect storms, room fanout and stale presence after failover.');
  }

  if (needsRealtimeFanout ||
      (!c.staticSite && c.rps >= 600 && c.d.scale.workload === 'read_heavy')) {
    add('cache', 'Valkey', r.realtime ? 'Use region-local pub/sub for cross-replica fanout. Keep persistent events and snapshots in the database.' :
      'Cache hot read paths with bounded TTL and explicit invalidation.', ['scale.peak_concurrent_users', 'scale.workload', 'requirements.realtime'],
      'In-process memory cache', 'Independent replicas need shared fanout or cache state.', 'Pub/sub is ephemeral. Bound memory and provision failover separately.');
  }

  if (r.payments || (c.rps > 300 && c.d.scale.workload === 'write_heavy' && !c.staticSite)) {
    const existingDbQueue = c.small || c.regulated;
    const pgQueue = ['rds', 'cloudsql', 'azurepg', 'pg'].includes(db);
    const useOutbox = existingDbQueue && pgQueue;
    add('queue', useOutbox ? 'PostgreSQL transactional outbox' : 'RabbitMQ', useOutbox ?
      'Commit durable jobs and domain changes atomically. A worker claims and retries records with idempotency keys.' :
      'Buffer asynchronous work outside request handling using acknowledgements, bounded retries and dead-letter queues.',
      ['requirements.payments', 'scale.workload', 'team.size'], useOutbox ? 'RabbitMQ' : 'Database polling worker',
      useOutbox ? 'Avoid a broker in the first release when moderate throughput can share the transaction store.' :
        'A separate broker isolates higher-volume background work from database read paths.',
      'Assume at-least-once delivery and make all handlers idempotent.');
  }

  if (r.payments) {
    const india = c.residency === 'india';
    add('payments', india ? 'Razorpay hosted checkout + verified banking rail' : 'Stripe hosted Checkout', india ?
      'Use hosted collection and signed webhooks. For disbursal or regulated payment flows, confirm a licensed partner, supported rail and India-only payment data handling before processing live data.' :
      'Tokenize payment details via hosted checkout. Verify webhook signatures and reconcile settlement against local records.',
      ['requirements.payments', 'infrastructure.data_residency', 'compliance'],
      'Direct card data capture', 'Hosted collection reduces card-data exposure and audit scope.',
      'Country eligibility, merchant underwriting, fees and processor data scope require approval.');
  }

  if (c.sensitive) {
    add('other', keyManagement[h.provider],
      'Encrypt the primary store, objects and backups in the chosen boundary. Restrict decryption to scoped service identities and retain audited access events.',
      ['context.data_classification', 'infrastructure.data_residency', 'infrastructure.deployment_model'],
      'Application-managed key files', 'Key files increase the risk of accidental exposure, drift and unclear rotation ownership.',
      'Test key rotation and restore access. Key loss can make encrypted backups unrecoverable.');
  }

  if (r.ml_features !== 'none') {
    const modes = {
      inference_api: ['ONNX Runtime', 'Serve versioned CPU inference close to the application and log model versions for audit and rollback.', 'Remote inference API'],
      llm_rag: ['vLLM + PostgreSQL/pgvector', 'Run model serving and vector retrieval inside the data boundary. Propagate tenant access into retrieval filters.', 'Hosted LLM and external vector database'],
      training: [c.local ? 'PyTorch + local GPU workers' : 'PyTorch + regional GPU jobs', 'Keep training data, artifacts and GPU workers inside the boundary. Check GPU capacity and budget before scheduling.', 'External AutoML SaaS'],
    };
    const [choice, why, alternative] = modes[r.ml_features];
    add('ml', choice, why, ['requirements.ml_features', 'infrastructure.data_residency'], alternative,
      'External processing introduces a separate data boundary or contract.', 'Benchmark throughput, accuracy and accelerator needs with representative data.');
  }

  if (c.r.offline_support) {
    if (c.staticSite) {
      add('other', 'Service Worker Cache API', 'Cache versioned pages and public assets for repeat visits without connectivity.',
        ['requirements.offline_support', 'project.type'], 'SQLite sync outbox', 'There are no server mutations to replay.',
        'The first visit requires connectivity and old caches need an update policy.');
    } else {
      add('other', 'SQLite / IndexedDB sync outbox', 'Persist drafts and mutation IDs on the client. Reconcile version conflicts on reconnect and expire local secrets and cached records.',
        ['requirements.offline_support', 'project.platforms'], 'Online-only API cache', 'A cache alone cannot reliably replay user writes.',
        'Requires migration, reconciliation, device security and slow-network testing.');
    }
  }

  if (c.ha || c.regulated || c.sensitive || c.rps >= 300 || c.r.realtime) {
    add('observability', 'OpenTelemetry + Prometheus', 'Record request percentiles, saturation, errors and queue lag locally. Redact payloads before collection.',
      ['requirements.availability', 'requirements.p95_latency_ms', 'compliance'], 'External APM SaaS',
      'Self-operated telemetry keeps operational data within the selected boundary.', 'Manage log/metric cardinality, retention and actionable alerts.');
  }

  if (h.maturity === 'edge_api') {
    add('ci_cd', 'Cloudflare Wrangler', 'Apply versioned migrations and deploy the Worker with the D1 binding. Test locally before promoting changes.',
      ['budget.monthly_infra_usd', 'infrastructure.deployment_model'], 'Hosted CI runner',
      'Local deployment can use the free profile without provisioning a build server.',
      'Store deployment credentials outside the repository and record database rollback steps.');
  } else if (c.d.team.size >= 2 || c.regulated || c.air) {
    const internal = c.local || c.regulated || c.privateData || c.residency !== 'none';
    add('ci_cd', internal ? 'Forgejo Actions (private runner)' : 'GitHub Actions', internal ?
      'Build and scan signed images on an approved runner, keeping artifacts and credentials in the boundary.' :
      'Automate tests and versioned deployment builds without requiring a separate build server.',
      ['team.size', 'infrastructure.deployment_model', 'infrastructure.data_residency'],
      internal ? 'GitHub-hosted runners' : 'Private Forgejo runner', internal ?
        'A public runner is outside the selected boundary.' : 'A private server adds operations when the build boundary allows SaaS.',
      'Pin actions and lock deployment credentials to the minimum scope.');
  }
  return list;
}
