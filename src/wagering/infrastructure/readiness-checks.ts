import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { ReadinessCheck } from "../../health/readiness";

/** PostgreSQL alcançável: um `select 1` numa conexão do pool. */
export class DatabaseReadinessCheck implements ReadinessCheck {
  readonly name = "database";

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await this.orm.em.fork().execute("select 1");
  }
}

/** SQS alcançável e a fila existente. */
export class SqsReadinessCheck implements ReadinessCheck {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    readonly name = "sqs",
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
      abortSignal: signal,
    });
  }
}
