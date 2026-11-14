import type { UnitOfWork } from "../../src/wagering/application/ports/unit-of-work";
import { WalletLedgerEntry } from "../../src/wagering/domain/ledger/wallet-ledger-entry";
import { Money } from "../../src/wagering/domain/money";
import {
  applyWagerTransaction,
  type WagerOutcome,
} from "../../src/wagering/domain/wager-processing/apply-wager-transaction";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../src/wagering/domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { Wallet } from "../../src/wagering/domain/wallet/wallet";

export const newId = (): string => Bun.randomUUIDv7();
export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
export const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Transação PENDING com dados válidos e únicos; os campos podem ser sobrescritos. */
export function newTransaction(
  walletId: string,
  playerId: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${newId()}`;
  return WagerTransaction.create({
    id: newId(),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: sha256(externalTransactionId),
    walletId,
    playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("10.00"),
    createdAt: new Date(),
    ...overrides,
  });
}

export interface PersistedWallet {
  readonly wallet: Wallet;
  readonly openingTransaction: WagerTransaction | undefined;
}

/**
 * Abre uma wallet como o caso de uso fará: wallet + transação OPENING PROCESSED + lançamento
 * de crédito, tudo na mesma transação SQL. Só para preparar cenários de teste.
 */
export async function persistWallet(
  unitOfWork: UnitOfWork,
  initialBalance = "100.00",
  playerId = `player-${newId()}`,
): Promise<PersistedWallet> {
  const at = new Date();
  const { wallet, openingMovement } = Wallet.open({
    id: newId(),
    playerId,
    initialBalance: brl(initialBalance),
    at,
  });

  return unitOfWork.run(async (repositories) => {
    await repositories.wallets.insert(wallet);
    if (!openingMovement) return { wallet, openingTransaction: undefined };

    const opening = newTransaction(wallet.id, playerId, {
      kind: WagerTransactionKind.Opening,
      providerId: "internal",
      externalTransactionId: `opening-${wallet.id}`,
      idempotencyKey: `internal:opening-${wallet.id}`,
      money: openingMovement.money,
      createdAt: at,
    });
    opening.markProcessed({ balanceAfter: openingMovement.balanceAfter, at });
    await repositories.transactions.insertIfAbsent(opening);
    await repositories.ledger.append(
      WalletLedgerEntry.create({
        ...openingMovement,
        id: newId(),
        walletId: wallet.id,
        transactionId: opening.id,
        createdAt: at,
      }),
    );
    return { wallet, openingTransaction: opening };
  });
}

export interface ProcessOptions {
  /**
   * Ignora a checagem de "já revertida" do domínio, para provar que o banco (índice único
   * parcial) barra a reversão dupla sozinho.
   */
  readonly skipDomainReversalCheck?: boolean;
}

/**
 * Processa uma transação como o caso de uso fará: trava a wallet (FOR UPDATE), aplica as regras
 * do domínio e grava wallet, lançamento e resultado na mesma transação SQL.
 */
export async function processTransaction(
  unitOfWork: UnitOfWork,
  transaction: WagerTransaction,
  options: ProcessOptions = {},
): Promise<WagerOutcome> {
  return unitOfWork.run(async (repositories) => {
    const wallet = await repositories.wallets.findByIdForUpdate(transaction.walletId);
    if (!wallet) throw new Error(`wallet ${transaction.walletId} not found`);
    await repositories.transactions.insertIfAbsent(transaction);

    const referenceId = transaction.referenceExternalTransactionId;
    const reference = referenceId
      ? await repositories.transactions.findByProviderAndExternalId(
          transaction.providerId,
          referenceId,
        )
      : undefined;
    const referenceAlreadyReversed =
      reference && !options.skipDomainReversalCheck
        ? await repositories.transactions.hasProcessedReversal(reference.id)
        : false;

    const expectedVersion = wallet.version;
    const outcome = applyWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: newId(),
      at: new Date(),
    });

    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry) {
      await repositories.wallets.saveBalance(wallet, expectedVersion);
      await repositories.ledger.append(outcome.ledgerEntry);
    }
    await repositories.transactions.saveResult(transaction);
    return outcome;
  });
}
