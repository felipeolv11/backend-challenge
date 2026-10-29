import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../config';

export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export async function getQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`Queue ${queueName} not found`);
  return QueueUrl;
}
