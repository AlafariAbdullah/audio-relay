# AudioRelay — PC → iPhone Audio Bridge

Stream audio from your PC to an iPhone via Safari. No app install needed.
WebRTC (low latency) with automatic HTTP stream fallback.

---

## Quick Start

```bash
node server.js
```

Open on iPhone: `http://<your-pc-ip>:3000`

---

## Platform Audio Capture Setup

### macOS
ffmpeg captures system audio via AVFoundation.
To capture what's *playing* (not mic), install a virtual audio device:

1. Install [BlackHole](https://existential.audio/blackhole/) (free)
2. Audio MIDI Setup → create Multi-Output Device (BlackHole + your speakers)
3. Set that as system output
4. List devices to find the right input index:
   ```bash
   ffmpeg -f avfoundation -list_devices true -i "" 2>&1
   ```
5. Edit `getFFmpegArgs()` in server.js → update `":0"` to your BlackHole index

### Windows
Option A — WASAPI loopback (no extra install, edit server.js):
```js
"-f", "wasapi", "-loopback", "1", "-i", "default",
```
Option B — VB-Cable virtual device:
1. Install [VB-Cable](https://vb-audio.com/Cable/) (free)
2. List devices: `ffmpeg -list_devices true -f dshow -i dummy`
3. Update the dshow device name in server.js

### Linux (PulseAudio / PipeWire)
Find your monitor source:
```bash
pactl list short sources | grep monitor
```
Edit server.js → replace `default.monitor` with your source name.
PipeWire users: replace `-f pulse` with `-f pipewire`.

---

## Architecture

```
PC
├─ ffmpeg  ──── captures system audio
│               │
│               └── stdout (MP3) ──→ HTTP /stream   (works now, ~5s latency)
│
└─ server.js
   ├── HTTP server  (serves PWA + /stream endpoint)
   └── WebSocket    (signaling for WebRTC — ready for PC sender)

iPhone Safari PWA
├── Connects WebSocket for signaling
├── Tries WebRTC (if PC sender connected)
└── Falls back to HTTP stream automatically
```

---

## Firewall

Allow inbound TCP on port 3000 from your local network.
Change port: `PORT=8080 node server.js`

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| iPhone can't connect | Must be on same WiFi |
| No audio | Run device listing commands, update server.js |
| WebRTC not working | HTTP fallback works standalone without PC sender |
