/**
 * Where Melodi is running, and how to reach its backend.
 *
 * In the desktop app the Rust backend is called through Tauri IPC. On the web
 * the same commands go to melodi-server as `POST /api/<command>` with the
 * same JSON arguments, so the rest of the UI doesn't care which it is.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isWeb = !isDesktop;

/** melodi-server's address; empty means the page's own origin. */
const API_BASE = ((import.meta.env.VITE_MELODI_API as string | undefined) ?? "").replace(/\/$/, "");

// ---- events --------------------------------------------------------------------

type Handler = (e: { payload: unknown }) => void;
const localHandlers = new Map<string, Set<Handler>>();

function emitLocal(event: string, payload: unknown) {
  localHandlers.get(event)?.forEach((h) => h({ payload }));
}

/** Like Tauri's `listen`: the desktop backend's events, or the web transport's. */
export function listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> {
  if (isDesktop) return tauriListen<T>(event, handler);
  const set = localHandlers.get(event) ?? new Set();
  localHandlers.set(event, set);
  const h = handler as Handler;
  set.add(h);
  return Promise.resolve(() => set.delete(h));
}

// ---- commands ------------------------------------------------------------------

/** Language / region sent with every web request (the server serves everyone). */
let locale: { hl: string; gl: string } | null = null;

/** Commands that answer with NDJSON progress lines, then a result line. */
const STREAMED = new Set(["import_spotify", "import_tracks"]);

/** Call a backend command, like Tauri's `invoke`. Rejects with a message string. */
export async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) return invoke<T>(cmd, args);

  if (cmd === "set_locale") {
    locale = { hl: String(args.hl), gl: String(args.gl) };
    return undefined as T;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (locale) {
    headers["X-Melodi-Hl"] = locale.hl;
    headers["X-Melodi-Gl"] = locale.gl;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/${cmd}`, { method: "POST", headers, body: JSON.stringify(args) });
  } catch {
    throw "Can't reach the Melodi server — check your connection";
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw (body && typeof body.error === "string" ? body.error : `Server error (${res.status})`);
  }
  if (STREAMED.has(cmd)) return readStreamed<T>(res);
  return res.json() as Promise<T>;
}

async function readStreamed<T>(res: Response): Promise<T> {
  const reader = res.body?.getReader();
  if (!reader) throw "Server error";
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.progress) emitLocal("import-progress", msg.progress);
      else if ("result" in msg) return msg.result as T;
      else if (msg.error) throw msg.error;
    }
    if (done) throw "The server stopped answering";
  }
}

// ---- small desktop/web differences --------------------------------------------

export async function openExternal(url: string) {
  if (isDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    return openUrl(url);
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function appVersion(): Promise<string> {
  if (isDesktop) {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  }
  return __APP_VERSION__;
}
