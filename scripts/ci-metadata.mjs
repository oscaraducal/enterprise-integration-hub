// Emit only the public dependency manifest so remote verification can return a reproducible lockfile.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
console.log('DEPENDENCY_LOCK_START');
console.log(gzipSync(readFileSync('package-lock.json')).toString('base64'));
console.log('DEPENDENCY_LOCK_END');
