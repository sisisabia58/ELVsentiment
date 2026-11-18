type QuoteResult = { id: string; url: string | null };
type QuoteComment = { id: string; resultId: string };

export function quoteHref(
  refId: string | undefined,
  results: QuoteResult[],
  comments: QuoteComment[],
): string | null {
  if (!refId) return null;
  if (refId.startsWith("result:")) {
    const id = refId.slice("result:".length);
    const result = results.find((item) => item.id === id);
    if (!result) return null;
    return result.url || `#hasil-${id}`;
  }
  if (refId.startsWith("comment:")) {
    const id = refId.slice("comment:".length);
    const comment = comments.find((item) => item.id === id);
    if (!comment) return null;
    const result = results.find((item) => item.id === comment.resultId);
    if (!result) return null;
    return result.url || `#hasil-${result.id}`;
  }
  return null;
}
