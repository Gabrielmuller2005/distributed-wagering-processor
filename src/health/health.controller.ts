import { Controller, Get, Inject, Res } from "@nestjs/common";
import {
  evaluateReadiness,
  READINESS_CHECKS,
  type ReadinessCheck,
  type ReadinessReport,
} from "./readiness";

export interface LivenessResponse {
  status: "ok";
}

interface StatusResponse {
  status(code: number): unknown;
}

/** Health checks: sem autenticação, como pede o enunciado. */
@Controller("health")
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: readonly ReadinessCheck[]) {}

  /** Liveness: o processo está de pé e respondendo. Não consulta dependências externas. */
  @Get("live")
  live(): LivenessResponse {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 200 se todos estão de pé; 503 se algum caiu. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<ReadinessReport> {
    const report = await evaluateReadiness(this.checks);
    response.status(report.status === "ok" ? 200 : 503);
    return report;
  }
}
