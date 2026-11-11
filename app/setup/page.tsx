import { redirect } from "next/navigation";
import { currentBootstrapMode, hasSetupPass } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { AuthCard } from "../_components/auth-card";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

// One-time page: only reachable while no users exist and right after entering ADMIN_PASSWORD.
export default async function SetupPage() {
  if ((await currentBootstrapMode()) !== "setup" || !(await hasSetupPass())) redirect("/login");
  return (
    <AuthCard>
      <SetupForm minLength={MIN_PASSWORD_LENGTH} />
    </AuthCard>
  );
}
