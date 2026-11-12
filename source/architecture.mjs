const styleGuide = 'https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles';
const workerGuide = 'https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/web-queue-worker';
const hybridGuide = 'https://learn.microsoft.com/en-us/azure/app-service/app-service-hybrid-connections';

export const architectureReferences = {
  'Microsoft architecture style trade-offs': styleGuide,
  'Web-Queue-Worker responsibilities': workerGuide,
};

function decision(style, justification, drivenBy, alternative, whyNot, flow, tradeoff, source = styleGuide) {
  return {
    style, justification, driven_by: drivenBy, data_flow: flow,
    alternatives: [{ choice: alternative, why_not: whyNot }],
    tradeoffs: [tradeoff], source,
  };
}

export function chooseArchitecture(c, host) {
  const { r, d } = c;
  if (c.staticSite) {
    return decision('static',
      'Build public pages ahead of time. The content and read-heavy workload can be served as immutable files without an application process.',
      ['project.type', 'scale.workload', 'requirements.auth'],
      'Server-rendered application', 'An always-on application and data store would add operations without a runtime write path.',
      ['Build published content and version the output.', 'Serve the release from the selected static ingress.', 'Read public assets directly in the browser.'],
      'Content changes require a new build and release.');
  }
  if (host.db[0]?.item.id === 'legacySql' && host.model === 'managed_cloud') {
    return decision('hybrid',
      'Use managed application compute and retain the existing database for the first release. This avoids a database migration while the team delivers the application.',
      ['infrastructure.existing_systems', 'infrastructure.deployment_model', 'team.size', 'timeline.mvp_weeks'],
      'Cloud-only application and migrated database', 'Schema compatibility, data migration and cutover add work before launch.',
      ['Authenticate staff at application ingress.', 'Open a TLS-protected private path from the app to the existing SQL Server.', 'Keep the existing database authoritative and verify its backup placement.'],
      'The private link and local database become dependencies in the end-to-end availability budget.', hybridGuide);
  }
  if (r.realtime && c.peak >= 1000) {
    const sharedState = d.project.type === 'realtime_collab';
    return decision('service_oriented',
      'Separate the long-lived connection path from the request-response API so the two can scale and roll out independently at ' +
        c.peak + ' peak concurrent users.',
      ['requirements.realtime', 'scale.peak_concurrent_users'],
      'Single application process', 'Persistent connections would share resource and rollout limits with the API.',
      ['Route HTTP requests and authenticated socket upgrades to separate application services.',
        sharedState ? 'Persist binary Yjs state in the database and distribute updates and presence through regional fanout.' :
          'Persist durable messages in the database and use regional fanout for cross-replica delivery.',
        'Reconnect clients after a rollout and verify recovery under peak connection load.'],
      'Independent gateway scaling adds a deployment and coordination path. Benchmark hot rooms because shared fanout can duplicate work.', workerGuide);
  }
  if (host.id === 'run' || host.maturity === 'edge_api') {
    const free = host.maturity === 'edge_api';
    return decision('serverless', free ?
      'Run a small public API on demand within the checked request and storage envelope.' :
      'Run the stateless HTTP application on managed request-driven compute, keeping persistent state in the regional data store.',
      free ? ['budget.monthly_infra_usd', 'context.peak_day_requests', 'scale.data_volume_gb_12_months'] :
        ['infrastructure.deployment_model', 'scale.traffic_pattern', 'team.has_devops'],
      'Always-on application service', 'An always-running service adds a capacity baseline and operating work for this request-driven workload.',
      [r.offline_support ? 'Record offline writes in a durable client outbox.' : 'Send client requests to managed HTTP ingress.',
        r.offline_support ? 'Replay batches into the stateless API using operation IDs.' : 'Run the API on demand and keep process state disposable.',
        'Persist accepted changes in the selected data store.'],
      free ? 'Plan quotas limit request and database capacity.' : 'Set concurrency and minimum instance counts from measured startup and latency.');
  }
  const compact = c.small && !c.regulated && !r.multi_tenant && !c.sensitive;
  return decision(compact ? 'monolith' : 'modular_monolith',
    compact ? 'Keep a single application deployment and primary database. The current team and workload can share one release and transaction boundary.' :
      'Keep one application deployment with explicit domain and access boundaries. Shared transactions and a single release reduce coordination costs.',
    compact ? ['team.size', 'scale.workload', 'timeline.mvp_weeks'] :
      ['team.size', ...(r.multi_tenant ? ['requirements.multi_tenant'] : []),
        ...(c.regulated ? ['compliance'] : []), ...(c.sensitive ? ['context.data_classification'] : []),
        'scale.workload'],
    'Independently deployed business services',
    'Separate business services would add network calls, deployment coordination and distributed data consistency work.',
    ['Route client requests through the application ingress.',
      r.multi_tenant ? 'Authorize tenant context before each request reaches tenant-scoped data.' :
        r.auth !== 'none' ? 'Enforce identity and authorization in the application.' : 'Validate input at the API boundary.',
      r.payments ? 'Commit transaction records in the primary database and dispatch external payment work asynchronously.' :
        'Keep durable state in the primary database.'],
    'Domain boundaries need tests and explicit ownership as the application grows.');
}
