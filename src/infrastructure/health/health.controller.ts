import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ORM } from "../../app.tokens";

interface ResponseLike {
  status(code: number): unknown;
}

@Controller("health")
export class HealthController {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: ResponseLike) {
    const postgres = await this.checkPostgres();
    const ready = postgres === "up";
    response.status(ready ? 200 : 503);
    return { status: ready ? "ready" : "unavailable", checks: { postgres } };
  }

  private async checkPostgres(): Promise<"up" | "down"> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      return "up";
    } catch {
      return "down";
    }
  }
}
