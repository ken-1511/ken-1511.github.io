/**
 * Drive the study in headless chromium and capture screenshots.
 *
 *   deno run -A tests/shoot.js <url> <outdir> [steps.js]
 *
 * A steps file exports an array of { name, script, settle } — the script runs in
 * the page, then a screenshot is taken. Without one, a single boot shot.
 *
 * The renderer here is SwiftShader, so this verifies layout, colour, contrast
 * and that the thing draws at all. Frame timing from this path is not a GPU
 * measurement and is never reported as one.
 */
const [url, outDir, stepsFile, size] = Deno.args;
const [W, H] = (size ?? '1680,1000').split(',');
const PORT = 9334;

await Deno.mkdir(outDir, { recursive: true });

const chrome = new Deno.Command('chromium', {
  args: [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${PORT}`,
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`, '--disable-dev-shm-usage', url
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

const evaluate = async expression => {
  const out = await send('Runtime.evaluate', {
    expression: `(async () => { try { return JSON.stringify(await (async () => { ${expression} })()); } catch (e) { return JSON.stringify({ ERROR: String(e && e.stack || e) }); } })()`,
    returnByValue: true, awaitPromise: true
  });
  const raw = out.result?.result?.value;
  return raw ? JSON.parse(raw) : null;
};

await send('Runtime.enable');
await send('Log.enable');

for (let i = 0; i < 60; i += 1) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: 'Boolean(window.__study && window.__study.viewer)', returnByValue: true });
  if (r.result?.result?.value) { await sleep(2000); break; }
}

const steps = stepsFile
  ? (await import(`file://${await Deno.realPath(stepsFile)}`)).default
  : [{ name: 'boot', script: 'return true;' }];

const results = [];
for (const step of steps) {
  const value = await evaluate(step.script ?? 'return true;');
  await sleep(step.settle ?? 1400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const data = shot.result?.data;
  if (data) {
    await Deno.writeFile(`${outDir}/${step.name}.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
  }
  results.push({ step: step.name, value });
  console.log(`  ${data ? 'shot' : 'FAILED'}  ${step.name}  ${JSON.stringify(value)?.slice(0, 220) ?? ''}`);
}

if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
else console.log('\nconsole: clean');

ws.close();
chrome.kill();
