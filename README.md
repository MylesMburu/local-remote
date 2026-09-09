# Local Remote

Phone remote for your Windows PC. Play/pause YouTube and Spotify, skip tracks, change volume, and send a few extra keys — as long as the phone and PC are on the same Wi‑Fi.

## Run it

```bash
npm install
npm start
```

Leave that window open. It prints a PIN, a LAN address, and a QR code.

To start it automatically when you sign in to Windows (no terminal):

```bash
npm run autostart
```

Undo with `npm run autostart:off`. The PC still has to be on and you have to be signed in — the phone cannot reach it if this process is not running.

1. On your phone, join the **same Wi‑Fi** as the PC.
2. Scan the QR code (or type the `http://192.168…:8787` address).
3. Enter the PIN.
4. Add to Home Screen (Safari share sheet, or Chrome menu) so it opens like an app.

The first time Windows may ask about the firewall — allow it on **private** networks.

## What it controls

- System media: play/pause, next, previous, seek, now playing (Spotify, Chrome/YouTube, Edge, and anything else that shows on the Windows media overlay)
- PC volume and mute
- YouTube keyboard shortcuts to the focused window (J/L, F, captions, next video)
- Lock PC, turn screens off, laptop brightness when available

Keep YouTube focused on the PC if you want the YouTube key pad. Media buttons work even when the player is in the background.
