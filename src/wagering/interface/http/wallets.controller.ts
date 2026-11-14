import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CORRELATION_ID_HEADER } from "../../../shared/interface/http/correlation-id.middleware";
import { ProviderAuthGuard } from "../../../shared/interface/http/provider-auth.guard";
import { CreateWallet } from "../../application/use-cases/create-wallet";
import {
  ReconcileWallet,
  type ReconciliationReport,
} from "../../application/use-cases/reconcile-wallet";
import { WageringQueries } from "../../application/use-cases/wagering-queries";
import type { LedgerEntryView, WalletView } from "../../application/views";
import { decodeLedgerCursor, encodeLedgerCursor, parseLedgerLimit } from "./ledger-cursor";
import { asRecord } from "./request";

export interface LedgerPageResponse {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  /** Cursor opaco da próxima página; null quando não há mais lançamentos. */
  readonly nextCursor: string | null;
}

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  private readonly logger = new Logger("Reconciliation");

  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  /** 201 com a wallet; 409 WALLET_ALREADY_EXISTS; 400 VALIDATION_ERROR. */
  @Post()
  @HttpCode(201)
  create(
    @Body() body: unknown,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
  ): Promise<WalletView> {
    const input = asRecord(body);
    return this.createWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  /** `?cursor=<opaco>&limit=50` (máximo 200), em ordem cronológica de versão da wallet. */
  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: unknown,
    @Query("limit") limit: unknown,
  ): Promise<LedgerPageResponse> {
    const page = await this.queries.listLedger(walletId, {
      afterVersion: decodeLedgerCursor(cursor),
      limit: parseLedgerLimit(limit),
    });
    return {
      walletId: page.walletId,
      entries: page.entries,
      nextCursor:
        page.nextAfterVersion === undefined ? null : encodeLedgerCursor(page.nextAfterVersion),
    };
  }

  /**
   * Recalcula o saldo pelo ledger e compara com o armazenado. Divergência não é corrigida:
   * é logada e sinalizada na resposta (`consistent: false`).
   */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(
    @Param("walletId") walletId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
  ): Promise<ReconciliationReport> {
    const report = await this.reconcileWallet.execute(walletId);
    if (!report.consistent) {
      this.logger.warn(
        `Wallet ${walletId} is inconsistent: stored ${report.storedBalance.amount}, ` +
          `calculated ${report.calculatedBalance.amount} ${report.storedBalance.currency} ` +
          `(correlationId ${correlationId})`,
      );
    }
    return report;
  }
}
