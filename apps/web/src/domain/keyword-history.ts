export type KeywordEditEffect = {
  futureQueries: readonly string[];
  reclassifyExisting: false;
};

export function effectOfKeywordEdit(activeVariants: readonly string[]): KeywordEditEffect {
  return { futureQueries: [...activeVariants], reclassifyExisting: false };
}
