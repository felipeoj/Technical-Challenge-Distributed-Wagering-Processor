import { Controller, Get, Header, Inject } from "@nestjs/common";
import { PROMETHEUS } from "../../app.tokens";
import type { PrometheusMetrics } from "./prometheus-metrics";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(PROMETHEUS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
