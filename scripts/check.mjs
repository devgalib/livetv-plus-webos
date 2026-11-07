// Checks that the code runs on the TV: the app on Chrome 53 and the helper on Node.js 0.12
// both need plain ES5, and the JSON manifests must parse.
import fs from 'node:fs';
import { parse } from 'acorn';

const ES5 = ['webos-app/app.js', 'webos-service/service.js'];
const JSON_FILES = ['webos-app/appinfo.json', 'webos-service/package.json', 'webos-service/services.json', 'webos-service/pairing.json'];
let failed = false;

for (const file of ES5) {
  try {
    parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 5, sourceType: 'script' });
    console.log(`ok   ${file} (ES5)`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${file}: ${e.message}`);
  }
}
for (const file of JSON_FILES) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`ok   ${file}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${file}: ${e.message}`);
  }
}
global.window = {};
await import('../webos-app/channels.js');
const channels = window.CHANNELS;
if (!Array.isArray(channels) || !channels.length || channels.some((c) => !c.id || !c.urls?.length)) {
  failed = true;
  console.error('FAIL webos-app/channels.js: empty or malformed channel list');
} else console.log(`ok   webos-app/channels.js (${channels.length} channels)`);

process.exit(failed ? 1 : 0);
