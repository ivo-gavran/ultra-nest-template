// Disposable manual browser fixture; never part of the production build.
import '../setup-env.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAuthApp } from '../helpers/auth-app.js';
import { startTestDatabase } from '../helpers/postgres.js';

let api = '';
const frontend = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`<!doctype html><html><head><title>PR-06 browser verification</title></head><body>
<h1>Disposable authentication browser test</h1>
<p>Uses a new PostgreSQL container and synthetic credentials. No tokens are displayed or persisted by frontend JavaScript.</p>
<button id="run">Run browser verification</button><pre id="results">Ready</pre>
<script>
document.getElementById('run').onclick = async () => {
  const results = document.getElementById('results'); results.textContent = '';
  const report = (label, ok) => { results.textContent += (ok ? 'PASS ' : 'FAIL ') + label + '\\n'; if (!ok) throw new Error('Verification failed'); };
  const api = ${JSON.stringify(api)};
  const post = (path, body = {}) => fetch(api + '/api/v1/auth/' + path, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const input = { email: crypto.randomUUID() + '@example.test', password: 'disposable browser password' };
    const register = await post('register', input);
    report('credentialed registration', register.status === 201);
    const pair = await register.json();
    report('access-only JSON', Object.keys(pair).sort().join(',') === 'accessToken,expiresIn');
    report('refresh is hidden from document.cookie', !document.cookie.includes('__Host-refresh'));
    const protectedResponse = await fetch(api + '/api/v1/auth-test-protected', { headers: { Authorization: 'Bearer ' + pair.accessToken } });
    report('in-memory access token authenticates', protectedResponse.status === 200);
    const refresh = await post('refresh');
    report('browser automatically sends Secure HttpOnly refresh cookie', refresh.status === 200);
    report('token response cannot be cached', refresh.headers.get('cache-control') === 'no-store');
    const rotated = await post('refresh');
    report('browser replaces cookie on rotation', rotated.status === 200);
    const logout = await post('logout'); report('logout', logout.status === 204);
    const invalid = await post('refresh'); report('cookie removed after logout', invalid.status === 401);
    const login = await post('login', input); report('password login', login.status === 200);
    await post('logout');
    results.textContent += 'COMPLETE: browser verification passed.\\n';
  } catch { results.textContent += 'FAILED: inspect server/test configuration.\\n'; }
};
</script></body></html>`);
});

frontend.listen(0, '127.0.0.1');
await once(frontend, 'listening');
const origin = `http://localhost:${(frontend.address() as AddressInfo).port}`;
const container = await startTestDatabase();
const app = await createAuthApp(
  container.getConnectionUri(),
  () => Date.now(),
  false,
  origin,
);
api = (await app.getUrl()).replace('127.0.0.1', 'localhost');
console.log(
  `Open ${origin} and click Run browser verification. Ctrl-C cleans up the disposable fixture.`,
);
async function close() {
  frontend.close();
  try {
    await app.close();
  } finally {
    await container.stop();
  }
  process.exit(0);
}
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
