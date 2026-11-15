import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { CORRELATION_ID_HEADER } from "../../../shared/interface/http/correlation-id.middleware";
import { ProviderAuthGuard } from "../../../shared/interface/http/provider-auth.guard";
import { enrichLogContext } from "../../../shared/observability/log-context";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction";
import { WageringQueries } from "../../application/use-cases/wagering-queries";
import type { WagerTransactionResult, WagerTransactionView } from "../../application/views";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction-status";
import {
  WAGERING_METRICS,
  type WageringMetrics,
} from "../../infrastructure/observability/wagering-metrics";
import { toHttpError } from "./http-error-mapping";
import { asRecord, type StatusResponse } from "./request";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Status de um resultado de submissão. Igual na primeira vez e nos replays: o cliente que
 * reenvia recebe exatamente a mesma resposta, só com `idempotentReplay: true`.
 */
export function statusForResult(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    // FAILED é falha permanente de infraestrutura já gravada: reenviar a mesma chave só repete
    // o resultado, então não é 503 (que convidaria a tentar de novo).
    case WagerTransactionStatus.Failed:
    case WagerTransactionStatus.Pending:
      return 500;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringTransactionsController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submitTransaction: SubmitWagerTransaction,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
  ) {}

  /**
   * Header `Idempotency-Key` obrigatório (fonte da verdade da idempotência).
   * 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED (com failureCode) · 409 conflito ·
   * 400 payload inválido · 404 WALLET_NOT_FOUND · 503 transitório.
   */
  @Post("wagering/transactions")
  async submit(
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<WagerTransactionResult> {
    const transaction = asRecord(body);
    enrichLogContext({ providerId: transaction.providerId, walletId: transaction.walletId });
    const startedAt = performance.now();
    const elapsed = () => (performance.now() - startedAt) / 1_000;

    let result: WagerTransactionResult;
    try {
      result = await this.submitTransaction.execute({ idempotencyKey, transaction, correlationId });
    } catch (error: unknown) {
      this.metrics.transactionFailed("http", toHttpError(error).body.code, elapsed());
      throw error;
    }
    enrichLogContext({ transactionId: result.transactionId });
    this.metrics.transactionCompleted("http", result, elapsed());
    response.status(statusForResult(result.status));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string): Promise<WagerTransactionView> {
    enrichLogContext({ transactionId });
    return this.queries.getTransaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    enrichLogContext({ providerId });
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
