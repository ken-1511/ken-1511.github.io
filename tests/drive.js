/**
 * Minimal CDP driver: boot the study in headless chromium, wait for it to
 * settle, then evaluate expressions in the page and print the results.
 *
 *   deno run -A tests/drive.js <url> <expr-file>
 *
 * Needed because --dump-dom cannot report renderer.info, selection state, or
 * anything else that only exists as live JS.
 */
const [url, exprFile] = Deno.args;
const PORT = 9333;

const chrome = new Deno.Command('chromium', {
  args: [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900', '--disable-dev-shm-usage', url
  ],
  stdout: 'null', stderr: 'null'
}).spawn();

const sleep = ms => new Promise(r => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* not up yet */ }
}
if (!target) { console.error('no debuggable page'); chrome.kill(); Deno.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    logs.push(`${msg.params.type}: ${msg.params.args.map(a => a.value ?? a.description).join(' ')}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise(res => {
  const n = ++id;
  pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send('Runtime.enable');
await send('Log.enable');

// Let the study boot, build, and render enough frames for renderer.info to be real.
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: 'Boolean(window.__study && window.__study.viewer)', returnByValue: true });
  if (r.result?.result?.value) { await sleep(1500); break; }
}

const expr = await Deno.readTextFile(exprFile);
const out = await send('Runtime.evaluate', {
  expression: `(async () => { try { return JSON.stringify(await (async () => { ${expr} })()); } catch (e) { return JSON.stringify({ ERROR: String(e && e.stack || e) }); } })()`,
  returnByValue: true, awaitPromise: true
});

const raw = out.result?.result?.value;
console.log(raw ? JSON.stringify(JSON.parse(raw), null, 2) : JSON.stringify(out.result, null, 2));
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));

ws.close();
chrome.kill();
