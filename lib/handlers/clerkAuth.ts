import { auth } from "@clerk/nextjs/server";
import type { AuthPort } from "./deps";

/**
 * The production AuthPort: Clerk's session, narrowed to the one field the
 * handlers use. Narrowing it here means a test fake is `async () => ({ userId })`
 * rather than a whole fabricated Clerk session object.
 */
export const clerkAuth: AuthPort = async () => {
  const { userId } = await auth();
  return { userId };
};
