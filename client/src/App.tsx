import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapResponse, HostCommand, HostState, MediaSessionInfo } from "@shared/types";

const TOKEN_KEY = "local-remote-token";

function vibe(ms = 12) {
  navigator.vibrate?.(ms);
}

function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const t = token();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new Error("unpaired");
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || res.statusText);
  }
  return (await res.json()) as T;
}

function fmtTime(ms: number): string {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

const empty: HostState = {
  volume: 0,
  muted: false,
  brightness: null,
  sessions: [],
  activeId: null,
};

type Tab = "media" | "keys" | "system";

export function App() {
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [pin, setPin] = useState("");
  const [pairError, setPairError] = useState("");
  const [state, setState] = useState<HostState>(empty);
  const [tab, setTab] = useState<Tab>("media");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [installHint, setInstallHint] = useState(false);
  const seeking = useRef(false);
  const volTimer = useRef(0);
  const brightTimer = useRef(0);

  const paired = Boolean(boot?.paired || boot?.local || token());

  const refreshBoot = useCallback(async () => {
    const data = await api<BootstrapResponse>("/api/bootstrap");
    setBoot(data);
    return data;
  }, []);

  useEffect(() => {
    refreshBoot().catch(() => setBoot({ paired: false, local: false, urls: [] }));
  }, [refreshBoot]);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    setInstallHint(!standalone);
  }, []);

  useEffect(() => {
    if (!paired) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const t = token();
      const q = t ? `?token=${encodeURIComponent(t)}` : "";
      ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
      ws.onopen = () => {
        retry = 0;
        setOnline(true);
      };
      ws.onmessage = (ev) => {
        if (seeking.current) return;
        const msg = JSON.parse(ev.data) as { type: string; state: HostState };
        if (msg.type === "state") setState(msg.state);
      };
      ws.onclose = () => {
        setOnline(false);
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 400 * retry);
      };
    };

    api<HostState>("/api/state").then(setState).catch(() => undefined);
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [paired]);

  const send = useCallback(async (command: HostCommand, haptic = true) => {
    if (haptic) vibe();
    const next = await api<HostState>("/api/command", { method: "POST", body: JSON.stringify(command) });
    setState(next);
  }, []);

  function slideVolume(level: number) {
    setState((cur) => ({ ...cur, volume: level, muted: false }));
    window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => {
      void send({ action: "volume", level }, false);
    }, 90);
  }

  function slideBrightness(level: number) {
    setState((cur) => ({ ...cur, brightness: level }));
    window.clearTimeout(brightTimer.current);
    brightTimer.current = window.setTimeout(() => {
      void send({ action: "brightness", level }, false);
    }, 90);
  }

  const session: MediaSessionInfo | null = useMemo(() => {
    if (state.sessions.length === 0) return null;
    const id = pickedId && state.sessions.some((s) => s.id === pickedId) ? pickedId : state.activeId;
    return state.sessions.find((s) => s.id === id) ?? state.sessions[0] ?? null;
  }, [state, pickedId]);

  async function submitPin(value: string) {
    setPairError("");
    try {
      const res = await api<{ token: string }>("/api/pair", { method: "POST", body: JSON.stringify({ pin: value }) });
      localStorage.setItem(TOKEN_KEY, res.token);
      setPin("");
      await refreshBoot();
    } catch {
      setPairError("That PIN does not match the one on your PC.");
      setPin("");
    }
  }

  if (!boot) {
    return (
      <main className="shell">
        <p className="muted">Looking for your PC…</p>
      </main>
    );
  }

  if (!paired) {
    return (
      <main className="shell pair">
        <p className="eyebrow">Same Wi‑Fi as your PC</p>
        <h1>Local Remote</h1>
        <p className="lede">Enter the 6‑digit PIN shown in the Local Remote window on your computer.</p>
        <form
          className="pin-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length === 6) void submitPin(pin);
          }}
        >
          <input
            className="pin"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={pin}
            placeholder="000000"
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, "").slice(0, 6);
              setPin(next);
              if (next.length === 6) void submitPin(next);
            }}
          />
        </form>
        {pairError ? <p className="error">{pairError}</p> : null}
      </main>
    );
  }

  const playing = session?.status === "Playing";

  return (
    <main className="shell remote">
      <header className="top">
        <div>
          <p className="eyebrow">Local Remote</p>
          <h1>{session?.app ?? "Nothing playing"}</h1>
        </div>
        <span className={`dot ${online ? "on" : ""}`}>{online ? "Live" : "Reconnecting"}</span>
      </header>

      {boot.local ? (
        <section className="setup">
          <div className="qr" dangerouslySetInnerHTML={{ __html: boot.qrSvg ?? "" }} />
          <div>
            <p className="eyebrow">On your phone</p>
            <p className="url">{boot.urls[0]}</p>
            <p className="pin-show">{boot.pin}</p>
            <p className="hint">Open that address, enter the PIN, then Add to Home Screen.</p>
          </div>
        </section>
      ) : null}

      {installHint && !boot.local ? (
        <p className="install">
          Add to Home Screen for a full-screen remote: Share / browser menu → Add to Home Screen.
        </p>
      ) : null}

      {state.sessions.length > 1 ? (
        <div className="sessions">
          {state.sessions.map((s) => (
            <button
              key={s.id}
              className={s.id === session?.id ? "chip on" : "chip"}
              onClick={() => setPickedId(s.id)}
            >
              {s.app}
            </button>
          ))}
        </div>
      ) : null}

      <nav className="tabs">
        {(["media", "keys", "system"] as Tab[]).map((id) => (
          <button key={id} className={tab === id ? "tab on" : "tab"} onClick={() => setTab(id)}>
            {id === "media" ? "Now playing" : id === "keys" ? "YouTube keys" : "System"}
          </button>
        ))}
      </nav>

      {tab === "media" ? (
        <section className="now">
          <div className="art-wrap">
            {session?.artwork ? (
              <img className="art" src={session.artwork} alt="" />
            ) : (
              <div className="art fallback" aria-hidden>
                <span>{playing ? "♪" : "❚❚"}</span>
              </div>
            )}
          </div>
          <h2 className="title">{session?.title || "Start something on the PC"}</h2>
          <p className="artist">{session?.artist || "Spotify, YouTube, or any media app"}</p>

          <label className="seek">
            <input
              type="range"
              min={0}
              max={Math.max(session?.durationMs ?? 0, 1)}
              value={session?.positionMs ?? 0}
              disabled={!session}
              onPointerDown={() => {
                seeking.current = true;
              }}
              onPointerUp={(e) => {
                seeking.current = false;
                void send({ action: "seek", id: session?.id, positionMs: Number(e.currentTarget.value) });
              }}
              onChange={(e) => {
                if (!session) return;
                setState((cur) => ({
                  ...cur,
                  sessions: cur.sessions.map((s) =>
                    s.id === session.id ? { ...s, positionMs: Number(e.target.value) } : s,
                  ),
                }));
              }}
            />
            <span>
              <em>{fmtTime(session?.positionMs ?? 0)}</em>
              <em>{fmtTime(session?.durationMs ?? 0)}</em>
            </span>
          </label>

          <div className="transport">
            <button className="ghost" onClick={() => void send({ action: "previous", id: session?.id })} aria-label="Previous">
              <SkipPrev />
            </button>
            <button className="play" onClick={() => void send({ action: "toggle", id: session?.id })} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause /> : <Play />}
            </button>
            <button className="ghost" onClick={() => void send({ action: "next", id: session?.id })} aria-label="Next">
              <SkipNext />
            </button>
          </div>

          <label className="vol">
            <button className="icon-btn" onClick={() => void send({ action: "mute" })} aria-label="Mute">
              {state.muted ? <Muted /> : <Speaker />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={state.muted ? 0 : state.volume}
              onChange={(e) => slideVolume(Number(e.target.value))}
            />
            <b>{state.muted ? "Mute" : `${state.volume}`}</b>
          </label>
        </section>
      ) : null}

      {tab === "keys" ? (
        <section className="grid-panel">
          <p className="hint">These go to whatever is focused on the PC. Click the YouTube tab first, then use them from here.</p>
          <div className="grid">
            <KeyBtn label="Play / pause" sub="K / Space" onClick={() => void send({ action: "key", keys: "k" })} />
            <KeyBtn label="Back 10s" sub="J" onClick={() => void send({ action: "key", keys: "j" })} />
            <KeyBtn label="Forward 10s" sub="L" onClick={() => void send({ action: "key", keys: "l" })} />
            <KeyBtn label="Fullscreen" sub="F" onClick={() => void send({ action: "key", keys: "f" })} />
            <KeyBtn label="Mute video" sub="M" onClick={() => void send({ action: "key", keys: "m" })} />
            <KeyBtn label="Captions" sub="C" onClick={() => void send({ action: "key", keys: "c" })} />
            <KeyBtn label="Next video" sub="Shift+N" onClick={() => void send({ action: "key", keys: "shift+n" })} />
            <KeyBtn label="Previous video" sub="Shift+P" onClick={() => void send({ action: "key", keys: "shift+p" })} />
            <KeyBtn label="←" sub="Arrow" onClick={() => void send({ action: "key", keys: "left" })} />
            <KeyBtn label="→" sub="Arrow" onClick={() => void send({ action: "key", keys: "right" })} />
          </div>
        </section>
      ) : null}

      {tab === "system" ? (
        <section className="grid-panel">
          <div className="grid">
            <KeyBtn label="Lock PC" sub="Win + L" onClick={() => void send({ action: "lock" })} />
            <KeyBtn label="Screens off" sub="Displays sleep" onClick={() => void send({ action: "screens-off" })} />
            <KeyBtn label="Volume up" sub="System" onClick={() => void send({ action: "key", keys: "volup" })} />
            <KeyBtn label="Volume down" sub="System" onClick={() => void send({ action: "key", keys: "voldown" })} />
          </div>
          {state.brightness != null ? (
            <label className="vol">
              <span className="icon-btn" aria-hidden>
                <Sun />
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={state.brightness}
                onChange={(e) => slideBrightness(Number(e.target.value))}
              />
              <b>{state.brightness}%</b>
            </label>
          ) : (
            <p className="hint">Brightness is available on laptops that expose a software backlight.</p>
          )}
        </section>
      ) : null}
    </main>
  );
}

function KeyBtn({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button className="key" onClick={onClick}>
      <strong>{label}</strong>
      <span>{sub}</span>
    </button>
  );
}

function Play() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M8 5.2v13.6c0 .7.8 1.1 1.4.7l10.2-6.8c.6-.4.6-1.2 0-1.6L9.4 4.5C8.8 4.1 8 4.5 8 5.2z" />
    </svg>
  );
}

function Pause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="5" width="4.5" height="14" rx="1.4" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1.4" />
    </svg>
  );
}

function SkipPrev() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 5h2.2v14H6zM18.2 5.3L9 12l9.2 6.7V5.3z" />
    </svg>
  );
}

function SkipNext() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M15.8 5H18v14h-2.2zM5.8 5.3V18.7L15 12 5.8 5.3z" />
    </svg>
  );
}

function Speaker() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 9.5h3.1L12 5.8v12.4L7.1 14.5H4V9.5zm11.2.2a3.2 3.2 0 010 4.6M15.2 7a6 6 0 010 10" />
    </svg>
  );
}

function Muted() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 9.5h3.1L12 5.8v12.4L7.1 14.5H4V9.5zM16 9l5 5M21 9l-5 5" />
    </svg>
  );
}

function Sun() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2.2M12 18.8V21M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M3 12h2.2M18.8 12H21M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </svg>
  );
}
