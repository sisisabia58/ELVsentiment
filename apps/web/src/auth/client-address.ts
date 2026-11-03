// Railway appends to x-forwarded-for. A client can prepend a fake address,
// so the email key is the limit that cannot be rotated away. The IP key
// only slows a single address.
export function clientAddressFrom(forwardedFor: string | null, realIp: string | null): string {
  const forwarded = forwardedFor?.split(",")[0]?.trim() ?? "";
  if (forwarded) return forwarded;
  return realIp?.trim() ?? "";
}
