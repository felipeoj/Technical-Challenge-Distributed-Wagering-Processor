import "reflect-metadata";
import { createApp } from "./create-app";
import { loadEnv } from "./config/env";

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp();
  await app.listen(env.PORT);
}

bootstrap();
