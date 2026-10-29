import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { QUEUE_NAMES, SQS_CLIENT } from '../app.tokens';
import type { QueueNames } from '../config';
import { Metrics } from '../infrastructure/observability/metrics';
import type { HttpResponse } from './http-types';

const CHECK_TIMEOUT_MS = 2_000;

type CheckResult = { status: 'up' } | { status: 'down'; error: string };

// DECISÃO: health checks feitos à mão, sem biblioteca.
// POR QUÊ: são duas verificações simples (SELECT 1 e uma chamada leve ao SQS), cerca de 40 linhas.
// ALTERNATIVA: @nestjs/terminus — não usei porque é mais uma dependência e não tem verificação
//              pronta para SQS (eu escreveria o indicador à mão do mesmo jeito).
//
// Estes endpoints NÃO usam o AuthGuard (seção 9: health checks não exigem autenticação).
// O /metrics também fica aberto: em produção, ficaria numa porta/rede interna.
@Controller()
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_NAMES) private readonly queueNames: QueueNames,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /** Liveness: o processo está vivo e respondendo. Não olha dependências (reiniciar não as conserta). */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: pode receber tráfego? PostgreSQL e SQS precisam estar alcançáveis. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse) {
    const [database, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('SELECT 1')),
      check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueNames.wagerQueue }))),
    ]);
    const ready = database.status === 'up' && sqs.status === 'up';
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { database, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metricsText(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

/** Roda a verificação com timeout: uma dependência travada não pode travar o /health/ready. */
async function check(probe: () => Promise<unknown>): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up' };
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
