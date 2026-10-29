import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadQueueNames, loadSqsConfig, type QueueNames } from '../../config';
import { createSqsClient } from './sqs-client';

// DECISÃO: as filas são criadas por um script de setup (bun run sqs:setup), que também roda
//          como serviço de uma execução só no docker-compose.
// POR QUÊ: criar fila é infraestrutura, separada da aplicação, como seria em produção (Terraform).
//          CreateQueue é idempotente: rodar de novo não duplica nada. Os testes usam a mesma função.
// ALTERNATIVA: a aplicação criar as filas ao subir — não usei porque, em produção, a aplicação
//              normalmente não tem permissão para criar infraestrutura.

export interface QueueSettings {
  /** Tempo que uma mensagem recebida fica invisível para os outros consumidores. */
  visibilityTimeoutSeconds: number;
  /**
   * Recebimentos até o SQS mover sozinho para a DLQ. É a REDE DE SEGURANÇA: o consumidor manda
   * para a DLQ antes (na tentativa 5). Isto cobre o caso do processo morrer em loop numa mensagem.
   */
  maxReceiveCount: number;
}

export const defaultQueueSettings: QueueSettings = { visibilityTimeoutSeconds: 30, maxReceiveCount: 6 };

export interface QueueUrls {
  wagerQueueUrl: string;
  wagerDeadLetterQueueUrl: string;
  eventsQueueUrl: string;
}

export async function setupQueues(client: SQSClient, names: QueueNames, settings = defaultQueueSettings): Promise<QueueUrls> {
  const fifo = { FifoQueue: 'true' };

  const { QueueUrl: wagerDeadLetterQueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: names.wagerDeadLetterQueue, Attributes: fifo }),
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: wagerDeadLetterQueueUrl, AttributeNames: ['QueueArn'] }),
  );

  const { QueueUrl: wagerQueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: names.wagerQueue,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(settings.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: settings.maxReceiveCount }),
      },
    }),
  );

  // Fila onde o publisher da outbox publica os eventos de integração.
  const { QueueUrl: eventsQueueUrl } = await client.send(new CreateQueueCommand({ QueueName: names.eventsQueue, Attributes: fifo }));

  return { wagerQueueUrl: wagerQueueUrl!, wagerDeadLetterQueueUrl: wagerDeadLetterQueueUrl!, eventsQueueUrl: eventsQueueUrl! };
}

// Executado direto (bun run sqs:setup): cria as filas com os nomes da configuração.
if (import.meta.main) {
  const client = createSqsClient(loadSqsConfig());
  const urls = await setupQueues(client, loadQueueNames());
  console.log('SQS queues ready:', urls);
  client.destroy();
}
