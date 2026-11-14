import Link from "next/link";
import { db, schema } from "@/db";
import { allUsers, requireUser } from "@/lib/session";
import { SOP_TEMPLATES } from "@/lib/sops";
import { createSop } from "../../actions";
import { PageHeader } from "../../_components/ui";
import { SopForm } from "../sop-form";

export const dynamic = "force-dynamic";

export default async function NewSop({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [users, cats] = await Promise.all([allUsers(), db.selectDistinct({ c: schema.sops.category }).from(schema.sops)]);
  const template = SOP_TEMPLATES.find((t) => t.key === sp.template);
  return (
    <>
      <PageHeader title={template ? `New SOP: ${template.title}` : "New SOP"} subtitle={<Link href="/sops" className="underline">Back to the library</Link>} />
      <div className="mb-6 flex flex-wrap gap-2 text-sm">
        <span className="text-black/50">Start from a template:</span>
        {SOP_TEMPLATES.map((t) => (
          <Link key={t.key} href={`/sops/new?template=${t.key}`} className={`rounded-full border px-3 py-0.5 ${t.key === template?.key ? "border-brand bg-brand-soft text-brand" : "border-black/10 bg-white hover:bg-black/5"}`}>
            {t.title}
          </Link>
        ))}
      </div>
      <SopForm
        key={template?.key ?? "blank"}
        action={createSop}
        template={template}
        users={users}
        categories={[...new Set(["Client success", "Reporting", "Onboarding", "Sales", "Finance", "Delivery", ...cats.map((c) => c.c)])]}
        submitLabel="Save SOP"
        isOwner={me.role === "owner"}
        claudeReady={!!process.env.ANTHROPIC_API_KEY}
      />
    </>
  );
}
