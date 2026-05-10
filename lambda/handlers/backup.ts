import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const cw = new CloudWatchClient({ region: process.env.AWS_REGION });

const BACKUP_MAX_AGE_HOURS = 25;

// Triggered hourly — publishes BackupFreshness metric (1 = fresh, 0 = stale).
// Errors during S3 check publish 0 so the alarm fires on Lambda failures too.
export async function checkBackupFreshness(event: Record<string, unknown>): Promise<void> {
  const backupBucket = process.env.BACKUP_BUCKET!;

  let freshness = 0;
  try {
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: backupBucket,
      Prefix: 'backups/',
    }));

    const backups = (listResult.Contents ?? [])
      .filter((obj): obj is typeof obj & { Key: string } => obj.Key?.endsWith('.unf') ?? false)
      .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

    if (backups.length > 0) {
      const ageHours = (Date.now() - (backups[0].LastModified?.getTime() ?? 0)) / (1000 * 60 * 60);
      freshness = ageHours < BACKUP_MAX_AGE_HOURS ? 1 : 0;
      console.log(`Newest backup: ${backups[0].Key}, age: ${ageHours.toFixed(1)}h, fresh: ${freshness}`);
    } else {
      console.log('No backups found in S3');
    }
  } catch (err) {
    console.error('Error checking backup freshness — publishing stale metric:', err);
  }

  await cw.send(new PutMetricDataCommand({
    Namespace: 'UnifiController',
    MetricData: [{
      MetricName: 'BackupFreshness',
      Dimensions: [{ Name: 'Service', Value: 'unifi' }],
      Value: freshness,
      Unit: 'None',
    }],
  }));
}
