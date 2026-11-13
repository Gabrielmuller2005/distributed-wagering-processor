import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createHttpApp } from "./app";

const DEFAULT_HTTP_PORT = 3000;

async function bootstrap(): Promise<void> {
  const port = Number.parseInt(process.env.HTTP_PORT ?? `${DEFAULT_HTTP_PORT}`, 10);
  const app = await createHttpApp();
  await app.listen(port);
  new Logger("Bootstrap").log(`HTTP listening on port ${port}`);
}

void bootstrap();
