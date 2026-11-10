import { createClient } from "../../actions";
import { Card, PageHeader } from "../../_components/ui";
import { ClientForm } from "../client-form";

export default function NewClientPage() {
  return (
    <>
      <PageHeader title="Add client" subtitle="Billing rows are created automatically from the retainer each month." />
      <Card>
        <ClientForm action={createClient} submitLabel="Create client" />
      </Card>
    </>
  );
}
