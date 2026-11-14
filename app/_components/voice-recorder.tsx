"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { submitVoiceNote } from "../actions";

// Records with the browser's own speech recognition (Chrome, Edge, Safari): the words appear as
// you talk, nothing is uploaded until you press Send, and no extra API key is needed.
// Firefox has no speech recognition, so there you type (or dictate with the phone keyboard's mic).

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getRecognition(): Recognition | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/** Live dictation into a textarea. Used on the voice page and the EOD form. */
export function useDictation(onText: (finalText: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const cb = useRef(onText);
  cb.current = onText;

  useEffect(() => setSupported(!!getRecognition()), []);

  function start() {
    const r = getRecognition();
    if (!r) return;
    setError(null);
    r.lang = "en-IE";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) cb.current(res[0].transcript.trim());
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Microphone access was blocked. Allow it in the browser's site settings and try again.");
        wanted.current = false;
      } else if (e.error !== "no-speech" && e.error !== "aborted") setError(`Speech recognition stopped (${e.error}).`);
    };
    // Browsers stop listening after a pause; restart until the person presses Stop.
    r.onend = () => {
      setInterim("");
      if (wanted.current) {
        try {
          r.start();
          return;
        } catch {}
      }
      setListening(false);
    };
    wanted.current = true;
    rec.current = r;
    r.start();
    setListening(true);
  }

  function stop() {
    wanted.current = false;
    rec.current?.stop();
    setListening(false);
  }

  return { supported, listening, interim, error, start, stop };
}

export function MicButton({ dictation, labels = ["Dictate", "Stop"] }: { dictation: ReturnType<typeof useDictation>; labels?: [string, string] }) {
  if (!dictation.supported) return null;
  return (
    <button
      type="button"
      onClick={dictation.listening ? dictation.stop : dictation.start}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${dictation.listening ? "border-red-300 bg-red-50 text-red-700" : "border-black/15 bg-white hover:bg-black/5"}`}
    >
      <span className={`size-2 rounded-full ${dictation.listening ? "animate-pulse bg-red-600" : "bg-black/40"}`} />
      {dictation.listening ? labels[1] : labels[0]}
    </button>
  );
}

export function VoiceRecorder() {
  const [text, setText] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [state, action, pending] = useActionState(submitVoiceNote, {});
  const dictation = useDictation((t) => setText((prev) => (prev ? `${prev} ${t}` : t)));
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (dictation.listening) timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    else if (timer.current) clearInterval(timer.current);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [dictation.listening]);

  useEffect(() => {
    if (state.ok) {
      setText("");
      setSeconds(0);
    }
  }, [state]);

  const mm = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {dictation.supported ? (
          <button
            type="button"
            onClick={dictation.listening ? dictation.stop : dictation.start}
            className={`inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white ${dictation.listening ? "bg-red-600" : "bg-brand"} `}
          >
            <span className={`size-3 rounded-full bg-white ${dictation.listening ? "animate-pulse" : ""}`} />
            {dictation.listening ? "Stop recording" : seconds ? "Keep recording" : "Start recording"}
          </button>
        ) : (
          <p className="text-sm text-black/60">This browser can&rsquo;t transcribe speech. Use Chrome, Edge or Safari, or type below (on a phone, the keyboard&rsquo;s mic button works too).</p>
        )}
        {(dictation.listening || seconds > 0) && <span className="num text-sm text-black/60">{mm}</span>}
      </div>
      {dictation.error && <p className="text-sm text-red-600">{dictation.error}</p>}
      <textarea
        name="transcript"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder="Talk through the business: each client, the team, money, problems, what you need decided. The words appear here as you speak; fix anything it misheard before sending."
        className="w-full rounded-md border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
      />
      {dictation.interim && <p className="-mt-2 text-sm text-black/40 italic">{dictation.interim}</p>}
      <input type="hidden" name="durationSec" value={seconds} />
      <div className="flex items-center gap-3">
        <button disabled={pending || dictation.listening || text.trim().length < 20} className="inline-flex items-center justify-center rounded-md bg-black px-3 py-2 text-sm font-medium text-white hover:bg-black/80 disabled:opacity-50">
          {pending ? "Sending…" : "Send for a business update"}
        </button>
        <span className="text-xs text-black/50">{text.trim() ? `${text.trim().split(/\s+/).length} words` : ""}</span>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.ok && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Sent. The update appears below in a minute or two; refresh to see it.</p>}
    </form>
  );
}

/** Textarea with a dictate button, for the EOD form. */
export function DictateTextarea({ name, defaultValue, rows = 4, placeholder, required }: { name: string; defaultValue?: string; rows?: number; placeholder?: string; required?: boolean }) {
  const [text, setText] = useState(defaultValue ?? "");
  const dictation = useDictation((t) => setText((prev) => (prev ? `${prev} ${t}` : t)));
  return (
    <div>
      <div className="relative">
        <textarea
          name={name}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          required={required}
          className="w-full rounded-md border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        <div className="absolute right-2 bottom-3">
          <MicButton dictation={dictation} />
        </div>
      </div>
      {dictation.interim && <p className="text-xs text-black/40 italic">{dictation.interim}</p>}
      {dictation.error && <p className="text-xs text-red-600">{dictation.error}</p>}
    </div>
  );
}
