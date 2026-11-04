import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rolesanywhere from 'aws-cdk-lib/aws-rolesanywhere';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface LogArchiveDeps {
  instanceRole: iam.Role;
  retentionDays: number;
  bytesScannedLimitGb: number;
}

export interface LogArchiveResources {
  logBucket: s3.Bucket;
  shipperRole: iam.Role;
  trustAnchor: rolesanywhere.CfnTrustAnchor;
  shipperProfile: rolesanywhere.CfnProfile;
  workgroup: athena.CfnWorkGroup;
}

const DATABASE = 'unifi_logs';
const TABLE = 'logs';
const VIEW = 'log_events';
const LOG_PREFIX = 'unifi/';
const RESULTS_PREFIX = 'athena-results/';
const ATHENA_DIR = path.join(__dirname, '../athena');

// Public certificate of the CA created by scripts/pki.sh init. Its private
// key stays on the operator's machine, never in the repo.
const SHIPPER_CA_PEM = path.join(__dirname, '../pki/unifi-log-shipper-ca.pem');
// Must match CLIENT_CN in scripts/pki.sh.
const SHIPPER_CERT_CN = 'unifi-log-shipper';

// Columns in each JSON line. `source` is a partition, so it isn't listed here.
const LOG_COLUMNS = ['timestamp', 'host', 'hostname', 'program', 'severity', 'message', 'raw'];

// View columns and types. These must match the CASTs in log-events-view.sql,
// or Athena reports the view as stale.
const VIEW_COLUMNS: Array<[string, string, string]> = [
  // [name, Presto type, Glue type]
  ['event_time', 'timestamp(3)', 'timestamp'],
  ['source', 'varchar', 'string'],
  ['host', 'varchar', 'string'],
  ['hostname', 'varchar', 'string'],
  ['program', 'varchar', 'string'],
  ['severity', 'varchar', 'string'],
  ['message', 'varchar', 'string'],
  ['log_date', 'varchar', 'string'],
  ['device', 'varchar', 'string'],
  ['is_gateway', 'boolean', 'boolean'],
  ['event_type', 'varchar', 'string'],
];

export function createLogArchive(scope: Construct, deps: LogArchiveDeps): LogArchiveResources {
  const stack = cdk.Stack.of(scope);
  const { instanceRole, retentionDays, bytesScannedLimitGb } = deps;

  // ── Storage ────────────────────────────────────────────────────────────────
  // Everything stays in S3 Standard: at this volume, IA/Glacier minimum object
  // sizes and transition fees would cost more than they save.
  const logBucket = new s3.Bucket(scope, 'UnifiLogs', {
    bucketName: `unifi-logs-${stack.account}`,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [
      {
        id: 'expire-logs',
        prefix: LOG_PREFIX,
        expiration: cdk.Duration.days(retentionDays),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      },
      {
        id: 'expire-athena-results',
        prefix: RESULTS_PREFIX,
        expiration: cdk.Duration.days(30),
      },
    ],
  });

  // ── Write access ───────────────────────────────────────────────────────────
  // Fluent Bit uploads with PutObject only (use_put_object on), so writers
  // need nothing else, and each can only write its own prefix.
  instanceRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject'],
    resources: [logBucket.arnForObjects(`${LOG_PREFIX}controller/*`)],
  }));

  // The Home Assistant add-on gets temporary credentials through IAM Roles
  // Anywhere: it signs with a certificate from our own CA, so no long-lived
  // AWS key exists anywhere.
  const trustAnchor = new rolesanywhere.CfnTrustAnchor(scope, 'LogShipperTrustAnchor', {
    name: 'unifi-log-shipper',
    enabled: true,
    source: {
      sourceType: 'CERTIFICATE_BUNDLE',
      sourceData: { x509CertificateData: fs.readFileSync(SHIPPER_CA_PEM, 'utf8') },
    },
  });

  const shipperRole = new iam.Role(scope, 'LogShipperRole', {
    roleName: 'unifi-log-shipper',
    description: 'Assumed by the Home Assistant log shipper through IAM Roles Anywhere',
    maxSessionDuration: cdk.Duration.hours(1),
    assumedBy: new iam.ServicePrincipal('rolesanywhere.amazonaws.com'),
  });
  // Only sessions from our trust anchor, for a certificate with our CN.
  (shipperRole.node.defaultChild as iam.CfnRole).assumeRolePolicyDocument = {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'rolesanywhere.amazonaws.com' },
      Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
      Condition: {
        ArnEquals: { 'aws:SourceArn': trustAnchor.attrTrustAnchorArn },
        StringEquals: { 'aws:PrincipalTag/x509Subject/CN': SHIPPER_CERT_CN },
      },
    }],
  };
  shipperRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject'],
    resources: [logBucket.arnForObjects(`${LOG_PREFIX}devices/*`)],
  }));

  const shipperProfile = new rolesanywhere.CfnProfile(scope, 'LogShipperProfile', {
    name: 'unifi-log-shipper',
    enabled: true,
    roleArns: [shipperRole.roleArn],
    durationSeconds: 3600,
  });

  // ── Glue table (partition projection, no crawler) ──────────────────────────
  const database = new glue.CfnDatabase(scope, 'LogDatabase', {
    catalogId: stack.account,
    databaseInput: {
      name: DATABASE,
      description: 'UniFi controller and device logs archived in S3',
    },
  });

  const logLocation = `s3://${logBucket.bucketName}/${LOG_PREFIX}`;
  const table = new glue.CfnTable(scope, 'LogTable', {
    catalogId: stack.account,
    databaseName: DATABASE,
    tableInput: {
      name: TABLE,
      description: 'Gzipped JSON lines written by Fluent Bit',
      tableType: 'EXTERNAL_TABLE',
      parameters: {
        classification: 'json',
        'compressionType': 'gzip',
        'projection.enabled': 'true',
        'projection.source.type': 'enum',
        'projection.source.values': 'controller,devices',
        'projection.year.type': 'integer',
        'projection.year.range': '2026,2050',
        'projection.month.type': 'integer',
        'projection.month.range': '1,12',
        'projection.month.digits': '2',
        'projection.day.type': 'integer',
        'projection.day.range': '1,31',
        'projection.day.digits': '2',
        'storage.location.template': `${logLocation}\${source}/year=\${year}/month=\${month}/day=\${day}/`,
      },
      partitionKeys: [
        { name: 'source', type: 'string' },
        { name: 'year', type: 'string' },
        { name: 'month', type: 'string' },
        { name: 'day', type: 'string' },
      ],
      storageDescriptor: {
        location: logLocation,
        inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
        outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
        serdeInfo: {
          serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          parameters: { 'ignore.malformed.json': 'true' },
        },
        columns: LOG_COLUMNS.map((name) => ({ name, type: 'string' })),
      },
    },
  });
  table.node.addDependency(database);

  // ── View holding the match patterns ────────────────────────────────────────
  const viewSql = fs.readFileSync(path.join(ATHENA_DIR, 'log-events-view.sql'), 'utf8').trim();
  const prestoView = {
    originalSql: viewSql,
    catalog: 'awsdatacatalog',
    schema: DATABASE,
    columns: VIEW_COLUMNS.map(([name, type]) => ({ name, type })),
  };
  const view = new glue.CfnTable(scope, 'LogEventsView', {
    catalogId: stack.account,
    databaseName: DATABASE,
    tableInput: {
      name: VIEW,
      description: 'Log lines tagged with event types. Patterns live in lib/athena/log-events-view.sql',
      tableType: 'VIRTUAL_VIEW',
      parameters: { presto_view: 'true', comment: 'Presto View' },
      viewOriginalText: `/* Presto View: ${Buffer.from(JSON.stringify(prestoView)).toString('base64')} */`,
      viewExpandedText: '/* Presto View */',
      storageDescriptor: {
        columns: VIEW_COLUMNS.map(([name, , type]) => ({ name, type })),
        serdeInfo: {},
      },
    },
  });
  view.node.addDependency(table);

  // ── Athena workgroup ───────────────────────────────────────────────────────
  const workgroup = new athena.CfnWorkGroup(scope, 'LogWorkgroup', {
    name: 'unifi-logs',
    description: 'Saved queries over the UniFi log archive',
    recursiveDeleteOption: true,
    workGroupConfiguration: {
      enforceWorkGroupConfiguration: true,
      publishCloudWatchMetricsEnabled: false,
      bytesScannedCutoffPerQuery: Math.round(bytesScannedLimitGb * 1024 ** 3),
      engineVersion: { selectedEngineVersion: 'AUTO' },
      resultConfiguration: {
        outputLocation: `s3://${logBucket.bucketName}/${RESULTS_PREFIX}`,
        encryptionConfiguration: { encryptionOption: 'SSE_S3' },
      },
    },
  });

  // ── Saved queries ──────────────────────────────────────────────────────────
  const savedQueries = [
    {
      id: 'RecreateView',
      name: '00 Recreate log_events view',
      description: 'Run after editing the match patterns in Athena, or if Athena says the view is stale.',
      sql: `CREATE OR REPLACE VIEW ${DATABASE}.${VIEW} AS\n${viewSql}`,
    },
    ...fs.readdirSync(path.join(ATHENA_DIR, 'queries'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((file) => {
        const sql = fs.readFileSync(path.join(ATHENA_DIR, 'queries', file), 'utf8');
        const header = (key: string) => sql.match(new RegExp(`^-- ${key}: (.+)$`, 'm'))?.[1].trim();
        const name = header('name');
        if (!name) throw new Error(`${file} needs a "-- name:" header line`);
        return { id: `Query${file.slice(0, 2)}`, name, description: header('description') ?? '', sql };
      }),
  ];

  for (const q of savedQueries) {
    const named = new athena.CfnNamedQuery(scope, `LogQuery${q.id}`, {
      name: q.name,
      description: q.description.slice(0, 1024),
      database: DATABASE,
      workGroup: workgroup.name,
      queryString: q.sql,
    });
    named.node.addDependency(workgroup);
    named.node.addDependency(view);
  }

  return { logBucket, shipperRole, trustAnchor, shipperProfile, workgroup };
}
