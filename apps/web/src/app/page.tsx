import { redirect } from "next/navigation";
import { homeDestination } from "@/auth/home-redirect";
import { readSessionToken, sessionCustomerId } from "@/auth/request-session";

// Blocking on purpose: a Suspense shell would paint before this redirect.
export const instant = false;

export default async function Home() {
  const token = await readSessionToken();
  redirect(await homeDestination(token, async () => sessionCustomerId()));
}
