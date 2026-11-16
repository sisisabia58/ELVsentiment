const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export function startOfJakartaDay(now: Date): Date {
  const shifted = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - JAKARTA_OFFSET_MS);
}
