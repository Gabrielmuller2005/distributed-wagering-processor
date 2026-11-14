import { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../../config/app-config";

/**
 * Cliente SQS. Com `AWS_ENDPOINT_URL` aponta para o emulador local (MiniStack); sem ele,
 * usa o endpoint real da AWS. Sem credenciais explícitas, o SDK usa a cadeia padrão.
 */
export function createSqsClient(aws: AppConfig["aws"]): SQSClient {
  return new SQSClient({
    region: aws.region,
    ...(aws.endpoint ? { endpoint: aws.endpoint } : {}),
    ...(aws.credentials ? { credentials: aws.credentials } : {}),
  });
}
