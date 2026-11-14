import { redirect } from "next/navigation";
import { currentBootstrapMode } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";
import { AuthCard } from "../_components/auth-card";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  let mode;
  try {
    mode = await currentBootstrapMode();
  } catch {
    mode = "accounts" as const; // no database yet: the form will explain on submit
  }
  return (
    <AuthCard>
      {mode === "closed" ? (
        <p className="text-center text-sm text-soft">No accounts yet. Set ADMIN_PASSWORD (and ideally OWNER_EMAIL) on the server, then come back to create the first owner.</p>
      ) : (
        <LoginForm firstRun={mode !== "accounts"} />
      )}
    </AuthCard>
  );
}
