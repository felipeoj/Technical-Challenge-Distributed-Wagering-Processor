import { Controller, Get, Header, Inject } from "@nestjs/common";
import { METRICS } from "../../app.tokens";
import type { OpenTelemetryMetrics } from "./otel-metrics";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: OpenTelemetryMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  async scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
