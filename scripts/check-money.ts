// Barreira automática contra aritmética monetária com ponto flutuante.
// Falha se encontrar parseFloat, Number( ou toFixed( no código da aplicação (src/).
// Dinheiro é tratado apenas pelo value object Money (decimal.js), nunca por number.
import { Glob } from "bun";

interface ForbiddenPattern {
  readonly pattern: RegExp;
  readonly label: string;
  /**
   * Arquivos onde o padrão é permitido, cada um com a justificativa.
   * A lista é curta e explícita de propósito: qualquer exceção nova aparece no code review.
   */
  readonly allowedIn?: Readonly<Record<string, string>>;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  { pattern: /\bparseFloat\s*\(/, label: "parseFloat(" },
  { pattern: /(?<![.\w])Number\s*\(/, label: "Number(" },
  {
    pattern: /\.toFixed\s*\(/,
    label: "toFixed(",
    allowedIn: {
      "src/wagering/domain/money/money.ts":
        "Decimal#toFixed (decimal.js) formata a partir do valor decimal exato; não é Number#toFixed",
    },
  },
];

const violations: string[] = [];

for await (const file of new Glob("src/**/*.ts").scan(".")) {
  const normalizedPath = file.replaceAll("\\", "/");
  const lines = (await Bun.file(file).text()).split("\n");

  lines.forEach((line, index) => {
    for (const { pattern, label, allowedIn } of FORBIDDEN) {
      if (allowedIn?.[normalizedPath] !== undefined) continue;
      if (pattern.test(line)) {
        violations.push(`${normalizedPath}:${index + 1}  ${label}  ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  process.stderr.write(`Forbidden numeric conversions found in src/:\n${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("check:money ok: no parseFloat, Number( or toFixed( in src/\n");
