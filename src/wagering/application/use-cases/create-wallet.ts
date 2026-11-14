import type { Clock } from "../../../shared/application/clock";
import type { IdGenerator } from "../../../shared/application/id-generator";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { MoneyProps } from "../../domain/money";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction-kind";
import { InvalidWalletOperationError, Wallet } from "../../domain/wallet/wallet";
import { ValidationError } from "../errors";
import { parseMoney, requireString } from "../input";
import { outcomeOutboxMessages } from "../outcome-events";
import { canonicalJson, sha256Hex } from "../payload-hash";
import type { UnitOfWork } from "../ports/unit-of-work";
import { type WalletView, walletView } from "../views";

/** Provider usado nas transações internas (OPENING); não colide com provedores reais. */
export const INTERNAL_PROVIDER_ID = "internal";

export interface CreateWalletCommand {
  readonly playerId: unknown;
  readonly initialBalance: unknown;
  readonly correlationId: string;
}

/**
 * Cria a wallet. Um saldo inicial positivo gera, na **mesma transação SQL**, a transação interna
 * OPENING (já PROCESSED), o lançamento de crédito no ledger e os eventos na outbox. Assim a
 * invariante "todo saldo tem lançamento" vale desde o primeiro centavo.
 *
 * Wallet duplicada para o mesmo player e moeda: WalletAlreadyExistsError (UNIQUE no banco).
 */
export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const playerId = requireString(command.playerId, "playerId");
    const initialBalance = parseMoney(command.initialBalance, "initialBalance");
    const at = this.clock.now();

    const { wallet, openingMovement } = this.openWallet(playerId, initialBalance, at);

    return this.unitOfWork.run(async (repositories) => {
      await repositories.wallets.insert(wallet);
      if (!openingMovement) return walletView(wallet);

      const opening = WagerTransaction.create({
        id: this.ids.next(),
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${wallet.id}`,
        payloadHash: openingPayloadHash(wallet.id, playerId, initialBalance.toJSON()),
        walletId: wallet.id,
        playerId,
        roundId: "opening",
        gameId: "opening",
        kind: WagerTransactionKind.Opening,
        money: openingMovement.money,
        createdAt: at,
      });
      opening.markProcessed({ balanceAfter: openingMovement.balanceAfter, at });

      const ledgerEntry = WalletLedgerEntry.create({
        ...openingMovement,
        id: this.ids.next(),
        walletId: wallet.id,
        transactionId: opening.id,
        createdAt: at,
      });

      await repositories.transactions.insertIfAbsent(opening);
      await repositories.ledger.append(ledgerEntry);
      await repositories.outbox.add(
        outcomeOutboxMessages({
          transaction: opening,
          wallet,
          ledgerEntry,
          metadata: { correlationId: command.correlationId },
          ids: this.ids,
          at,
        }),
      );
      return walletView(wallet);
    });
  }

  private openWallet(playerId: string, initialBalance: ReturnType<typeof parseMoney>, at: Date) {
    try {
      return Wallet.open({ id: this.ids.next(), playerId, initialBalance, at });
    } catch (error: unknown) {
      if (error instanceof InvalidWalletOperationError) {
        throw new ValidationError("INVALID_AMOUNT", "initialBalance", error.message);
      }
      throw error;
    }
  }
}

function openingPayloadHash(walletId: string, playerId: string, money: MoneyProps): string {
  return sha256Hex(
    canonicalJson({
      kind: WagerTransactionKind.Opening,
      walletId,
      playerId,
      money: { amount: money.amount, currency: money.currency },
    }),
  );
}
