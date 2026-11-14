import type { Clock } from "../../../shared/application/clock";
import type { IdGenerator } from "../../../shared/application/id-generator";
import { backoffDelayMs } from "../../../shared/domain/backoff";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { applyWagerTransaction } from "../../domain/wager-processing/apply-wager-transaction";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { InvalidWagerTransactionError } from "../../domain/wager-transaction/wager-transaction.errors";
import {
  SUBMITTABLE_KINDS,
  type WagerTransactionKind,
} from "../../domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction-status";
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InboxConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../errors";
import { optionalString, parseMoney, requireString } from "../input";
import { outcomeOutboxMessages } from "../outcome-events";
import { wagerPayloadHash } from "../payload-hash";
import { PENDING_REFERENCE_RETRY_POLICY } from "../pending-reference-policy";
import type { TransactionalRepositories } from "../ports/repositories";
import type { UnitOfWork } from "../ports/unit-of-work";
import { type WagerTransactionResult, wagerTransactionResult } from "../views";

/** Campos de negócio da transação (formato do enunciado). Vêm de JSON: validados em tempo de execução. */
export interface WagerTransactionInput {
  readonly providerId?: unknown;
  readonly externalTransactionId?: unknown;
  readonly playerId?: unknown;
  readonly walletId?: unknown;
  readonly roundId?: unknown;
  readonly gameId?: unknown;
  readonly kind?: unknown;
  readonly money?: unknown;
  readonly referenceExternalTransactionId?: unknown;
}

/** Presente quando a transação chega pelo SQS: a mensagem é registrada na inbox na mesma transação SQL. */
export interface InboxContext {
  readonly consumerName: string;
  readonly messageId: string;
  /** Hash do corpo da mensagem, para distinguir redelivery de messageId reutilizado. */
  readonly payloadHash: string;
}

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: unknown;
  readonly transaction: WagerTransactionInput;
  readonly correlationId: string;
  readonly inbox?: InboxContext | undefined;
}

/** Chave da idempotência: mesmo limite da coluna no banco. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Submete uma transação de aposta (BET, WIN, LOSS, REFUND, ROLLBACK). É o mesmo caso de uso
 * para HTTP e SQS.
 *
 * Fluxo:
 * 1. valida a entrada e calcula o payloadHash (nada é gravado se a entrada for inválida);
 * 2. caminho rápido, sem lock: a idempotency key já existe? hash igual → replay; diferente → conflito;
 * 3. numa única transação SQL:
 *    - trava a wallet (`SELECT ... FOR UPDATE`); se não existe, WalletNotFoundError;
 *    - registra a mensagem na inbox (caminho SQS);
 *    - grava a transação PENDING com `ON CONFLICT DO NOTHING`; se já existia (corrida com a mesma
 *      chave), relê e devolve replay ou conflito;
 *    - resolve a referência e aplica as regras do domínio;
 *    - grava wallet (`UPDATE ... WHERE version`), lançamento, resultado e eventos na outbox.
 *
 * Rejeição de negócio é um resultado gravado (REJECTED + failureCode), não uma exceção.
 * Erros transitórios (lock timeout, deadlock) desfazem tudo e sobem para a borda, que responde
 * 503 (HTTP) ou deixa o SQS reentregar: como nada foi confirmado, repetir é seguro.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<WagerTransactionResult> {
    const at = this.clock.now();
    const transaction = this.buildTransaction(command, at);

    // Caminho rápido: a maioria das repetições termina aqui, sem disputar o lock da wallet.
    const existing = await this.unitOfWork.run(({ transactions }) =>
      transactions.findByIdempotencyKey(transaction.idempotencyKey),
    );
    if (existing) return replayOrConflict(existing, transaction.payloadHash);

    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(transaction.walletId);
      if (!wallet) throw new WalletNotFoundError(transaction.walletId);

      if (command.inbox && !(await recordInbox(repositories, command.inbox, at))) {
        return replayExisting(repositories, transaction);
      }
      if (!(await repositories.transactions.insertIfAbsent(transaction))) {
        return replayExisting(repositories, transaction);
      }

      const referenceExternalId = transaction.referenceExternalTransactionId;
      const reference =
        referenceExternalId === undefined
          ? undefined
          : await repositories.transactions.findByProviderAndExternalId(
              transaction.providerId,
              referenceExternalId,
            );
      const referenceAlreadyReversed = reference
        ? await repositories.transactions.hasProcessedReversal(reference.id)
        : false;

      const expectedVersion = wallet.version;
      const outcome = applyWagerTransaction({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        at,
      });

      const ledgerEntry =
        outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
      if (ledgerEntry) {
        await repositories.wallets.saveBalance(wallet, expectedVersion);
        await repositories.ledger.append(ledgerEntry);
      }
      await repositories.transactions.saveResult(transaction);

      if (outcome.status === WagerTransactionStatus.PendingReference) {
        const delay = backoffDelayMs(1, PENDING_REFERENCE_RETRY_POLICY);
        await repositories.transactions.scheduleReferenceRetry(
          transaction.id,
          0,
          new Date(at.getTime() + delay),
        );
      }

      await repositories.outbox.add(
        outcomeOutboxMessages({
          transaction,
          wallet,
          ledgerEntry,
          metadata: { correlationId: command.correlationId, causationId: command.inbox?.messageId },
          ids: this.ids,
          at,
        }),
      );

      return wagerTransactionResult(transaction, false);
    });
  }

  /** Valida a entrada e monta a transação PENDING (com o payloadHash). Não toca no banco. */
  private buildTransaction(command: SubmitWagerTransactionCommand, at: Date): WagerTransaction {
    const input = command.transaction;
    if (input === null || typeof input !== "object") {
      throw new ValidationError("MISSING_FIELD", "transaction", "transaction payload is required");
    }

    const idempotencyKey = requireString(command.idempotencyKey, "idempotencyKey", {
      maxLength: MAX_IDEMPOTENCY_KEY_LENGTH,
      missingCode: "IDEMPOTENCY_KEY_REQUIRED",
    });
    const providerId = requireString(input.providerId, "providerId");
    const externalTransactionId = requireString(
      input.externalTransactionId,
      "externalTransactionId",
    );
    const playerId = requireString(input.playerId, "playerId");
    const walletId = requireString(input.walletId, "walletId");
    const roundId = requireString(input.roundId, "roundId");
    const gameId = requireString(input.gameId, "gameId");
    const kind = parseSubmittableKind(input.kind);
    const money = parseMoney(input.money, "money");
    const referenceExternalTransactionId = optionalString(
      input.referenceExternalTransactionId,
      "referenceExternalTransactionId",
    );

    const payloadHash = wagerPayloadHash({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      amount: money.toString(),
      currency: money.currency,
      referenceExternalTransactionId: referenceExternalTransactionId ?? null,
    });

    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId,
        externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId,
        playerId,
        roundId,
        gameId,
        kind,
        money,
        referenceExternalTransactionId,
        createdAt: at,
      });
    } catch (error: unknown) {
      if (error instanceof InvalidWagerTransactionError) {
        throw new ValidationError(error.reason, "transaction", error.message);
      }
      throw error;
    }
  }
}

/** OPENING é interno e nunca aceito pela API nem pela fila. */
function parseSubmittableKind(value: unknown): WagerTransactionKind {
  const kind = SUBMITTABLE_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new ValidationError(
      "INVALID_KIND",
      "kind",
      `kind must be one of ${SUBMITTABLE_KINDS.join(", ")}`,
    );
  }
  return kind;
}

function replayOrConflict(existing: WagerTransaction, payloadHash: string): WagerTransactionResult {
  if (!existing.matchesPayload(payloadHash)) {
    throw new IdempotencyConflictError("PAYLOAD_MISMATCH", existing.id);
  }
  return wagerTransactionResult(existing, true);
}

/**
 * A transação já existe (corrida com a mesma chave, ou mensagem SQS já processada).
 * Mesma chave: replay ou conflito pelo hash. Só o mesmo id externo, com outra chave: conflito.
 */
async function replayExisting(
  repositories: TransactionalRepositories,
  transaction: WagerTransaction,
): Promise<WagerTransactionResult> {
  const byKey = await repositories.transactions.findByIdempotencyKey(transaction.idempotencyKey);
  if (byKey) return replayOrConflict(byKey, transaction.payloadHash);

  const byExternalId = await repositories.transactions.findByProviderAndExternalId(
    transaction.providerId,
    transaction.externalTransactionId,
  );
  if (byExternalId) throw new IdempotencyConflictError("EXTERNAL_ID_REUSED", byExternalId.id);

  // ON CONFLICT não inseriu, mas nenhuma das duas chaves foi achada: não deveria acontecer.
  throw new ConcurrentModificationError("WagerTransaction", transaction.idempotencyKey);
}

/**
 * Registra a mensagem na inbox. false = já processada antes (redelivery); mesmo messageId com
 * outro conteúdo é conflito, nunca ignorado em silêncio.
 */
async function recordInbox(
  repositories: TransactionalRepositories,
  context: InboxContext,
  at: Date,
): Promise<boolean> {
  const message = InboxMessage.receive({ ...context, receivedAt: at });
  message.markProcessed(at);
  if (await repositories.inbox.insertIfAbsent(message)) return true;

  const existing = await repositories.inbox.find(context.consumerName, context.messageId);
  if (existing && !existing.matchesPayload(context.payloadHash)) {
    throw new InboxConflictError(context.consumerName, context.messageId);
  }
  return false;
}
