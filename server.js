/**
 * AudioRelay - Cross-platform PC → iPhone audio bridge
 * Supports: macOS, Windows, Linux
 * Transport: WebRTC (primary) + HTTP stream (fallback)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const PLATFORM = os.platform(); // darwin | win32 | linux

// ── ffmpeg audio source per platform ─────────────────────────────────────────
function getFFmpegArgs() {
  switch (PLATFORM) {
    case "darwin":
      // macOS: BlackHole or system audio via avfoundation
      // List devices with: ffmpeg -f avfoundation -list_devices true -i ""
      return [
        "-f", "avfoundation",
        "-i", ":0",                   // :0 = default audio input (change to virtual device if needed)
        "-ac", "2",
        "-ar", "44100",
      ];

    case "win32":
      // Windows: DirectShow — lists devices with:
      // ffmpeg -list_devices true -f dshow -i dummy
      return [
        "-f", "dshow",
        "-i", "audio=virtual-audio-capturer",  // or your device name
        "-ac", "2",
        "-ar", "44100",
      ];

    case "linux":
      // Linux: PulseAudio monitor (captures what's playing)
      // Find monitor source: pactl list short sources | grep monitor
      return [
        "-f", "pulse",
        "-i", "default.monitor",      // change to your monitor source
        "-ac", "2",
        "-ar", "44100",
      ];

    default:
      throw new Error(`Unsupported platform: ${PLATFORM}`);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let ffmpegProcess = null;
let audioClients = new Set();          // HTTP stream listeners
let webrtcClients = new Map();         // id → { res, ws-like send fn }
let isStreaming = false;
let wsClients = new Set();             // WebSocket signaling clients

// ── HTTP stream buffer (for fallback) ─────────────────────────────────────────
const MIME_TYPE = "audio/mpeg";

function startFFmpeg() {
  if (ffmpegProcess) return;

  const inputArgs = getFFmpegArgs();

  ffmpegProcess = spawn("ffmpeg", [
    ...inputArgs,
    // Output 1: MP3 for HTTP stream
    "-codec:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    "pipe:1",                          // stdout → HTTP stream clients
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  ffmpegProcess.stdout.on("data", (chunk) => {
    // Broadcast to all HTTP stream clients
    for (const client of audioClients) {
      try { client.write(chunk); } catch { audioClients.delete(client); }
    }
  });

  ffmpegProcess.stderr.on("data", (d) => {
    // ffmpeg logs to stderr — suppress unless debugging
    // console.error("[ffmpeg]", d.toString());
  });

  ffmpegProcess.on("exit", (code) => {
    console.log(`[ffmpeg] exited (${code})`);
    ffmpegProcess = null;
    isStreaming = false;
    // Notify all WebSocket clients
    broadcast({ type: "stream_stopped" });
  });

  isStreaming = true;
  console.log(`[ffmpeg] started (${PLATFORM})`);
  broadcast({ type: "stream_started" });
}

function stopFFmpeg() {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGTERM");
    ffmpegProcess = null;
  }
  isStreaming = false;
}

// ── WebSocket (manual upgrade — no deps) ─────────────────────────────────────
// Minimal WebSocket server implementation (no external library needed)
const crypto = require("crypto");

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + (masked ? 4 : 0) + len) return null;
  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4); offset += 4;
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + len);
  }
  return payload.toString("utf8");
}

function wsSendFrame(socket, message) {
  const data = Buffer.from(message, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, data])); } catch {}
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const s of wsClients) wsSendFrame(s, msg);
}

// ── Signaling ─────────────────────────────────────────────────────────────────
// Simple: one PC broadcaster, N iPhone receivers
// PC sends offer → server relays to all phones
// Phone sends answer → server relays to PC
// ICE candidates relayed both ways

let pcSocket = null;   // the PC's WebSocket (for WebRTC signaling)

function handleSignaling(socket, message) {
  let msg;
  try { msg = JSON.parse(message); } catch { return; }

  switch (msg.type) {
    case "register_pc":
      pcSocket = socket;
      console.log("[signal] PC registered");
      wsSendFrame(socket, JSON.stringify({ type: "registered", role: "pc" }));
      break;

    case "register_phone":
      console.log("[signal] Phone connected");
      // Tell PC a new phone connected (PC will send offer)
      if (pcSocket) wsSendFrame(pcSocket, JSON.stringify({ type: "phone_connected", phoneId: socket._id }));
      wsSendFrame(socket, JSON.stringify({ type: "registered", role: "phone", streaming: isStreaming }));
      break;

    case "request_offer":
      // Phone asking PC to send an offer
      if (pcSocket) {
        wsSendFrame(pcSocket, JSON.stringify({ type: "phone_wants_offer", phoneId: socket._id }));
      } else {
        wsSendFrame(socket, JSON.stringify({ type: "no_pc" }));
      }
      break;

    case "offer":
      // PC → targeted phone (or all phones)
      if (socket === pcSocket) {
        if (msg.target) {
          for (const s of wsClients) {
            if (s._id === msg.target) { wsSendFrame(s, JSON.stringify(msg)); break; }
          }
        } else {
          for (const s of wsClients) {
            if (s !== pcSocket) wsSendFrame(s, JSON.stringify(msg));
          }
        }
      }
      break;

    case "answer":
      // Phone → PC
      if (socket !== pcSocket && pcSocket) {
        wsSendFrame(pcSocket, JSON.stringify({ ...msg, sourceId: socket._id }));
      }
      break;

    case "ice":
      if (socket === pcSocket) {
        // PC → targeted phone
        if (msg.target) {
          for (const s of wsClients) {
            if (s._id === msg.target) { wsSendFrame(s, JSON.stringify(msg)); break; }
          }
        }
      } else if (pcSocket) {
        // Phone → PC
        wsSendFrame(pcSocket, JSON.stringify({ ...msg, sourceId: socket._id }));
      }
      break;

    case "start_stream":
      startFFmpeg();
      break;

    case "stop_stream":
      stopFFmpeg();
      break;

    case "get_status":
      wsSendFrame(socket, JSON.stringify({ type: "status", streaming: isStreaming, platform: PLATFORM }));
      break;
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── API: stream control ────────────────────────────────────────────────────
  if (url.pathname === "/api/start") {
    startFFmpeg();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, streaming: isStreaming }));
    return;
  }

  if (url.pathname === "/api/stop") {
    stopFFmpeg();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, streaming: false }));
    return;
  }

  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ streaming: isStreaming, platform: PLATFORM, clients: audioClients.size }));
    return;
  }

  // ── HTTP audio stream (fallback) ───────────────────────────────────────────
  if (url.pathname === "/stream") {
    res.writeHead(200, {
      "Content-Type": MIME_TYPE,
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    audioClients.add(res);
    if (!isStreaming) startFFmpeg();
    req.on("close", () => audioClients.delete(res));
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
  let pathname = url.pathname;
  if (pathname === "/") {
    const ua = req.headers["user-agent"] || "";
    const isMobile = /iphone|ipad|ipod|android/i.test(ua);
    pathname = isMobile ? "/index.html" : "/broadcast.html";
  }
  else if (!path.extname(pathname)) pathname += ".html";   // /broadcast → /broadcast.html
  let filePath = path.join(__dirname, "public", pathname);
  const ext = path.extname(filePath);
  const mimeTypes = {
    ".html": "text/html",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".json": "application/json",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
    ".webmanifest": "application/manifest+json",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ── WebSocket upgrade ─────────────────────────────────────────────────────────
let _idCounter = 1;
server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  wsHandshake(req, socket);
  socket._id = _idCounter++;
  wsClients.add(socket);
  console.log(`[ws] client connected (id=${socket._id})`);

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const msg = wsParseFrame(buf);
    if (msg !== null) {
      buf = Buffer.alloc(0);
      handleSignaling(socket, msg);
    }
  });

  socket.on("close", () => {
    wsClients.delete(socket);
    if (socket === pcSocket) { pcSocket = null; console.log("[signal] PC disconnected"); }
    console.log(`[ws] client disconnected (id=${socket._id})`);
  });

  socket.on("error", () => wsClients.delete(socket));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  const ifaces = os.networkInterfaces();
  let localIP = "localhost";
  for (const name of Object.values(ifaces)) {
    for (const iface of name) {
      if (iface.family === "IPv4" && !iface.internal) { localIP = iface.address; break; }
    }
  }
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║         AudioRelay Server            ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Platform : ${PLATFORM.padEnd(24)}║`);
  console.log(`║  Local    : http://localhost:${PORT}    ║`);
  console.log(`║  Network  : http://${localIP}:${PORT}   ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Open on iPhone:                     ║`);
  console.log(`║  http://${localIP}:${PORT}            ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

process.on("SIGTERM", () => { stopFFmpeg(); process.exit(0); });
process.on("SIGINT",  () => { stopFFmpeg(); process.exit(0); });
