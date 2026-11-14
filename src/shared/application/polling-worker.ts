import { type BackoffPolicy, backoffDelayMs } from "../domain/backoff";

export interface WorkerLogger {
  warn(message: string): void;
}

export interface PollingWorkerOptions {
  /** Espera entre ciclos quando o último não encontrou trabalho. */
  readonly idleDelayMs: number;
  /** Backoff entre ciclos que falharam seguidos (ex.: banco fora do ar). */
  readonly errorBackoff: BackoffPolicy;
}

/**
 * Laço de um worker em segundo plano: roda `tick` repetidamente.
 *
 * - `tick` devolve true quando há mais trabalho (lote cheio): o próximo ciclo começa na hora.
 *   Devolve false quando a fila esvaziou: o worker espera `idleDelayMs`.
 * - Uma exceção não derruba o worker: ela é logada e o próximo ciclo espera com backoff
 *   exponencial, para não martelar uma dependência fora do ar.
 * - `stop` interrompe a espera na hora e aguarda o ciclo em andamento terminar. Assim, no
 *   SIGTERM, nenhum lote fica pela metade por decisão do próprio processo.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private consecutiveFailures = 0;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly options: PollingWorkerOptions,
    private readonly logger: WorkerLogger,
    private readonly random: () => number = Math.random,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const delay = await this.cycle();
      if (this.running && delay > 0) await this.sleep(delay);
    }
  }

  /** Roda um ciclo e devolve quanto esperar antes do próximo. */
  private async cycle(): Promise<number> {
    try {
      const hasMore = await this.tick();
      this.consecutiveFailures = 0;
      return hasMore ? 0 : this.options.idleDelayMs;
    } catch (error: unknown) {
      this.consecutiveFailures += 1;
      const delay = backoffDelayMs(
        this.consecutiveFailures,
        this.options.errorBackoff,
        this.random,
      );
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.warn(
        `${this.name} cycle failed (${this.consecutiveFailures} in a row), retrying in ${delay}ms: ${reason}`,
      );
      return delay;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
