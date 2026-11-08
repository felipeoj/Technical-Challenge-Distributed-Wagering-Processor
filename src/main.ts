import "reflect-metadata";
import { createApp } from "./create-app";
import { loadEnv } from "./config/env";
import { startWorkers } from "./workers";

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp();
  await app.listen(env.PORT);
  startWorkers(app);
}

bootstrap();
