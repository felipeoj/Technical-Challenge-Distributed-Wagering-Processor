import { describe, expect, test } from "bun:test";
import { TransientInfrastructureError } from "../../domain/errors";
import { translateDatabaseError } from "./error-translator";

const withCode = (code: string) => Object.assign(new Error("db"), { code });

describe("translateDatabaseError", () => {
  test.each(["55P03", "40001", "40P01", "08006", "08001", "ECONNREFUSED"])("%s is transient", (code) => {
    expect(translateDatabaseError(withCode(code))).toBeInstanceOf(TransientInfrastructureError);
  });

  test("08P01 (invalid message format, e.g. a null byte) is not transient: retrying can never help", () => {
    const error = withCode("08P01");
    expect(translateDatabaseError(error)).toBe(error);
  });
});
