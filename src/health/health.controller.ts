import { Controller, Get } from "@nestjs/common";

export interface LivenessResponse {
  status: "ok";
}

/**
 * Liveness: indica apenas que o processo está de pé e respondendo.
 * Não consulta dependências externas; a prontidão (PostgreSQL e SQS) fica em /health/ready.
 */
@Controller("health")
export class HealthController {
  @Get("live")
  live(): LivenessResponse {
    return { status: "ok" };
  }
}
