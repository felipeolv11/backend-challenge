import { Logger } from '@nestjs/common';

/**
 * Roda uma tarefa repetidamente, esperando `intervalMs` entre o FIM de uma rodada e o começo da
 * próxima (nunca duas rodadas ao mesmo tempo no mesmo processo). stop() espera a rodada atual
 * terminar: nada é cortado no meio.
 *
 * Se a tarefa devolver `true` ("tem mais trabalho", ex.: o lote veio cheio), a próxima rodada
 * começa na hora, sem esperar o intervalo.
 */
export class PeriodicWorker {
  private readonly logger: Logger;
  private loop: Promise<void> | undefined;
  private stopRequested = false;
  private wakeUp: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<boolean>,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.loop) return;
    this.stopRequested = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wakeUp?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      let hasMoreWork = false;
      try {
        hasMoreWork = await this.task();
      } catch (error) {
        // Banco fora do ar, por exemplo: registra e tenta na próxima rodada (o worker não morre).
        this.logger.warn({ event: 'worker_round_failed', worker: this.name, reason: error instanceof Error ? error.message : String(error) });
      }
      if (hasMoreWork) continue;
      await new Promise<void>((resolve) => {
        this.wakeUp = resolve;
        setTimeout(resolve, this.intervalMs);
      });
    }
  }
}
