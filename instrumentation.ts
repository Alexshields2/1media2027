import type { Instrumentation } from "next";

export function register() {}

// Called by Next.js for every uncaught server error (pages, server actions, route handlers, proxy).
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportError, toReport } = await import("./src/lib/monitoring");
  await reportError(toReport(err, request, context));
};
