/* ============================================================
   Openbot — cursor-following falling stars
   Canvas particle system. Stars spawn at cursor, fall, fade.
   Click spawns a denser burst.
   ============================================================ */

(() => {
'use strict';

const canvas = document.getElementById('star-canvas');
if (!canvas) return;
const ctx = canvas.getContext('2d');

let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize, { passive: true });
resize();

const particles = [];
let mouseX = W / 2, mouseY = -50;
let lastMouseX = mouseX, lastMouseY = mouseY;
let moving = false;
let moveTimer = null;

// pink palette
const COLORS = [
  '255, 20, 147',
  '255, 105, 180',
  '255, 182, 233',
  '255, 255, 255',
];

function spawn(x, y, opts = {}) {
  const count = opts.count ?? 1;
  const speedScale = opts.speed ?? 1;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * 1.4 + 0.4;
    particles.push({
      x: x + (Math.random() - 0.5) * 4,
      y: y + (Math.random() - 0.5) * 4,
      vx: Math.cos(angle) * 0.3 * speedScale + (Math.random() - 0.5) * 0.6,
      vy: Math.sin(angle) * 0.2 * speedScale + 0.4 + Math.random() * 0.8,
      g: 0.04 + Math.random() * 0.03,    // gravity
      size: 1 + Math.random() * 2.2,
      life: 1,
      decay: 0.008 + Math.random() * 0.012,
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.1 + Math.random() * 0.15,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      trail: r > 1.0,
    });
  }
  // hard cap to prevent runaway memory
  if (particles.length > 600) particles.splice(0, particles.length - 600);
}

window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  moving = true;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => { moving = false; }, 120);
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) return;
  mouseX = t.clientX; mouseY = t.clientY;
  moving = true;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => { moving = false; }, 120);
}, { passive: true });

window.addEventListener('click', (e) => {
  spawn(e.clientX, e.clientY, { count: 14, speed: 2 });
});

// occasional ambient stars when idle
let ambientTimer = 0;

function tick() {
  // fade trail (very subtle so trails don't dominate)
  ctx.fillStyle = 'rgba(5, 2, 8, 0.18)';
  ctx.fillRect(0, 0, W, H);

  // spawn on movement
  if (moving) {
    const dx = mouseX - lastMouseX;
    const dy = mouseY - lastMouseY;
    const dist = Math.hypot(dx, dy);
    const n = Math.min(4, Math.max(1, Math.floor(dist / 8)));
    spawn(mouseX, mouseY, { count: n });
  }
  lastMouseX = mouseX; lastMouseY = mouseY;

  // ambient drifting stars in upper portion
  ambientTimer++;
  if (ambientTimer > 7) {
    ambientTimer = 0;
    if (particles.length < 80) {
      spawn(Math.random() * W, -10, { count: 1, speed: 0.5 });
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.g;
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    p.twinkle += p.twinkleSpeed;

    if (p.life <= 0 || p.y > H + 40 || p.x < -20 || p.x > W + 20) {
      particles.splice(i, 1);
      continue;
    }

    const tw = 0.6 + 0.4 * Math.sin(p.twinkle);
    const alpha = p.life * tw;

    // soft glow
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4);
    grad.addColorStop(0, `rgba(${p.color}, ${alpha})`);
    grad.addColorStop(0.4, `rgba(${p.color}, ${alpha * 0.35})`);
    grad.addColorStop(1, `rgba(${p.color}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
    ctx.fill();

    // bright core
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.85})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
    ctx.fill();

    // tiny tail for larger stars
    if (p.trail) {
      ctx.strokeStyle = `rgba(${p.color}, ${alpha * 0.5})`;
      ctx.lineWidth = p.size * 0.6;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 3, p.y - p.vy * 3);
      ctx.stroke();
    }
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
})();
