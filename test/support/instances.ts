import type { Subprocess } from 'bun';

/** Uma instância da aplicação rodando num PROCESSO separado (bun run src/main.ts). */
export interface Instance {
  name: string;
  url: string;
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Últimas linhas de log (para diagnóstico se um teste falhar). */
  recentLogs: string[];
}

/**
 * Sobe uma instância de verdade e espera o /health/ready responder 200.
 * A saída do processo é lida o tempo todo: se ninguém lê, o buffer do sistema enche e o processo
 * filho trava esperando, o que pareceria um bug de concorrência sem ser.
 */
export async function startInstance(name: string, port: number, env: Record<string, string>): Promise<Instance> {
  const child = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const instance: Instance = { name, url: `http://localhost:${port}`, process: child, recentLogs: [] };
  void drain(child.stdout, instance);
  void drain(child.stderr, instance);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with code ${child.exitCode}:\n${instance.recentLogs.join('\n')}`);
    }
    try {
      if ((await fetch(`${instance.url}/health/ready`)).status === 200) return instance;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  throw new Error(`${name} did not become ready:\n${instance.recentLogs.join('\n')}`);
}

/**
 * Mata a instância À FORÇA (SIGKILL; no Windows, TerminateProcess): sem desligamento gracioso,
 * como uma queda de máquina. Transações abertas sofrem rollback quando o Postgres percebe a
 * conexão caída; mensagens em andamento voltam à fila depois do visibility timeout.
 */
export async function killInstance(instance: Instance): Promise<void> {
  instance.process.kill('SIGKILL');
  await instance.process.exited;
}

async function drain(stream: ReadableStream<Uint8Array>, instance: Instance): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      for (const line of decoder.decode(chunk).split('\n')) {
        if (!line.trim()) continue;
        instance.recentLogs.push(line);
        if (instance.recentLogs.length > 50) instance.recentLogs.shift();
      }
    }
  } catch {
    // processo morreu: fim da leitura
  }
}
