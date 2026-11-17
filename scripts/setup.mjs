import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
if (existsSync('.env')) { console.log('.env already exists; left unchanged.'); }
else {
  writeFileSync('.env', 'JWT_KEY=' + randomBytes(48).toString('hex') +
    '\nSERVICE_KEY=' + randomBytes(32).toString('hex') +
    '\nDEMO_PASSWORD=' + randomBytes(18).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created .env with random local credentials. Read DEMO_PASSWORD there; login as operator or viewer.');
}
