import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

const W = 1200, H = 627;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// Background gradient
const bg = ctx.createLinearGradient(0, 0, W, H);
bg.addColorStop(0, '#0a0a0a');
bg.addColorStop(0.5, '#1a1a2e');
bg.addColorStop(1, '#16213e');
ctx.fillStyle = bg;
ctx.fillRect(0, 0, W, H);

// Subtle grid
ctx.strokeStyle = 'rgba(255,255,255,0.04)';
ctx.lineWidth = 1;
for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

// Glow effects
function drawGlow(x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
drawGlow(1050, 80, 250, 'rgba(217,119,6,0.12)');
drawGlow(150, 550, 250, 'rgba(124,58,237,0.10)');

// Tag
ctx.fillStyle = 'rgba(217,119,6,0.15)';
roundRect(ctx, 60, 100, 230, 32, 4);
ctx.fill();
ctx.strokeStyle = 'rgba(217,119,6,0.4)';
ctx.lineWidth = 1;
roundRect(ctx, 60, 100, 230, 32, 4);
ctx.stroke();
ctx.fillStyle = '#f59e0b';
ctx.font = '600 12px sans-serif';
ctx.letterSpacing = '2px';
ctx.fillText('ARCHITECTURE DECISION', 74, 121);

// Title
ctx.fillStyle = '#f1f1f1';
ctx.font = 'bold 44px sans-serif';
ctx.fillText('Stop fighting the code.', 60, 195);
ctx.fillStyle = '#f59e0b';
ctx.font = 'bold 44px sans-serif';
ctx.fillText('Rethink the question.', 60, 248);

// Subtitle
ctx.fillStyle = '#9ca3af';
ctx.font = '18px sans-serif';
const subtitle = "When Claude Code couldn't carry the vision, I didn't";
const subtitle2 = "push harder — I asked it to help me step back.";
const subtitle3 = "ADR-013 shipped from my phone.";
ctx.fillText(subtitle, 60, 300);
ctx.fillText(subtitle2, 60, 324);
ctx.fillText(subtitle3, 60, 348);

// Flow diagram - right side
const rx = 680;

// "BEFORE" label
ctx.fillStyle = '#6b7280';
ctx.font = '600 11px sans-serif';
ctx.fillText('BEFORE: 2,500 LINES OF ROUTING', rx, 140);

// Before flow nodes
drawNode(ctx, rx, 155, 'Claude Code', '#d97706', 'rgba(217,119,6,0.2)');
drawArrow(ctx, rx + 120, 172);
drawNode(ctx, rx + 148, 155, 'TypeScript', '#7c3aed', 'rgba(124,58,237,0.15)');
drawArrow(ctx, rx + 248, 172);
drawNode(ctx, rx + 276, 155, 'Complexity', '#ef4444', 'rgba(239,68,68,0.12)');

// Down arrow + "rethink"
ctx.fillStyle = '#4b5563';
ctx.font = '16px sans-serif';
ctx.fillText('▼', rx + 180, 215);
ctx.fillStyle = '#6b7280';
ctx.font = '13px sans-serif';
ctx.fillText('rethink', rx + 200, 215);

// "AFTER" label
ctx.fillStyle = '#6b7280';
ctx.font = '600 11px sans-serif';
ctx.fillText('AFTER: VISUAL ORCHESTRATION', rx, 248);

// After flow nodes
drawNode(ctx, rx, 263, 'Claude Code', '#d97706', 'rgba(217,119,6,0.2)');
drawArrow(ctx, rx + 120, 280);
drawNode(ctx, rx + 148, 263, 'n8n', '#ec4899', 'rgba(234,76,137,0.15)');
drawArrow(ctx, rx + 210, 280);
drawNode(ctx, rx + 238, 263, 'fabric-*', '#7c3aed', 'rgba(124,58,237,0.15)');

// Down arrow
ctx.fillStyle = '#4b5563';
ctx.font = '16px sans-serif';
ctx.fillText('▼', rx + 180, 320);

// Result nodes
drawNode(ctx, rx + 60, 335, 'ADR-013', '#10b981', 'rgba(16,185,129,0.15)');
drawArrow(ctx, rx + 170, 352);
drawNode(ctx, rx + 198, 335, 'Committed & Pushed', '#10b981', 'rgba(16,185,129,0.15)');

// Divider line
ctx.strokeStyle = 'rgba(255,255,255,0.06)';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(rx, 400);
ctx.lineTo(rx + 440, 400);
ctx.stroke();

// Mobile callout
ctx.fillStyle = '#9ca3af';
ctx.font = '14px sans-serif';
ctx.fillText('Built, committed & pushed from mobile', rx + 40, 435);
ctx.fillStyle = '#f59e0b';
ctx.fillText('via Claude Code', rx + 120, 458);

// Bottom bar
ctx.fillStyle = 'rgba(0,0,0,0.5)';
ctx.fillRect(0, H - 50, W, 50);
ctx.fillStyle = '#6b7280';
ctx.font = '500 13px sans-serif';
ctx.fillText('git-fabric/chat', 60, H - 22);
ctx.fillStyle = '#9ca3af';
ctx.font = '600 12px sans-serif';
const tools = ['CLAUDE CODE', 'N8N', 'MCP', 'QDRANT'];
let tx = 420;
for (const t of tools) {
  ctx.fillText(t, tx, H - 22);
  tx += ctx.measureText(t).width + 28;
}
ctx.fillStyle = '#6b7280';
ctx.font = '500 13px sans-serif';
ctx.fillText('ry-ops.dev', W - 140, H - 22);

// Write PNG
const buf = canvas.toBuffer('image/png');
writeFileSync('/home/user/chat/linkedin-post.png', buf);
console.log('Written: linkedin-post.png (' + buf.length + ' bytes)');

// Helper functions
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawNode(ctx, x, y, text, borderColor, bgColor) {
  const w = ctx.measureText(text).width + 28;
  ctx.fillStyle = bgColor;
  roundRect(ctx, x, y, w, 34, 6);
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, 34, 6);
  ctx.stroke();
  ctx.fillStyle = borderColor;
  ctx.font = '600 13px sans-serif';
  ctx.fillText(text, x + 14, y + 22);
}

function drawArrow(ctx, x, y) {
  ctx.fillStyle = '#4b5563';
  ctx.font = '16px sans-serif';
  ctx.fillText('→', x, y);
}
