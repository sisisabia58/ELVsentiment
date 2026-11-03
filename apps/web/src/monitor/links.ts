export function projectHref(path: string, projectId: string | null | undefined, params?: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  if (projectId) search.set("proyek", projectId);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}
