export const READINESS_CHECKS = Symbol("READINESS_CHECKS");

/** Uma dependência que precisa estar alcançável para a instância receber tráfego. */
export interface ReadinessCheck {
  readonly name: string;
  /** Resolve se a dependência responde; rejeita caso contrário. */
  check(signal: AbortSignal): Promise<void>;
}

export type CheckStatus = "up" | "down";

export interface ReadinessReport {
  readonly status: "ok" | "unavailable";
  readonly checks: Readonly<Record<string, CheckStatus>>;
}

/** Tempo máximo de cada verificação: um health check que trava é tão ruim quanto um que falha. */
export const READINESS_TIMEOUT_MS = 2_000;

/** Roda as verificações em paralelo, cada uma com timeout. Qualquer falha deixa a instância "unavailable". */
export async function evaluateReadiness(
  checks: readonly ReadinessCheck[],
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const results = await Promise.all(
    checks.map(async (check): Promise<[string, CheckStatus]> => {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        await Promise.race([
          check.check(signal),
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
          ),
        ]);
        return [check.name, "up"];
      } catch {
        return [check.name, "down"];
      }
    }),
  );
  const report = Object.fromEntries(results);
  const healthy = results.every(([, status]) => status === "up");
  return { status: healthy ? "ok" : "unavailable", checks: report };
}
