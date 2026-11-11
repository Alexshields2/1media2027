"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { toWhatsApp } from "@/lib/whatsapp";

export function SubmitButton({ children, className, pendingText = "Working…" }: { children: React.ReactNode; className: string; pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingText : children}
    </button>
  );
}

export function CopyButton({ text, className }: { text: string; className: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Re-renders the current server page every few seconds (e.g. while an agent run is still going). */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}

/** Copies the (possibly edited, unsaved) text of a textarea, converted to WhatsApp formatting. */
export function WhatsAppCopyButton({ textareaId, className }: { textareaId: string; className: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
        await navigator.clipboard.writeText(toWhatsApp(el?.value ?? ""));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy for WhatsApp"}
    </button>
  );
}
