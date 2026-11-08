import { SQSClient } from "@aws-sdk/client-sqs";
import type { Env } from "../../config/env";

type SqsEnv = Pick<Env, "AWS_REGION" | "AWS_ENDPOINT_URL" | "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY">;

export function createSqsClient(env: SqsEnv): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 2,
  });
}
