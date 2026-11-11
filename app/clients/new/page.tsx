import { requireUser } from "@/lib/session";
import { can } from "@/lib/roles";
import { createClient } from "../../actions";
import { Card, PageHeader } from "../../_components/ui";
import { ClientForm } from "../client-form";

export const dynamic = "force-dynamic";

export default async function NewClientPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Add client" subtitle="Billing rows are created automatically from the retainer each month." />
      <Card>
        <ClientForm action={createClient} submitLabel="Create client" showBilling={can(user.role, "client_billing")} />
      </Card>
    </>
  );
}
