import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";
import { Money } from "./money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  test("accepts valid amounts and serializes with 2 decimals", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("0.50").toJSON().amount).toBe("0.50");
    expect(brl("0.00").toJSON().amount).toBe("0.00");
  });

  test("keeps the largest value that fits numeric(19,2) exactly", () => {
    const big = "99999999999999999.99";
    expect(brl(big).toJSON().amount).toBe(big);
  });

  const invalidAmounts: Array<[string, string]> = [
    ["empty string", ""],
    ["no decimals", "25"],
    ["one decimal", "25.5"],
    ["three decimals", "25.005"],
    ["no leading digit", ".50"],
    ["leading zeros", "007.00"],
    ["scientific notation", "1e3"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["negative", "-5.00"],
    ["explicit plus sign", "+5.00"],
    ["comma separator", "25,00"],
    ["surrounding space", " 25.00"],
    ["trailing newline", "25.00\n"],
    ["latin letters", "abc"],
    ["letter inside", "25.0a"],
    ["currency symbol", "R$25.00"],
    ["hexadecimal", "0x1A"],
    ["cyrillic letters", "абв"],
    ["arabic-indic digits", "١٢٣.٠٠"],
    ["full-width digits", "２５.００"],
    ["18 integer digits", "100000000000000000.00"],
  ];

  for (const [label, amount] of invalidAmounts) {
    test(`rejects amount: ${label}`, () => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });
  }

  test("rejects values that are not strings", () => {
    expect(() => Money.from({ amount: 25.5 as unknown as string, currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: null as unknown as string, currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ currency: "BRL" } as never)).toThrow(InvalidMoneyError);
    expect(() => Money.from(undefined as never)).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", "BRL ", "R$", "", "БРЛ"])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("error message does not echo the rejected input", () => {
    try {
      brl("secret-value");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
  });
});

describe("Money arithmetic", () => {
  test("adds exactly where floating point would not", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
  });

  test("subtracts exactly", () => {
    expect(brl("100.00").subtract(brl("80.00")).toJSON().amount).toBe("20.00");
  });

  test("subtract may produce a negative result", () => {
    const result = brl("10.00").subtract(brl("50.00"));
    expect(result.toJSON().amount).toBe("-40.00");
    expect(result.isNegative()).toBe(true);
  });

  test("is immutable: operations return new instances", () => {
    const original = brl("10.00");
    original.add(brl("5.00"));
    original.subtract(brl("5.00"));
    original.negate();
    expect(original.toJSON().amount).toBe("10.00");
  });

  test("does not lose precision with the largest supported values", () => {
    const sum = brl("99999999999999999.99").add(brl("0.01"));
    expect(sum.toJSON().amount).toBe("100000000000000000.00");
  });

  test("negate flips the sign and never produces negative zero", () => {
    expect(brl("5.00").negate().toJSON().amount).toBe("-5.00");
    expect(brl("5.00").negate().negate().toJSON().amount).toBe("5.00");
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
    expect(brl("5.00").subtract(brl("5.00")).toJSON().amount).toBe("0.00");
  });
});

describe("Money predicates", () => {
  test("isZero, isPositive and isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").isPositive()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
    expect(brl("0.01").isNegative()).toBe(false);
  });

  test("isLessThan and equals", () => {
    expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
    expect(brl("2.00").isLessThan(brl("2.00"))).toBe(false);
    expect(brl("2.00").equals(brl("2.00"))).toBe(true);
    expect(brl("2.00").equals(brl("2.01"))).toBe(false);
  });

  test("toString includes amount and currency", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });

  test("JSON.stringify uses toJSON", () => {
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});

describe("Money currency conflicts", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test("every binary operation throws CurrencyMismatchError", () => {
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").equals(usd)).toThrow(CurrencyMismatchError);
  });

  test("the model is multi-currency", () => {
    expect(usd.add(usd).toJSON()).toEqual({ amount: "2.00", currency: "USD" });
  });
});
