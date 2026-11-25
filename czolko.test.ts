import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
assert.ok(scriptMatch, 'Expected inline script block in index.html');
const inlineScript = scriptMatch[1];

test('index.html inline script parses with zero syntax errors', () => {
  assert.doesNotThrow(() => new vm.Script(inlineScript, { filename: 'index.html' }));
});

test('sync constants, CSS GPU offload, and clock-skew removal are present', () => {
  assert.match(inlineScript, /HOST_ACCEPT_TIMEOUT_MS\s*=\s*20000/);
  assert.match(inlineScript, /HOST_TAKEOVER_BASE_MS\s*=\s*25000/);
  assert.match(inlineScript, /GIF_MAX_BYTES\s*=\s*350\s*\*\s*1024/);
  assert.doesNotMatch(inlineScript, /Date\.now\(\)\s*-\s*\(st\.ts\s*\|\|\s*0\)\s*<\s*28000/);
  assert.match(inlineScript, /waitPeek\(3500\)/);
  assert.match(inlineScript, /probeHostAlive\(cur,\s*2500\)/);
  assert.doesNotMatch(html, /\.orb\s*\{[^}]*filter:\s*blur\(70px\)/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?backdrop-filter:\s*none/);
  // loopTick must not call renderHeader()
  const loopMatch = inlineScript.match(/function loopTick\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(loopMatch, 'loopTick should exist');
  assert.doesNotMatch(loopMatch[1], /renderHeader\(\)/);
});

test('QRGen produces ISO/IEC 18004 compliant format bits, matrices, and SVG', () => {
  const qrBlockMatch = inlineScript.match(/const QRGen = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
  assert.ok(qrBlockMatch, 'QRGen IIFE should exist');
  const ctx = vm.createContext({ Uint8Array, TextEncoder, Array, Math, Infinity, encodeURIComponent, unescape });
  const QRGen = vm.runInContext(`${qrBlockMatch[0]}; QRGen;`, ctx);

  // ISO/IEC 18004 Annex C exact format strings for ECC Level L
  assert.equal(QRGen.formatBits(0), 0x77c4);
  assert.equal(QRGen.formatBits(1), 0x72f3);
  assert.equal(QRGen.formatBits(2), 0x7daa);

  // Short code -> Version 1 (21x21)
  const m1 = QRGen.encodeMatrix('EKIPA');
  assert.equal(m1.length, 21);
  // Top-left finder outer border and center 3x3
  assert.equal(m1[0][0], 1);
  assert.equal(m1[3][3], 1);
  assert.equal(m1[1][1], 0);
  // Dark module at (4*1 + 9, 8) = (13, 8)
  assert.equal(m1[13][8], 1);

  // Typical room URL (~88 bytes) -> Version 5 (37x37)
  const url = 'https://ais-dev-tipck5272s5ocxg2xg6wxh-752473421301.europe-west1.run.app/?room=EKIPA';
  const m5 = QRGen.encodeMatrix(url);
  assert.equal(m5.length, 37);
  assert.equal(m5[4 * 5 + 9][8], 1);

  // Version 6 (2-block Reed-Solomon interleaving, ~120 bytes) -> 41x41
  const longUrl = 'https://example.com/' + 'a'.repeat(95) + '/?room=EKIPA';
  const m6 = QRGen.encodeMatrix(longUrl);
  assert.equal(m6.length, 41);
  assert.equal(m6[4 * 6 + 9][8], 1);

  const svg = QRGen.toSvg(url);
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'));
  assert.ok(svg.includes('<path d="M'));
});

test('filterWordsList respects filters and anti-spoiler search privacy', () => {
  const normMatch = inlineScript.match(/const norm = [^;]+;/);
  const filterMatch = inlineScript.match(/function filterWordsList\([\s\S]*?\n\}/);
  assert.ok(normMatch && filterMatch);
  const ctx = vm.createContext({});
  const filterWordsList = vm.runInContext(`${normMatch[0]}\n${filterMatch[0]}\nfilterWordsList;`, ctx);

  const words = [
    { id: 'w1', t: 'Tajny Smok', c: '🎬 Film / Gra', by: 'other', byN: 'Kuba' },
    { id: 'w2', t: 'Robert Makłowicz', c: '😎 Osoba / Ekipa', by: 'me', byN: 'Ja' },
    { id: 'w3', t: 'Shrek', c: '🎬 Film / Gra', by: 'me', byN: 'Ja' }
  ];
  const used = new Set(['w3']);

  assert.equal(filterWordsList(words, used, 'all', '', 'me', false).length, 3);
  assert.equal(filterWordsList(words, used, 'mine', '', 'me', false).length, 2);
  assert.equal(filterWordsList(words, used, 'free', '', 'me', false).length, 2);

  // Anti-spoiler: searching hidden word text must NOT reveal it when spoiler is off
  assert.equal(filterWordsList(words, used, 'all', 'Smok', 'me', false).length, 0);
  // Searching author or category still works
  assert.equal(filterWordsList(words, used, 'all', 'Kuba', 'me', false).length, 1);
  // Searching own word works with diacritics normalized
  assert.equal(filterWordsList(words, used, 'all', 'maklowicz', 'me', false).length, 1);
  // With spoiler ON, hidden word text becomes searchable
  assert.equal(filterWordsList(words, used, 'all', 'Smok', 'me', true).length, 1);
});

test('hostPublishNow drops older state if async CryptoGuard.sign resolves out of order', async () => {
  const pubFnMatch = inlineScript.match(/async function hostPublishNow\(force = false\) \{[\s\S]*?\n\}/);
  assert.ok(pubFnMatch);
  const published: Array<{ v: number }> = [];
  let resolvers: Array<(sig: string) => void> = [];
  const ctx = vm.createContext({
    clearTimeout,
    S: { gen: 'g1', v: 0, ts: 0 },
    net: { pubTimer: null, amHost: true, leaving: false, pubSeq: 0, lastPub: 0 },
    CryptoGuard: {
      pubJwk: { x: 'a', y: 'b' },
      sign: () => new Promise<string>(r => resolvers.push(r))
    },
    pub: (_sub: string, env: { d: string }) => { published.push(JSON.parse(env.d)); },
    scheduleRender: () => {}
  });
  const hostPublishNow = vm.runInContext(`${pubFnMatch[0]}; hostPublishNow;`, ctx);

  const p1 = hostPublishNow(false); // v = 1, seq = 1
  const p2 = hostPublishNow(false); // v = 2, seq = 2
  // Resolve v=2 FIRST, then v=1 SECOND (out of order!)
  resolvers[1]('sig2');
  await p2;
  resolvers[0]('sig1');
  await p1;

  assert.equal(published.length, 1);
  assert.equal(published[0].v, 2);
});

test('room codes are strictly 5 numeric digits (0-9)', () => {
  const consts = inlineScript.match(/const CODE_MIN = [\s\S]*?const CODE_REGEX = [^;]+;/);
  const fns = inlineScript.match(/function randCode\(\) \{[\s\S]*?function validateRoomCode\(raw\) \{[\s\S]*?\n\}/);
  assert.ok(consts && fns, 'Expected room code constants and helpers');
  const ctx = vm.createContext({
    rand: (n: number) => Math.floor(Math.random() * n),
    Math
  });
  const api = vm.runInContext(`${consts[0]}\n${fns[0]}\n({ randCode, sanitizeCodeInput, validateRoomCode, CODE_MIN, CODE_MAX, CODE_GEN_LEN });`, ctx);

  assert.equal(api.CODE_MIN, 5);
  assert.equal(api.CODE_MAX, 5);
  assert.equal(api.CODE_GEN_LEN, 5);

  for (let i = 0; i < 40; i++) {
    const c = api.randCode();
    assert.match(c, /^\d{5}$/, `Generated code ${c} must be 5 digits`);
  }

  assert.equal(api.sanitizeCodeInput('ab12-34 567'), '12345');
  assert.equal(api.sanitizeCodeInput('00912'), '00912');

  assert.equal(api.validateRoomCode('48291').ok, true);
  assert.equal(api.validateRoomCode('00421').ok, true);
  assert.equal(api.validateRoomCode('1234').ok, false);
  assert.equal(api.validateRoomCode('123456').ok, false);
  assert.equal(api.validateRoomCode('AB123').ok, false);
  assert.equal(api.validateRoomCode('').ok, false);
});

test('computeScoreFx tracks session deltas and triggers rank-bump-up / rank-bump-down', () => {
  const fnMatch = inlineScript.match(/function computeScoreFx\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'computeScoreFx should exist');
  const haptics: unknown[] = [];
  const sounds: string[] = [];
  const ctx = vm.createContext({
    Date,
    pid: 'p1',
    S: { players: { p1: { id: 'p1', score: 2 }, p2: { id: 'p2', score: 0 } } },
    net: { sessionBaseScores: {}, prevScores: {}, scoreFx: {}, rankAnim: {} },
    haptic: (pat: unknown) => haptics.push(pat),
    sfx: (name: string) => sounds.push(name)
  });
  const computeScoreFx = vm.runInContext(`${fnMatch[0]}; computeScoreFx;`, ctx);

  // Initial pass records baseline scores without firing animation
  computeScoreFx();
  assert.equal(ctx.net.sessionBaseScores.p1, 2);
  assert.equal(ctx.net.rankAnim.p1, undefined);

  // p1 gains +1 point -> triggers up animation & haptic
  ctx.S.players.p1.score = 3;
  computeScoreFx();
  assert.equal(ctx.net.rankAnim.p1.dir, 'up');
  assert.equal(ctx.net.rankAnim.p1.d, 1);
  assert.equal(ctx.S.players.p1.score - ctx.net.sessionBaseScores.p1, 1);
  assert.equal(haptics.length, 1);

  // p2 gains +2 -> plays point sound for remote gain
  ctx.S.players.p2.score = 2;
  computeScoreFx();
  assert.equal(ctx.net.rankAnim.p2.dir, 'up');
  assert.deepEqual(sounds, ['point']);
});

test('Phone/Computer switcher, ranking visual highlights, and party extras are wired', () => {
  assert.match(html, /data-act="appView"\s+data-v="phone"/);
  assert.match(html, /data-act="appView"\s+data-v="pc"/);
  assert.match(html, /id="mobile-dock"/);
  assert.match(html, /body\.app-phone/);
  assert.match(html, /\.lbrow\.session-up/);
  assert.match(html, /\.lbrow\.rank-bump-up/);
  assert.match(html, /data-act="react"\s+data-e="🔥"/);
  assert.match(html, /data-act="ideaWord"/);
  assert.match(html, /data-act="help"/);
  assert.match(inlineScript, /function applyAppView\(/);
  assert.match(inlineScript, /function spawnReaction\(/);
});

