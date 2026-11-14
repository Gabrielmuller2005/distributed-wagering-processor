import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  sha256Hex,
  type WagerPayloadFields,
  wagerPayloadHash,
} from "../../../../src/wagering/application/payload-hash";

const fields: WagerPayloadFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  amount: "25.00",
  currency: "BRL",
  referenceExternalTransactionId: null,
};

describe("canonicalJson", () => {
  test("ordena as chaves recursivamente e não usa espaços", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  test("a ordem de chegada das chaves não muda o resultado", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("arrays mantêm a ordem", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  test("escapa strings como o JSON padrão", () => {
    expect(canonicalJson({ 'k"ey': 'va"lue\n' })).toBe('{"k\\"ey":"va\\"lue\\n"}');
  });
});

describe("sha256Hex", () => {
  test("vetor conhecido: sha256('abc')", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("64 caracteres hexadecimais minúsculos", () => {
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("wagerPayloadHash", () => {
  test("é determinístico", () => {
    expect(wagerPayloadHash(fields)).toBe(wagerPayloadHash({ ...fields }));
  });

  test("é o SHA-256 do JSON canônico documentado", () => {
    const expected = sha256Hex(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},' +
        '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a",' +
        '"referenceExternalTransactionId":null,"roundId":"round-987",' +
        '"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );

    expect(wagerPayloadHash(fields)).toBe(expected);
  });

  test.each([
    ["providerId", "provider-b"],
    ["externalTransactionId", "transaction-124"],
    ["playerId", "other-player"],
    ["walletId", "other-wallet"],
    ["roundId", "round-988"],
    ["gameId", "other-game"],
    ["kind", "WIN"],
    ["amount", "25.01"],
    ["currency", "USD"],
    ["referenceExternalTransactionId", "bet-1"],
  ] as const)("mudar %s muda o hash", (field, value) => {
    expect(wagerPayloadHash({ ...fields, [field]: value })).not.toBe(wagerPayloadHash(fields));
  });
});
