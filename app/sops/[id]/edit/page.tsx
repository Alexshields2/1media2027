import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { allUsers, requireUser } from "@/lib/session";
import { updateSop } from "../../../actions";
import { PageHeader } from "../../../_components/ui";
import { SopForm } from "../../sop-form";

export const dynamic = "force-dynamic";

export default async function EditSop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireUser();
  const [sop] = await db.select().from(schema.sops).where(eq(schema.sops.id, Number(id)));
  if (!sop) notFound();
  const [users, cats] = await Promise.all([allUsers(), db.selectDistinct({ c: schema.sops.category }).from(schema.sops)]);
  return (
    <>
      <PageHeader title={`Edit: ${sop.title}`} subtitle={<Link href={`/sops/${sop.id}`} className="underline">Back to the lesson</Link>} />
      <SopForm
        action={updateSop.bind(null, sop.id)}
        sop={sop}
        users={users}
        categories={cats.map((c) => c.c)}
        submitLabel="Save changes"
        isOwner={me.role === "owner"}
        claudeReady={!!process.env.ANTHROPIC_API_KEY}
      />
    </>
  );
}
