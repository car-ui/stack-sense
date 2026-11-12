const sources = {
  aws: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html',
  gcp: 'https://docs.cloud.google.com/sql/docs/postgres/high-availability',
  azure: 'https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-business-continuity',
  pg: 'https://www.postgresql.org/docs/current/continuous-archiving.html',
  regional: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PostgreSQL.Replication.ReadReplicas.Configuration.html',
  strategies: 'https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html',
};

const managedPostgres = ['rds', 'cloudsql', 'azurepg'];
const standbyRegion = {
  india: 'ap-south-2 (Hyderabad)',
  eu: 'eu-west-1 (Ireland)',
  us: 'us-east-2 (Ohio)',
  none: 'us-east-2 (Ohio)',
};

export const recoveryReferences = {
  'AWS recovery strategy trade-offs': sources.strategies,
  'Amazon RDS Multi-AZ failover': sources.aws,
  'RDS PostgreSQL replica behavior': sources.regional,
  'Cloud SQL zonal failover': sources.gcp,
  'Azure PostgreSQL business continuity': sources.azure,
  'PostgreSQL continuous archiving': sources.pg,
  'AWS RDS cross-region replica availability': 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RDS_Fea_Regions_DB-eng.Feature.CrossRegionReadReplicas.html',
  'AWS Fargate supported regions': 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate-Regions.html',
};

export function recoveryRequest(input) {
  const { recovery_point_minutes: rpo, recovery_time_minutes: rto, recovery_scope: scope } = input.context;
  const regional = scope === 'region_outage';
  const active = regional || rpo !== null || rto !== null;
  const zonalStandby = !regional && ((rpo !== null && rpo < 15) || (rto !== null && rto <= 60));
  return { rpo, rto, scope, active, regional, zonalStandby };
}

export function recoveryExclusion(c, h, database) {
  const req = c.recovery;
  if (!req.active) return null;
  if (c.staticSite && !req.regional) return req.rto !== null && req.rto < 5
    ? 'The static rollback profile does not model recovery in under five minutes.' : null;
  if (req.regional) {
    if (h.id !== 'fargate' || database !== 'rds' || !standbyRegion[c.residency]) {
      return 'The catalogued regional standby requires ECS and RDS PostgreSQL in a verified same-geography region pair.';
    }
    if (c.d.infrastructure.existing_systems.length || c.r.auth !== 'none' || c.r.realtime || c.r.payments ||
        c.r.file_media_storage || c.r.ml_features !== 'none' || c.r.offline_support ||
        (c.r.full_text_search && c.searchGb >= 500) || c.rps >= 600) {
      return 'The regional standby models the HTTP service and database, and cannot cover the required additional state or dependencies.';
    }
    return null;
  }
  if (req.zonalStandby && !managedPostgres.includes(database)) {
    return 'The requested recovery window needs a catalogued managed PostgreSQL zonal standby.';
  }
  if (!req.zonalStandby && ![...managedPostgres, 'pg'].includes(database)) {
    return 'This profile has no catalogued point-in-time restore plan for the requested recovery objectives.';
  }
  if (req.rpo === 0 && (c.r.file_media_storage || c.r.offline_support || c.r.realtime || c.r.ml_features !== 'none' || c.r.payments ||
      c.r.auth === 'social' || c.r.auth === 'phone_otp' || c.d.infrastructure.existing_systems.length)) {
    return 'A synchronous database standby alone cannot cover the requested zero-loss goal across the other stateful dependencies.';
  }
  return null;
}

export function recoveryPlan(c, h, db) {
  const req = c.recovery;
  if (!req.active) return null;
  const regional = req.regional;
  const strategy = c.staticSite ? 'versioned_asset_rollback' : regional ? 'regional_warm_standby' :
    req.zonalStandby ? 'synchronous_zonal_standby' : 'point_in_time_restore';
  const steps = {
    versioned_asset_rollback: [
      'Keep generated assets, deployment manifests and source revisions versioned. Verify that the previous release can be published without rebuilding.',
      'Time a rollback from detection to a successful page check. The profile has no mutable application database.',
    ],
    regional_warm_standby: [
      'Predeploy the HTTP service and an encrypted asynchronous RDS PostgreSQL replica in the listed recovery region. Keep artifacts, backups, keys and secrets in approved regions.',
      'Measure replica lag and validate standby capacity. Fence writes at the old primary before promoting the replica, switching traffic and reconciling missing writes.',
    ],
    synchronous_zonal_standby: [
      'Provision synchronous managed PostgreSQL HA across zones and redundant application ingress and replicas in the same region. Keep point-in-time backups for logical data loss.',
      'Time a database failover from the client. Test reconnects, retry-safe writes, recovery of supporting services and the last acknowledged transaction.',
    ],
    point_in_time_restore: [
      db === 'pg' ? 'Take encrypted base backups and continuously archive PostgreSQL WAL in a separate fault domain inside the approved boundary.' :
        'Enable automated backups and point-in-time recovery in the approved region. Check the newest restorable timestamp against the recovery point target.',
      'Restore to a separate instance, verify data integrity, switch application connections and measure elapsed service downtime.',
    ],
  }[strategy];
  return {
    scope: req.scope, strategy,
    targets_minutes: { max_data_loss: req.rpo, max_service_downtime: req.rto },
    secondary_region: regional ? standbyRegion[c.residency] : null,
    verification: 'pending_restore_drill',
    runbook: steps,
    references: [sources.strategies, ...(regional ? [sources.regional] :
      c.staticSite ? [] : [db === 'pg' ? sources.pg : sources[h.provider]])],
  };
}
