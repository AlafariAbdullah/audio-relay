// Run once to generate PNG icons: node generate-icons.js
// Requires: npm install canvas
const { createCanvas } = require("canvas");
const fs = require("fs");

function makeIcon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  const cx = size / 2, cy = size / 2, r = size / 2;

  // Background
  ctx.fillStyle = "#0a0a0f";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

  // Gradient orb
  const grd = ctx.createRadialGradient(cx, cy, size * 0.05, cx, cy, size * 0.38);
  grd.addColorStop(0, "#7c6af7");
  grd.addColorStop(1, "#f76ac8");
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.35, 0, Math.PI * 2); ctx.fill();

  // Waveform bars
  const bars = 5;
  const bw = size * 0.055;
  const gap = size * 0.04;
  const heights = [0.18, 0.28, 0.38, 0.28, 0.18];
  const totalW = bars * bw + (bars - 1) * gap;
  const startX = cx - totalW / 2;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < bars; i++) {
    const bh = size * heights[i];
    const bx = startX + i * (bw + gap);
    const by = cy - bh / 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, bw / 2);
    ctx.fill();
  }

  return c.toBuffer("image/png");
}

fs.writeFileSync("icon-192.png", makeIcon(192));
fs.writeFileSync("icon-512.png", makeIcon(512));
console.log("Icons generated.");
