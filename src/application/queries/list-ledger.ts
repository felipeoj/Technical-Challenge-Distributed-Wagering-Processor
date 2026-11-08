import { InvalidCommandError, ResourceNotFoundError } from "../../domain/errors";
import type { MoneyProps } from "../../domain/money";
import { assertUuid } from "../commands/ids";
import { decodeCursor, encodeCursor } from "../ledger-cursor";
import type { UnitOfWork } from "../unit-of-work";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface LedgerItemView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerItemView[];
  nextCursor: string | null;
}

export class ListLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, cursor?: string, limit?: string): Promise<LedgerPageView> {
    assertUuid(walletId, "walletId");
    const pageSize = parseLimit(limit);
    const afterSeq = cursor ? decodeCursor(cursor) : undefined;

    return this.uow.run(async (repositories) => {
      if (!(await repositories.wallets.findById(walletId))) {
        throw new ResourceNotFoundError("wallet not found");
      }
      const rows = await repositories.ledger.listByWallet(walletId, afterSeq, pageSize + 1);
      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      return {
        items: page.map(({ entry }) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: rows.length > pageSize && last ? encodeCursor(last.seq) : null,
      };
    });
  }
}

function parseLimit(limit: string | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number(limit);
  if (!/^[0-9]+$/.test(limit) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new InvalidCommandError("invalid fields: limit");
  }
  return parsed;
}
