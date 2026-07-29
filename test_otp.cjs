/**
 * OTP room-code input regression suite.
 *
 * Six prior fixes to this input have failed, and two of them encoded opposite
 * backspace focus rules. The normative rule is stated once, here and in the
 * erase routine it exercises:
 *
 *   Backspace, box i filled  -> clear i only,   focus STAYS on i
 *   Backspace, box i empty   -> clear i-1 only, focus MOVES to i-1
 *   Backspace, box 0 empty   -> nothing changes
 *   Digit,     any box       -> set i, focus i+1 (or stays on 3)
 *   Delete,    any box       -> clear i only,   focus stays on i
 *
 * Usage:  npm run dev      (in one terminal)
 *         node test_otp.cjs
 */
const { chromium } = require('playwright');

const URL = process.env.TEST_URL || 'https://localhost:3000/';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '\n        ' + detail}`);
}

async function state(page) {
  return page.evaluate(() => ({
    digits: [0, 1, 2, 3].map((i) => document.getElementById('otp-' + i).value),
    focused: document.activeElement ? document.activeElement.id : null,
  }));
}

function expect(name, actual, digits, focused) {
  const okDigits = JSON.stringify(actual.digits) === JSON.stringify(digits);
  const okFocus = focused === null || actual.focused === focused;
  record(
    name,
    okDigits && okFocus,
    `got digits=${JSON.stringify(actual.digits)} focus=${actual.focused}; ` +
      `want digits=${JSON.stringify(digits)} focus=${focused}`
  );
}

async function reset(page) {
  await page.evaluate(() => {
    for (let i = 0; i < 4; i++) {
      const b = document.getElementById('otp-' + i);
      b.value = '';
      b.classList.remove('filled');
    }
  });
  // drive a real clear through the UI so internal digit state follows
  await page.click('#otp-0');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
  await page.click('#otp-0');
}

async function run(browserName, contextOpts, label) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...contextOpts });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const P = (s) => `${label} :: ${s}`;

  // --- typing advances through all four boxes
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  expect(P('type 1234 fills each box in order, focus ends on box 3'),
    await state(page), ['1', '2', '3', '4'], 'otp-3');

  // --- backspace on a FILLED box clears it and STAYS (the rule two fixes got wrong)
  await page.keyboard.press('Backspace');
  expect(P('backspace on filled box 3 clears only box 3, focus stays on box 3'),
    await state(page), ['1', '2', '3', ''], 'otp-3');

  // --- backspace on an EMPTY box clears the previous one and moves there
  await page.keyboard.press('Backspace');
  expect(P('backspace on empty box 3 clears box 2, focus moves to box 2'),
    await state(page), ['1', '2', '', ''], 'otp-2');

  // --- typing there lands in box 2, not box 1
  await page.keyboard.type('9');
  expect(P('typing after the empty-box rule lands in box 2 and advances'),
    await state(page), ['1', '2', '9', ''], 'otp-3');

  // --- exactly one box clears per press, four presses from a full code
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  const seq = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Backspace');
    seq.push((await state(page)).digits.join('|'));
  }
  record(
    P('four backspaces from 1234 clear exactly one box each'),
    JSON.stringify(seq) === JSON.stringify(['1|2|3|', '1|2||', '1|||', '|||']),
    JSON.stringify(seq)
  );

  // --- box 0 empty: nothing changes, no error
  await page.keyboard.press('Backspace');
  expect(P('backspace on empty box 0 changes nothing'),
    await state(page), ['', '', '', ''], 'otp-0');

  // --- re-entry after a full clear traverses all four boxes
  await page.keyboard.type('5678');
  expect(P('re-typing after a full clear fills all four boxes'),
    await state(page), ['5', '6', '7', '8'], 'otp-3');

  // --- clear all four TWICE then type (guards the stale-state bug)
  for (let round = 0; round < 2; round++) {
    await page.click('#otp-3');
    for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
    await page.click('#otp-0');
    await page.keyboard.type('1357');
    expect(P(`clear-all + retype round ${round + 1} still traverses correctly`),
      await state(page), ['1', '3', '5', '7'], 'otp-3');
  }

  // --- typing into an already-filled box replaces it, no leak into the next box
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  await page.click('#otp-1');
  await page.keyboard.type('8');
  expect(P('typing into a filled box replaces it and does not leak a digit'),
    await state(page), ['1', '8', '3', '4'], 'otp-2');

  // --- Delete clears only the current box and keeps focus
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  await page.click('#otp-1');
  await page.keyboard.press('Delete');
  expect(P('Delete clears only the current box, focus stays'),
    await state(page), ['1', '', '3', '4'], 'otp-1');

  // --- arrows move focus without changing digits
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  await page.click('#otp-2');
  await page.keyboard.press('ArrowLeft');
  expect(P('ArrowLeft moves focus without changing digits'),
    await state(page), ['1', '2', '3', '4'], 'otp-1');
  await page.keyboard.press('ArrowRight');
  expect(P('ArrowRight moves focus without changing digits'),
    await state(page), ['1', '2', '3', '4'], 'otp-2');

  // --- Android/IME path: beforeinput(deleteContentBackward) with no usable keydown
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  const imeSeq = await page.evaluate(async () => {
    const out = [];
    for (let n = 0; n < 3; n++) {
      const el = document.activeElement;
      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
      }));
      await new Promise((r) => setTimeout(r, 60));
      out.push([0, 1, 2, 3].map((i) => document.getElementById('otp-' + i).value).join('|')
        + ' @' + (document.activeElement && document.activeElement.id));
    }
    return out;
  });
  record(
    P('IME deleteContentBackward erases exactly one box per event'),
    JSON.stringify(imeSeq) === JSON.stringify([
      '1|2|3| @otp-3', '1|2|| @otp-2', '1||| @otp-1',
    ]),
    JSON.stringify(imeSeq)
  );

  // --- one physical keypress must not erase twice even if listeners overlap
  await reset(page);
  await page.click('#otp-0');
  await page.keyboard.type('1234');
  const doubleFire = await page.evaluate(async () => {
    const el = document.getElementById('otp-3');
    el.focus();
    // simulate a browser that honours neither preventDefault nor the chain:
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8, bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    el.value = '';
    el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return [0, 1, 2, 3].map((i) => document.getElementById('otp-' + i).value);
  });
  record(
    P('one keypress reaching all three listeners erases exactly one box'),
    JSON.stringify(doubleFire) === JSON.stringify(['1', '2', '3', '']),
    `got ${JSON.stringify(doubleFire)}, want ["1","2","3",""]`
  );

  // --- paste fills all four and lands focus on box 3
  await reset(page);
  await page.click('#otp-0');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text', '1234');
    document.getElementById('otp-0').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );
  });
  await page.waitForTimeout(500);
  expect(P('paste 1234 into box 0 fills all four, focus on box 3'),
    await state(page), ['1', '2', '3', '4'], 'otp-3');

  // --- the completed code reaches the join path exactly once
  const joinOnce = await page.evaluate(async () => {
    let calls = 0;
    const btn = document.getElementById('btn-join');
    const probe = () => { calls++; };
    btn.addEventListener('click', probe);
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    btn.removeEventListener('click', probe);
    const err = document.getElementById('join-error').textContent;
    return { calls, err };
  });
  record(
    P('a complete code drives the join sequence exactly once'),
    joinOnce.calls === 1 && !/Enter all 4 digits/.test(joinOnce.err),
    JSON.stringify(joinOnce)
  );

  await browser.close();
}

(async () => {
  await run('chromium', {}, 'desktop');
  // Android soft-keyboard profile: mobile UA + touch, exercising the IME path.
  await run('chromium', {
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.75,
  }, 'android-ua');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach((f) => console.log('  - ' + f.name));
  }
  process.exit(failed.length ? 1 : 0);
})();
