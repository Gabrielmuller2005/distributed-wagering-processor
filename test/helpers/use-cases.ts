import { SystemClock } from "../../src/shared/application/clock";
import { UuidV7Generator } from "../../src/shared/application/id-generator";
import type { UnitOfWork } from "../../src/wagering/application/ports/unit-of-work";
import { CreateWallet } from "../../src/wagering/application/use-cases/create-wallet";
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  type WagerTransactionInput,
} from "../../src/wagering/application/use-cases/submit-wager-transaction";
import type { WalletView } from "../../src/wagering/application/views";
import { newId } from "./fixtures";

export function useCases(unitOfWork: UnitOfWork) {
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  return {
    createWallet: new CreateWallet(unitOfWork, ids, clock),
    submit: new SubmitWagerTransaction(unitOfWork, ids, clock),
  };
}

export async function openWallet(
  createWallet: CreateWallet,
  amount = "100.00",
  playerId = newId(),
): Promise<WalletView> {
  return createWallet.execute({
    playerId,
    initialBalance: { amount, currency: "BRL" },
    correlationId: newId(),
  });
}

/** Comando de submissão válido para a wallet, com chave padrão `{providerId}:{externalId}`. */
export function wagerCommand(
  wallet: WalletView,
  transaction: Partial<Record<keyof WagerTransactionInput, unknown>> = {},
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const input: WagerTransactionInput = {
    providerId: "provider-a",
    externalTransactionId: `tx-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...transaction,
  };
  return {
    idempotencyKey: `${input.providerId}:${input.externalTransactionId}`,
    transaction: input,
    correlationId: newId(),
    ...overrides,
  };
}
