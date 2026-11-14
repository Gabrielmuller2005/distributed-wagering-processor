export const CLOCK = Symbol("CLOCK");

/** Fonte do "agora". Injetável para os testes controlarem o tempo. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
