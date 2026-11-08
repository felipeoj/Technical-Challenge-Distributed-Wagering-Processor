import { describe, expect, test } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import {
  ConcurrentModificationError,
  DuplicateWalletError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidCommandError,
  InvalidMoneyError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../domain/errors";
import { toHttpError } from "./error-mapper";

describe("toHttpError", () => {
  test.each([
    [new InvalidMoneyError("x"), 400, "INVALID_MONEY"],
    [new InvalidCommandError("x"), 400, "INVALID_COMMAND"],
    [new ResourceNotFoundError("x"), 404, "NOT_FOUND"],
    [new IdempotencyConflictError("x"), 409, "IDEMPOTENCY_CONFLICT"],
    [new DuplicateWalletError("x"), 409, "WALLET_ALREADY_EXISTS"],
    [new WalletNotFoundError("x"), 422, "WALLET_NOT_FOUND"],
  ])("%p becomes %p", (error, status, code) => {
    const mapped = toHttpError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.retryAfterSeconds).toBeUndefined();
  });

  test("transient infrastructure failures are 503 with a retry hint", () => {
    for (const error of [new TransientInfrastructureError("db"), new ConcurrentModificationError("v")]) {
      const mapped = toHttpError(error);
      expect(mapped.status).toBe(503);
      expect(mapped.retryAfterSeconds).toBe(1);
      expect(mapped.body.error.code).toBe("TRANSIENT_INFRASTRUCTURE");
    }
  });

  test("framework errors keep their status", () => {
    const mapped = toHttpError(new BadRequestException("bad json"));
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("HTTP_400");
  });

  test("anything unexpected is a generic 500 that leaks nothing", () => {
    const mapped = toHttpError(new Error("password=secret"));
    expect(mapped.status).toBe(500);
    expect(JSON.stringify(mapped.body)).not.toContain("secret");
  });

  test("a domain rule error that is not part of the API contract is a 500", () => {
    expect(toHttpError(new InsufficientFundsError("x")).status).toBe(500);
  });
});
