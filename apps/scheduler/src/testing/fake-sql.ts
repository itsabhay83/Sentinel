import type postgres from "postgres";

/**
 * A recording stand-in for the `TransactionSql` executor that every fenced
 * write takes as its first parameter. That parameter is the seam these tests
 * use instead of a live database.
 */

export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Decides what a statement returns, given its text with every bind hole
 * rendered as `?`. Returning rows from here is what lets a test model a
 * `RETURNING` clause or a catalogue read.
 */
export type RowRouter = (text: string) => readonly unknown[];

export interface FakeTransaction {
  readonly tx: postgres.TransactionSql;
  readonly queries: RecordedQuery[];
}

/**
 * `postgres.TransactionSql` is a forty-odd member interface; production code
 * under test calls exactly one of them, the tagged template. The conversion is
 * confined to this function so the fake stays honest about what it models.
 */
export function fakeTransaction(route: RowRouter = () => []): FakeTransaction {
  const queries: RecordedQuery[] = [];

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    queries.push({ text, values });
    return Promise.resolve([...route(text)]);
  };

  return { tx: tagged as unknown as postgres.TransactionSql, queries };
}

export function matching(queries: readonly RecordedQuery[], fragment: string): RecordedQuery[] {
  return queries.filter((query) => query.text.includes(fragment));
}
