import { AuthApiError } from "@/features/auth/authApi";

/**
 * What the console says when one of its writes fails (ADR-039).
 *
 * Named outcomes where the admin has something to do about them; one generic
 * sentence for everything else, so a server's internal message never reaches
 * the page.
 */
export function consoleWriteError(caught: unknown, fallback: string): string {
  if (!(caught instanceof AuthApiError)) return fallback;

  switch (caught.code) {
    case "MEMBER_ALREADY_EXISTS":
      return "That person is already a member of this organisation.";
    case "MEMBER_NOT_INVITABLE":
      return caught.message.includes("owner")
        ? caught.message
        : "That email belongs to an account that cannot join an organisation.";
    case "ORGANIZATION_SLUG_UNAVAILABLE":
      return "No link could be made from that name. Try a different organisation name.";
    case "TOO_MANY_REQUESTS":
      return "Too many attempts. Wait a few minutes and try again.";
    case "NETWORK_ERROR":
      return "Could not reach the server. Check your connection and try again.";
    default:
      break;
  }

  if (caught.issues.length > 0) return caught.issues[0]!.message;
  if (caught.status === 404) return "That organisation no longer exists.";
  if (caught.status === 500) return "The invitation email could not be sent, so nothing was created. Try again.";
  return fallback;
}
