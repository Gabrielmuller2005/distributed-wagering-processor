import type { FaultInjector, FaultPoint } from "../application/fault-injection";

/**
 * Mata o processo com SIGKILL ao passar pelo ponto configurado: sem encerramento gracioso, sem
 * terminar nada em andamento, como uma queda de máquina ou um OOM kill. Só existe para os testes
 * de resiliência e só é ligado por `FAULT_INJECTION` explícito (recusado em produção).
 */
export class CrashFaultInjector implements FaultInjector {
  constructor(private readonly point: FaultPoint) {}

  reached(point: FaultPoint): void {
    if (point !== this.point) return;
    process.stderr.write(`fault injection: killing process at ${point}\n`);
    process.kill(process.pid, "SIGKILL");
  }
}
