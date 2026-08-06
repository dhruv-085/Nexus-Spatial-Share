/**
 * Exit-path regression sweep.
 *
 * Every "stuck animation" bug in this app has been a transfer exit path that
 * forgot one teardown step. This harness turns that table into something that
 * fails loudly: it drives each single-page-reachable exit path and asserts the
 * app landed in a clean idle state.
 *
 * Two-device paths (real sender <-> receiver success, cancel from the far side,
 * peer disconnect) cannot be driven from one page — those stay a manual matrix
 * in the PR description.
 *
 * Usage:  npm run dev      (in one terminal)
 *         node test_exit_paths.cjs
 */
const { chromium } = require('playwright');

const URL = process.env.TEST_URL || 'https://localhost:3000/';

// Noise from the dev environment that is not the app's fault: Vite's HMR socket
// and socket.io both fail under a self-signed cert in headless Chromium.
const IGNORED_CONSOLE = [
  /vite/i,
  /websocket/i,
  /socket\.io/i,
  /ERR_CONNECTION_TIMED_OUT/i,
  /ERR_SSL_PROTOCOL_ERROR/i,
  /Failed to load resource/i,
];
const isIgnored = (text) => IGNORED_CONSOLE.some((re) => re.test(text));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '\n        ' + detail}`);
}

/** The single source of truth for "the UI is back to idle". */
async function idleState(page) {
  return page.evaluate(() => {
    const disp = (id) => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display : 'missing';
    };
    const hasVisible = (id) => {
      const el = document.getElementById(id);
      return el ? el.classList.contains('visible') : false;
    };
    return {
      ringCanvasHidden: disp('transfer-rings-canvas') === 'none',
      transferringClassAbsent: !document.body.classList.contains('transferring'),
      dropZoneDisplayed: disp('drop-zone') !== 'none',
      senderProgressHidden: !hasVisible('progress-screen'),
      receiverProgressHidden: !hasVisible('receive-progress'),
      ringsStopped: window.TransferRings
        ? window.TransferRings._debug().rafId === null && window.TransferRings._debug().count === 0
        : false,
    };
  });
}

function assertIdle(name, state, errors) {
  const bad = Object.entries(state).filter(([, v]) => v !== true).map(([k]) => k);
  const consoleBad = errors.filter((e) => !isIgnored(e));
  record(
    name,
    bad.length === 0 && consoleBad.length === 0,
    `not-idle: [${bad.join(', ')}]  console: [${consoleBad.slice(0, 3).join(' | ')}]`
  );
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Reach the sender workspace so #drop-zone is actually in the layout.
  await page.click('#btn-create');
  await page.waitForTimeout(1500);

  /** Put the app into an active-transfer visual state, then run an exit path. */
  async function exitVia(label, mode, exitFn) {
    errors.length = 0;
    await page.evaluate((m) => {
      document.getElementById(m === 'out' ? 'progress-screen' : 'receive-progress')
        .classList.add('visible');
      window.enterTransferVisuals(m);
    }, mode);
    await page.waitForTimeout(500);

    // Sanity: we really were mid-transfer before exiting, otherwise the exit
    // assertion below would pass vacuously.
    const during = await page.evaluate(() => ({
      canvasShown: getComputedStyle(document.getElementById('transfer-rings-canvas')).display === 'block',
      transferring: document.body.classList.contains('transferring'),
      dropZoneGone: getComputedStyle(document.getElementById('drop-zone')).display === 'none',
    }));
    record(
      `${label} :: mid-transfer state is active (rings shown, drop zone banished)`,
      during.canvasShown && during.transferring && during.dropZoneGone,
      JSON.stringify(during)
    );

    await page.evaluate(exitFn);
    await page.waitForTimeout(600);
    assertIdle(`${label} :: returns to clean idle`, await idleState(page), errors);
  }

  // The sender's completion is reached only through _completeTransferCh3 — the
  // bridge index.html exposes for App.tsx's 'eof' handler. An earlier version of
  // this sweep called window.completeTransfer, which does not exist, and its
  // `else` fell through to a bare resetTransferVisuals(): the most important
  // exit path was passing without ever running. Fail loudly instead.
  record(
    'sender completion bridge (_completeTransferCh3) is present',
    await page.evaluate(() => typeof window._completeTransferCh3 === 'function'),
    'window._completeTransferCh3 is missing — the sender success path is unreachable'
  );

  await exitVia('sender success (_completeTransferCh3)', 'out',
    () => window._completeTransferCh3());

  // The success screens are shown right next to a resetTransferVisuals() call —
  // before it on the sender, after it on the receiver — and that reset hides
  // #progress-screen / #receive-progress. They survive today only because both
  // success screens are body-level siblings rather than children of the
  // overlays. Nothing else asserts that, so a future reparent would kill the
  // success feedback while every idle assertion above still passed.
  record(
    'sender success :: the success screen survives the teardown before it',
    await page.evaluate(() =>
      document.getElementById('success-screen').classList.contains('visible')),
    'success screen was not visible after completeTransfer()'
  );
  await page.evaluate(() => {
    document.getElementById('success-screen').classList.remove('visible');
  });

  const successNesting = await page.evaluate(() => {
    const ps = document.getElementById('progress-screen');
    const rp = document.getElementById('receive-progress');
    return {
      senderDetached: !ps.contains(document.getElementById('success-screen')),
      receiverDetached: !rp.contains(document.getElementById('receive-success')),
    };
  });
  record(
    'success screens live outside the overlays resetTransferVisuals() hides',
    successNesting.senderDetached && successNesting.receiverDetached,
    JSON.stringify(successNesting)
  );

  await exitVia('cancel (onTransferCancelled)', 'out',
    () => window.onTransferCancelled());

  await exitVia('receiver stop (stopReceiverAnimation)', 'in',
    () => window.stopReceiverAnimation());

  await exitVia('error / ICE failure (showTransferError)', 'out',
    () => window.showTransferError('Test error', 'exit-path sweep', null));

  // showTransferError leaves the error screen up; clear it before the next case.
  await page.evaluate(() => document.getElementById('transfer-error-screen').classList.remove('visible'));

  await exitVia('peer disconnect (showPeerDisconnected)', 'in',
    () => window.showPeerDisconnected(true));
  await page.evaluate(() => document.getElementById('transfer-error-screen').classList.remove('visible'));

  await exitVia('direct resetTransferVisuals()', 'out',
    () => window.resetTransferVisuals());

  // Leave room is terminal for the sender workspace, so run it last.
  await exitVia('leave room (leaveRoom)', 'out',
    () => window.leaveRoom());

  // --- Backgrounded-tab guard: teardown must not ride on an animation frame.
  errors.length = 0;
  await page.evaluate(() => {
    document.getElementById('progress-screen').classList.add('visible');
    window.enterTransferVisuals('out');
  });
  await page.waitForTimeout(400);
  const bgPage = await context.newPage();       // steals focus, backgrounding `page`
  await bgPage.goto('about:blank');
  await page.waitForTimeout(700);
  await page.evaluate(() => window.resetTransferVisuals());
  await bgPage.close();
  await page.bringToFront();
  await page.waitForTimeout(400);
  assertIdle('backgrounded tab :: reset while hidden still reaches idle', await idleState(page), errors);

  // --- Idempotency: repeated resets must not drift state.
  errors.length = 0;
  await page.evaluate(() => { window.resetTransferVisuals(); window.resetTransferVisuals(); });
  await page.waitForTimeout(200);
  assertIdle('repeated resetTransferVisuals() stays idle', await idleState(page), errors);

  // --- Drop zone survives the display toggle with its listeners intact.
  // display:none does not detach listeners, but assert it rather than assume.
  errors.length = 0;
  const dzRoundTrip = await page.evaluate(async () => {
    const dz = document.getElementById('drop-zone');
    let dragoverFired = 0;
    const probe = () => { dragoverFired++; };
    dz.addEventListener('dragover', probe);

    window.enterTransferVisuals('out');
    const hidden = getComputedStyle(dz).display === 'none';
    window.resetTransferVisuals();
    await new Promise((r) => setTimeout(r, 100));
    const restored = getComputedStyle(dz).display !== 'none';

    // the element must still be the same node and still receive events
    dz.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
    dz.removeEventListener('dragover', probe);

    // and its click handler (opens the file picker) must still be wired
    const hasClickHandler = typeof dz.onclick === 'function' || dz.hasAttribute('onclick');

    return { hidden, restored, dragoverFired, hasClickHandler };
  });
  record(
    'drop zone :: banished during transfer, restored after, listeners intact',
    dzRoundTrip.hidden && dzRoundTrip.restored &&
      dzRoundTrip.dragoverFired === 1 && dzRoundTrip.hasClickHandler,
    JSON.stringify(dzRoundTrip)
  );

  // --- The drop zone must never reappear mid-transfer.
  errors.length = 0;
  const stayedGone = await page.evaluate(async () => {
    window.enterTransferVisuals('out');
    const dz = document.getElementById('drop-zone');
    for (let i = 0; i < 25; i++) {
      if (getComputedStyle(dz).display !== 'none') return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  });
  record('drop zone :: never returns during an active transfer (2.5s watch)',
    stayedGone, 'drop zone reappeared mid-transfer');
  await page.evaluate(() => window.resetTransferVisuals());

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach((f) => console.log('  - ' + f.name));
  }
  process.exit(failed.length ? 1 : 0);
})();
