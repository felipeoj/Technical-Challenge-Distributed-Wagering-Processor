import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { GetTransaction } from "../application/queries/get-transaction";
import type { WagerResult } from "../application/wager-result";
import { InvalidCommandError } from "../domain/errors";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";

interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

const MAX_KEY_LENGTH = 200;

function statusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    default:
      return 202;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetTransaction) private readonly getTransaction: GetTransaction,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationHeader: string | undefined,
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<WagerResult> {
    if (!idempotencyKey?.trim() || idempotencyKey.length > MAX_KEY_LENGTH) {
      throw new InvalidCommandError("missing or invalid Idempotency-Key header");
    }
    const correlationId = correlationHeader?.trim() || uuidv7();
    const result = await this.processWager.execute(body, { idempotencyKey, correlationId });
    response.setHeader("X-Correlation-Id", correlationId);
    response.status(statusFor(result));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  byId(@Param("transactionId") transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  byProviderReference(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getTransaction.byProviderReference(providerId, externalTransactionId);
  }
}
