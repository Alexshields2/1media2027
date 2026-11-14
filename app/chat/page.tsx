import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { listProfiles } from "@/lib/chat/profiles";
import { canUseProfile } from "@/lib/chat/access";

export const dynamic = "force-dynamic";

/** /chat opens the first agent this person can use (Jarvis). */
export default async function ChatIndex() {
  const user = await requireUser();
  const first = (await listProfiles()).find((p) => canUseProfile(user.role, p));
  redirect(first ? `/chat/${first.slug}` : "/");
}
