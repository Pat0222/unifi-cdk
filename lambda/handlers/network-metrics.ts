import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import * as https from 'https';

const secretsManager = new SecretsManagerClient({ region: process.env.AWS_REGION });
const cw = new CloudWatchClient({ region: process.env.AWS_REGION });

function unifiGet(apiKey: string, host: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: host, path, headers: { 'X-API-KEY': apiKey } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Parse error from ${path}: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
  });
}

// Triggered hourly — publishes per-site ConnectedClients and WAN throughput metrics
export async function publishNetworkMetrics(event: Record<string, unknown>): Promise<void> {
  const apiKeySecretArn = process.env.API_KEY_SECRET_ARN!;
  const controllerHost = process.env.CONTROLLER_DOMAIN!;

  let apiKey: string;
  try {
    const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: apiKeySecretArn }));
    apiKey = secret.SecretString!;
  } catch (err) {
    console.error('Failed to retrieve API key — skipping metrics publish:', err);
    return;
  }

  let sites: Array<{ name: string; desc: string }>;
  try {
    const sitesResult = await unifiGet(apiKey, controllerHost, '/api/self/sites');
    sites = sitesResult.data ?? [];
  } catch (err) {
    console.error('Failed to fetch sites — controller may be mid-rotation:', err);
    return;
  }

  const metricData: MetricDatum[] = [];
  let totalClients = 0;

  for (const site of sites) {
    const siteDimension = [{ Name: 'Site', Value: site.desc || site.name }];

    try {
      const staResult = await unifiGet(apiKey, controllerHost, `/api/s/${site.name}/stat/sta`);
      const clientCount: number = (staResult.data ?? []).length;
      totalClients += clientCount;
      metricData.push({ MetricName: 'ConnectedClients', Dimensions: siteDimension, Value: clientCount, Unit: 'Count' });
    } catch (err) {
      console.error(`Failed to fetch clients for site ${site.name}:`, err);
    }

    try {
      const healthResult = await unifiGet(apiKey, controllerHost, `/api/s/${site.name}/stat/health`);
      const wan = (healthResult.data ?? []).find((h: any) => h.subsystem === 'wan');
      if (wan) {
        metricData.push(
          { MetricName: 'WanRxBytesPerSec', Dimensions: siteDimension, Value: wan['rx_bytes-r'] ?? 0, Unit: 'Bytes/Second' },
          { MetricName: 'WanTxBytesPerSec', Dimensions: siteDimension, Value: wan['tx_bytes-r'] ?? 0, Unit: 'Bytes/Second' },
        );
      }
    } catch (err) {
      console.error(`Failed to fetch WAN health for site ${site.name}:`, err);
    }
  }

  // Aggregate client count under the shared Service=unifi dimension for the dashboard
  metricData.push({
    MetricName: 'TotalConnectedClients',
    Dimensions: [{ Name: 'Service', Value: 'unifi' }],
    Value: totalClients,
    Unit: 'Count',
  });

  if (metricData.length > 0) {
    await cw.send(new PutMetricDataCommand({ Namespace: 'UnifiController', MetricData: metricData }));
    console.log(`Published ${metricData.length} metrics across ${sites.length} sites (${totalClients} total clients)`);
  }
}
