import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import type { Store } from "./run";

/** The Postgres store used by `npm run import:notion`. All writes run in one transaction. */
export const dbStore: Store = {
  clients: () => db.select().from(schema.clients),
  payments: () => db.select().from(schema.payments),
  write: (fn) =>
    db.transaction(async (tx) => {
      await fn({
        async createClient(values) {
          const [row] = await tx.insert(schema.clients).values(values).returning({ id: schema.clients.id });
          return row.id;
        },
        async updateClient(id, set, notionIds) {
          await tx.update(schema.clients).set({ ...set, notionIds }).where(eq(schema.clients.id, id));
        },
        async createPayment(values) {
          await tx.insert(schema.payments).values(values);
        },
        async updatePayment(id, set) {
          await tx.update(schema.payments).set(set).where(eq(schema.payments.id, id));
        },
      });
    }),
};
