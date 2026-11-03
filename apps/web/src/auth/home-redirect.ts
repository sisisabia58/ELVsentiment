import { SESSION_COOKIE } from "./accounts";

export { SESSION_COOKIE };

export async function homeDestination(
  token: string | undefined,
  lookup: (token: string) => Promise<string | null>,
): Promise<"/masuk" | "/dasbor"> {
  if (!token) return "/masuk";
  const customerId = await lookup(token);
  return customerId ? "/dasbor" : "/masuk";
}
