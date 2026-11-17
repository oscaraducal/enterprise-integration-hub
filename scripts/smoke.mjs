import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = Object.fromEntries(readFileSync('.env', 'utf8').trim().split(/\r?\n/).map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
async function waitUntil(check, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* process may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Smoke check timed out');
}
await waitUntil(async () => (await fetch('http://localhost:5100/health')).ok);
await waitUntil(async () => (await fetch('http://localhost:5101/health')).ok);
await waitUntil(async () => (await fetch('http://localhost:5102/health')).ok);
await waitUntil(async () => (await fetch('http://localhost:4200/')).ok);
const login = await fetch('http://localhost:4200/api/auth/login', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'operator', password:config.DEMO_PASSWORD})
});
assert.equal(login.status, 200, 'Proxy authentication');
const { token } = await login.json();
const headers = {'Content-Type':'application/json', Authorization:'Bearer ' + token};
const queued = await fetch('http://localhost:4200/api/executions', {
  method:'POST', headers, body:JSON.stringify({orderId:'ORD-012', scenario:'Unavailable', target:'ERP', failuresBeforeSuccess:1})
});
assert.equal(queued.status, 202, 'Queue execution');
const { id } = await queued.json();
let result;
await waitUntil(async () => {
  result = await (await fetch('http://localhost:4200/api/executions/' + id, {headers})).json();
  return result.status === 'Completed' || result.status === 'Failed';
}, 30000);
assert.equal(result.status, 'Completed');
assert.equal(result.attempts, 2);
assert.ok(result.receiptId);
assert.ok(result.logs.some(log => log.stage === 'RetryScheduled'));
console.log('Compose smoke passed: dashboard proxy, JWT login, CRM mapping, ERP retry, receipt and persisted timeline.');
