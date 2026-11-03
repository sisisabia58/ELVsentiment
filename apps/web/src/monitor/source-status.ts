export function sourceStatusLines(
  sources: readonly { source: "x" | "threads"; state: string; configured: boolean }[],
): string[] {
  return sources.map((health) => {
    const name = health.source === "x" ? "X" : "Threads";
    if (!health.configured || health.state === "unavailable") return `Status ${name}: Tidak tersedia`;
    if (health.state === "ready") return `Status ${name}: Siap`;
    if (health.state === "rate_limited") return `Status ${name}: Dibatasi sementara`;
    if (health.state === "authorization_failed") return `Status ${name}: Otorisasi gagal`;
    return `Status ${name}: ${health.state}`;
  });
}
