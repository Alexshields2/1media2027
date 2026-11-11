import type { Client } from "@/db/schema";
import { input, label, btn } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

function Field({ name, title, defaultValue, type = "text", placeholder, wide }: { name: string; title: string; defaultValue?: string | number | null; type?: string; placeholder?: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <label className={label} htmlFor={name}>
        {title}
      </label>
      <input id={name} name={name} type={type} step={type === "number" ? "0.01" : undefined} defaultValue={defaultValue ?? ""} placeholder={placeholder} className={input} />
    </div>
  );
}

function Select({ name, title, value, options }: { name: string; title: string; value?: string; options: [string, string][] }) {
  return (
    <div>
      <label className={label} htmlFor={name}>
        {title}
      </label>
      <select id={name} name={name} defaultValue={value} className={input}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/** showBilling=false (team members) leaves out retainer, VAT, billing method and Stripe customer; the server ignores them too. */
export function ClientForm({ client, action, submitLabel, showBilling = true }: { client?: Client; action: (f: FormData) => Promise<void>; submitLabel: string; showBilling?: boolean }) {
  const c = client;
  return (
    <form action={action} className="space-y-6">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Business</legend>
        <Field name="name" title="Business name *" defaultValue={c?.name} />
        <Select name="status" title="Status" value={c?.status ?? "active"} options={[["onboarding", "Onboarding"], ["active", "Active"], ["paused", "Paused"], ["churned", "Churned"]]} />
        <Field name="contactName" title="Contact name" defaultValue={c?.contactName} />
        <Field name="email" title="Billing email" type="email" defaultValue={c?.email} />
        <Field name="phone" title="Phone" defaultValue={c?.phone} />
        <Field name="website" title="Website" defaultValue={c?.website} />
        <Field name="industry" title="Industry" defaultValue={c?.industry} placeholder="e.g. Paving" />
        <Field name="startDate" title="Start date" type="date" defaultValue={c?.startDate} />
      </fieldset>

      {showBilling && (
      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Billing</legend>
        <Field name="retainerExVat" title="Monthly retainer (ex VAT)" type="number" defaultValue={c?.retainerExVat} />
        <Select name="vat" title="VAT" value={c?.vat ?? "plus"} options={[["plus", "Plus VAT (23%)"], ["inc", "Inc VAT"], ["none", "No VAT"]]} />
        <Select name="billingMethod" title="Billing method" value={c?.billingMethod ?? "invoice"} options={[["stripe", "Stripe"], ["invoice", "Invoice"], ["revolut", "Revolut"], ["aib", "AIB"], ["cash", "Cash"]]} />
      </fieldset>
      )}

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Integrations</legend>
        <Field name="metaAdAccountIds" title="Meta ad account IDs" defaultValue={c?.metaAdAccountIds} placeholder="Comma separated" />
        <Field name="ghlLocationId" title="GoHighLevel location ID" defaultValue={c?.ghlLocationId} />
        {showBilling && <Field name="stripeCustomerId" title="Stripe customer ID" defaultValue={c?.stripeCustomerId} placeholder="cus_…" />}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Reporting</legend>
        <Field name="cplTarget" title="CPL target" type="number" defaultValue={c?.cplTarget} />
        <Select name="reportCurrency" title="Report currency" value={c?.reportCurrency ?? "EUR"} options={[["EUR", "Euro (€)"], ["USD", "US dollar ($)"]]} />
        <Field name="reportGreeting" title="Report greeting" defaultValue={c?.reportGreeting ?? "Hi guys"} />
        <div className="sm:col-span-3">
          <label className={label} htmlFor="reportRules">
            Report rules (overrides the default weekly format)
          </label>
          <textarea id="reportRules" name="reportRules" rows={3} defaultValue={c?.reportRules ?? ""} className={input} placeholder="e.g. Don't list leads. Break down the Irish and Spanish campaigns separately…" />
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-semibold">Goals and notes</legend>
        <textarea name="goals" rows={2} defaultValue={c?.goals ?? ""} className={input} placeholder="Revenue goal, jobs per month…" />
        <textarea name="notes" rows={3} defaultValue={c?.notes ?? ""} className={input} placeholder="Anything the team or agents should know" />
      </fieldset>

      <SubmitButton className={btn}>{submitLabel}</SubmitButton>
    </form>
  );
}
