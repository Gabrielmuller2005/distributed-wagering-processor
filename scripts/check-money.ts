// Barreira automática contra aritmética monetária com ponto flutuante.
// Falha se encontrar parseFloat, Number( ou toFixed( no código da aplicação (src/).
// Dinheiro é tratado apenas pelo value object Money (decimal.js), nunca por number.
import { Glob } from "bun";

const FORBIDDEN = [
  { pattern: /\bparseFloat\s*\(/, label: "parseFloat(" },
  { pattern: /(?<![.\w])Number\s*\(/, label: "Number(" },
  { pattern: /\.toFixed\s*\(/, label: "toFixed(" },
];

const violations: string[] = [];

for await (const file of new Glob("src/**/*.ts").scan(".")) {
  const lines = (await Bun.file(file).text()).split("\n");
  lines.forEach((line, index) => {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(line)) violations.push(`${file}:${index + 1}  ${label}  ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  process.stderr.write(`Forbidden numeric conversions found in src/:\n${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("check:money ok: no parseFloat, Number( or toFixed( in src/\n");
