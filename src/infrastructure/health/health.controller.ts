import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ENV, ORM, SQS } from "../../app.tokens";
import type { Env } from "../../config/env";

interface ResponseLike {
  status(code: number): unknown;
}

type State = "up" | "down";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: ResponseLike) {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const ready = postgres === "up" && sqs === "up";
    response.status(ready ? 200 : 503);
    return { status: ready ? "ready" : "unavailable", checks: { postgres, sqs } };
  }

  private async checkPostgres(): Promise<State> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkSqs(): Promise<State> {
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: this.env.SQS_EVENTS_QUEUE_URL, AttributeNames: ["QueueArn"] }),
      );
      return "up";
    } catch {
      return "down";
    }
  }
}
