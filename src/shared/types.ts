export type PlaybackStatus =
  | "Playing"
  | "Paused"
  | "Stopped"
  | "Changing"
  | "Closed"
  | "Opened"
  | "Unknown";

export interface MediaSessionInfo {
  id: string;
  app: string;
  appId: string;
  title: string;
  artist: string;
  album: string;
  status: PlaybackStatus;
  positionMs: number;
  durationMs: number;
  canPlay: boolean;
  canPause: boolean;
  canSkipNext: boolean;
  canSkipPrevious: boolean;
  artwork: string | null;
}

export interface HostState {
  volume: number;
  muted: boolean;
  brightness: number | null;
  sessions: MediaSessionInfo[];
  activeId: string | null;
}

export type HostCommand =
  | { action: "tick" }
  | { action: "toggle"; id?: string }
  | { action: "play"; id?: string }
  | { action: "pause"; id?: string }
  | { action: "next"; id?: string }
  | { action: "previous"; id?: string }
  | { action: "seek"; id?: string; positionMs: number }
  | { action: "volume"; level: number }
  | { action: "mute"; muted?: boolean }
  | { action: "key"; keys: string }
  | { action: "lock" }
  | { action: "screens-off" }
  | { action: "brightness"; level: number };

export interface BootstrapResponse {
  paired: boolean;
  local: boolean;
  pin?: string;
  urls: string[];
  qrSvg?: string;
}
