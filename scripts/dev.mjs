import { readFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const config = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
mkdirSync('.data', { recursive: true });
const build = spawnSync('dotnet', ['build', 'EnterpriseIntegrationHub.slnx', '-c', 'Release'], { stdio: 'inherit' });
if (build.error || build.status !== 0) { console.error('Install the .NET 10 SDK and resolve build errors before starting.'); process.exit(1); }
const children = [];
for (const [project, port, db] of [['MockCrm',5101,'crm'],['MockErp',5102,'erp'],['Hub',5100,'hub']]) {
  const child = spawn('dotnet', ['run','--project', 'src/' + project, '-c', 'Release', '--no-build', '--no-launch-profile'], {
    stdio: 'inherit', env: { ...process.env, ASPNETCORE_ENVIRONMENT:'Development',
      ASPNETCORE_URLS:'http://localhost:' + port,
      ConnectionStrings__Database:'Data Source=' + process.cwd().replaceAll('\\','/') + '/.data/' + db + '.db',
      Jwt__Key:config.JWT_KEY, Services__ApiKey:config.SERVICE_KEY, Demo__Password:config.DEMO_PASSWORD }
  });
  children.push(child);
  child.on('error', err => { console.error(err.message); stop(1); });
  child.on('exit', code => { if (code) stop(code); });
}
function stop(code = 0) { for (const child of children) child.kill(); process.exit(code); }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
