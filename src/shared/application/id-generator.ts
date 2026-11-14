export const ID_GENERATOR = Symbol("ID_GENERATOR");

/** Gera identificadores únicos para entidades, lançamentos e eventos. */
export interface IdGenerator {
  next(): string;
}

/**
 * UUID v7: ordenável pelo tempo de criação (os primeiros 48 bits são o timestamp em ms), o que
 * mantém os índices B-tree do PostgreSQL compactos, ao contrário do v4, que é totalmente
 * aleatório. O enunciado também usa v7 nos exemplos.
 */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
