import { EC2Client, DescribeInstanceStatusCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import * as https from 'https';
import * as http from 'http';

const ec2 = new EC2Client({ region: process.env.AWS_REGION });

class HealthCheckFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthCheckFailed';
  }
}

async function getInstancePublicIp(instanceId: string): Promise<string> {
  const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const ip = result.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
  if (!ip) throw new HealthCheckFailed(`No public IP yet for ${instanceId}`);
  return ip;
}

function httpCheck(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
      if (res.statusCode && res.statusCode < 500) resolve();
      else reject(new HealthCheckFailed(`HTTP ${res.statusCode} from ${url}`));
    });
    req.on('error', (e) => reject(new HealthCheckFailed(`Connection failed to ${url}: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new HealthCheckFailed(`Timeout connecting to ${url}`)); });
  });
}

// Verifies Unifi redirects to the login page, not the setup wizard
function checkNotSetupWizard(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
      const location = res.headers.location ?? '';
      if (location.includes('/manage/account/login')) {
        resolve();
      } else if (location.includes('/setup') || location.includes('/wizard')) {
        reject(new HealthCheckFailed(`Unifi is in setup wizard state (redirect: ${location}) — restore may not have applied`));
      } else {
        resolve();
      }
    });
    req.on('error', (e) => reject(new HealthCheckFailed(`Connection failed to ${url}: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new HealthCheckFailed(`Timeout connecting to ${url}`)); });
  });
}

// Checks EC2 system/instance status (2/2) and Unifi ports
export async function checkHealth(event: { instanceId: string }): Promise<{ healthy: boolean }> {
  const { instanceId } = event;

  const statusResult = await ec2.send(new DescribeInstanceStatusCommand({
    InstanceIds: [instanceId],
    IncludeAllInstances: true,
  }));

  const status = statusResult.InstanceStatuses?.[0];
  const systemOk = status?.SystemStatus?.Status === 'ok';
  const instanceOk = status?.InstanceStatus?.Status === 'ok';

  if (!systemOk || !instanceOk) {
    throw new HealthCheckFailed(
      `EC2 status not ready: system=${status?.SystemStatus?.Status}, instance=${status?.InstanceStatus?.Status}`
    );
  }

  const publicIp = await getInstancePublicIp(instanceId);

  await httpCheck(`http://${publicIp}:8080/inform`);
  await httpCheck(`https://${publicIp}:8443`);
  await checkNotSetupWizard(`https://${publicIp}:8443`);

  return { healthy: true };
}
