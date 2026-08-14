/**
 * End-to-end reconnect regression (fix/peer-reconnect-drop).
 *
 * Two browser contexts join a room, establish P2P, the sender grabs, then the
 * receiver's network drops (setOffline) and comes back. After the auto-reconnect
 * the pair must reach "Peer Connected" again and a FRESH grab -> drop must start
 * a real transfer — the Drop button must appear AND work, not just render.
 *
 * On the unfixed client the sender's resetWebRTCConnection wipes its selected
 * files, so after reconnect it cannot answer REQUEST_FILE_META and the drop
 * stalls forever -> FAIL.
 *
 * Run:   npm run dev (in one terminal)
 *        node test_reconnect_handshake.cjs
 */
const { chromium } = require('playwright');
const { writeFileSync } = require('fs');
const { join } = require('path');

const BASE_URL = process.env.TEST_URL || 'https://localhost:3000/';
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

const IGNORED_CONSOLE = [
  /vite/i, /websocket/i, /socket\.io/i, /ERR_CONNECTION_TIMED_OUT/i,
  /ERR_SSL_PROTOCOL_ERROR/i, /Failed to load resource/i, /React DevTools/i,
  /font-weight:bold/i,
];
const isIgnored = (text) => IGNORED_CONSOLE.some((re) => re.test(text));

const results = [];
const logs = { sender: [], receiver: [] };
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '\n        ' + detail}`);
}
function attach(page, role) {
  page.on('console', (m) => {
    const t = m.text();
    if (isIgnored(t)) return;
    logs[role].push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => logs[role].push(`[pageerror] ${e.message}`));
}

async function waitPeerConnected(page, who) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const pill = await page.evaluate(() =>
      document.querySelector('.status-pill span')?.textContent ?? ''
    ).catch(() => '');
    if (pill.includes('Peer Connected')) return true;
    await WAIT(500);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--allow-insecure-localhost', '--disable-web-security'],
  });

  let sender, receiver, senderCtx, receiverCtx;
  try {
    senderCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    receiverCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    sender = await senderCtx.newPage();
    receiver = await receiverCtx.newPage();
    attach(sender, 'sender');
    attach(receiver, 'receiver');

    const room = String(Math.floor(1000 + Math.random() * 9000));

    console.log('\nNavigating...');
    await sender.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await receiver.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await WAIT(4000);

    // ── Join room from both sides ───────────────────────────────────────────
    await sender.evaluate((code) => window._socketJoinRoom(code), room);
    await WAIT(500);
    await receiver.evaluate((code) => window._socketJoinRoom(code), room);

    // ── Baseline: P2P connected on both ends ────────────────────────────────
    console.log('\nWaiting for baseline P2P...');
    const sBase = await waitPeerConnected(sender, 'sender');
    const rBase = await waitPeerConnected(receiver, 'receiver');
    record('baseline P2P connected on both ends', sBase && rBase, `sender=${sBase} receiver=${rBase}`);

    // ── Sender registers an ~8 MB payload and grabs ─────────────────────────
    const sel = await sender.evaluate(() => {
      const bytes = new Uint8Array(8 * 1024 * 1024).fill(0x62);
      const file = new File([bytes], 'reconnect_payload.bin', { type: 'application/octet-stream' });
      if (typeof window.onFilesSelected === 'function') {
        window.onFilesSelected([file]);
        return 'ok';
      }
      return 'missing';
    });
    record('sender registered payload via onFilesSelected', sel === 'ok', sel === 'missing' ? 'bridge missing' : '');
    await WAIT(800);

    await sender.evaluate(() => document.getElementById('btn-grab')?.click());
    await WAIT(1500);
    let dropArmed = await receiver.evaluate(() => {
      const el = document.getElementById('btn-drop');
      return !!el && el.style.display !== 'none' && !el.disabled;
    }).catch(() => false);
    record('receiver Drop armed before network drop', dropArmed);

    // ── Drop the receiver's network, then bring it back ─────────────────────
    console.log('\nSimulating receiver network drop + recovery...');
    await receiverCtx.setOffline(true);
    await WAIT(4000);
    await receiverCtx.setOffline(false);

    // ── Both ends must reconnect and re-establish P2P ───────────────────────
    console.log('Waiting for reconnection...');
    const sRe = await waitPeerConnected(sender, 'sender');
    const rRe = await waitPeerConnected(receiver, 'receiver');
    record('both ends re-reach Peer Connected after reconnect', sRe && rRe, `sender=${sRe} receiver=${rRe}`);

    // ── Fresh grab -> drop must produce a real transfer ─────────────────────
    await sender.evaluate(() => document.getElementById('btn-grab')?.click());
    await WAIT(1500);

    let dropArmed2 = false;
    const armDeadline = Date.now() + 15000;
    while (Date.now() < armDeadline && !dropArmed2) {
      dropArmed2 = await receiver.evaluate(() => {
        const el = document.getElementById('btn-drop');
        return !!el && el.style.display !== 'none' && !el.disabled;
      }).catch(() => false);
      if (!dropArmed2) await WAIT(400);
    }
    record('receiver Drop armed after reconnect', dropArmed2);

    await receiver.evaluate(() => document.getElementById('btn-drop')?.click());
    await WAIT(500);

    // Transfer must actually start (requested/active) — not stall at idle.
    let inFlight = false;
    const phases = [];
    const phaseDeadline = Date.now() + 30000;
    while (Date.now() < phaseDeadline && !inFlight) {
      await WAIT(300);
      const ph = await receiver.evaluate(() => window.getTransferPhase?.() ?? null).catch(() => null);
      if (ph && phases[phases.length - 1] !== ph) phases.push(ph);
      if (ph === 'requested' || ph === 'active') inFlight = true;
    }
    record(
      'transfer in flight after reconnect (drop actually works)',
      inFlight,
      `receiver phases seen: ${phases}`
    );

    await sender.evaluate(() => { window._socketCancelTransfer?.(); }).catch(() => {});
    await WAIT(500);
  } catch (err) {
    record('run completed without internal error', false, String((err && err.message) || err));
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} reconnect e2e checks passed`);
  writeFileSync(
    join(__dirname, 'reconnect_handshake_report.log'),
    `=== SENDER ===\n${logs.sender.join('\n')}\n\n=== RECEIVER ===\n${logs.receiver.join('\n')}`
  );
  process.exit(failed.length ? 1 : 0);
})();