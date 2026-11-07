import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

// Own Decimal constructor so the precision never depends on global settings.
// 40 significant digits is far above numeric(19,2), so sums are never rounded silently.
const MoneyDecimal = Decimal.clone({ precision: 40 });

// Strict contract: digits 0-9 only (not \d), no leading zeros, exactly 2 decimals,
// at most 17 integer digits to fit numeric(19,2). No sign: negatives are not valid input.
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,16})\.[0-9]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Immutable value object. Java equivalent: a final class wrapping BigDecimal.
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  // The only door for external data (API, queue, database), so it is strict.
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== "string" || typeof props?.currency !== "string") {
      throw new InvalidMoneyError("amount and currency must be strings");
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError("amount must be a decimal string with exactly 2 decimals, e.g. 25.00");
    }
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError("currency must be 3 uppercase letters (ISO-4217)");
    }
    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  // Results of arithmetic may be negative (a difference, a signed ledger sum),
  // so they skip `from`. Negative zero is normalized to plain zero.
  private static ofDecimal(value: Decimal, currency: string): Money {
    return new Money(value.isZero() ? new MoneyDecimal(0) : value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.ofDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError("operation between different currencies");
    }
  }
}
