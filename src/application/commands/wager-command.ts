import { z } from "zod";
import { InvalidCommandError } from "../../domain/errors";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

const wagerCommandSchema = z.object({
  providerId: z.string().min(1).max(100),
  externalTransactionId: z.string().min(1).max(200),
  playerId: z.string().min(1).max(100),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(200),
  gameId: z.string().min(1).max(200),
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: z.object({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: z.string().min(1).max(200).optional(),
});

export type WagerCommand = z.infer<typeof wagerCommandSchema>;

export function parseWagerCommand(raw: unknown): WagerCommand {
  const parsed = wagerCommandSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw new InvalidCommandError(`invalid fields: ${fields.join(", ")}`);
  }
  return parsed.data;
}
