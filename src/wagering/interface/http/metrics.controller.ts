import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import {
  WAGERING_METRICS,
  type WageringMetrics,
} from "../../infrastructure/observability/wagering-metrics";

interface ContentTypeResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Exposição Prometheus. Fica aberto, como os health checks: é tráfego de infraestrutura
 * (scraper), sem dado de negócio por jogador.
 */
@Controller()
export class MetricsController {
  constructor(@Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics) {}

  @Get("metrics")
  @Header("cache-control", "no-store")
  async render(@Res({ passthrough: true }) response: ContentTypeResponse): Promise<string> {
    response.setHeader("content-type", this.metrics.contentType);
    return this.metrics.render();
  }
}
