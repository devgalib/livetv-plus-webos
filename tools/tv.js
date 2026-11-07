// Small LG webOS remote-control helper over the TV's local SSAP API.
// Usage: TV_IP=192.168.x.x node tools/tv.js <command> [json-payload]
// The first run shows a connection prompt on the TV; the pairing key is saved in tools/.tvkey.
//   info                      model + webOS version
//   apps                      list installed apps
//   launch <appId>            launch an app
//   request <uri> [json]      raw SSAP request, e.g. ssap://system/getSystemInfo
//   foreground                app currently on screen
//   keys <KEY,KEY,...>        press remote buttons, e.g. HOME,DOWN,ENTER (pause with WAIT)
//   shot [file]               save a screenshot of the TV screen (default /tmp/tv.jpg)
const fs = require('fs');
const http = require('http');
const path = require('path');
const TV_IP = process.env.TV_IP;
if (!TV_IP) {
  console.error('Set TV_IP to the TV\'s address, e.g. TV_IP=192.168.1.50 node tools/tv.js info');
  process.exit(1);
}

const lgtv = require('lgtv2')({
  url: `ws://${TV_IP}:3000`,
  keyFile: path.join(__dirname, '.tvkey'),
  timeout: 15000,
  reconnect: false,
});

const [cmd = 'info', arg, payload] = process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(uri, body) {
  return new Promise((resolve, reject) =>
    lgtv.request(uri, body || {}, (err, res) => (err ? reject(err) : resolve(res))));
}

lgtv.on('prompt', () => console.log('>> Accept the connection request on the TV with the remote.'));
lgtv.on('error', (e) => { console.error('error:', e.message || e); process.exit(1); });

lgtv.on('connect', async () => {
  try {
    if (cmd === 'info') {
      const sys = await req('ssap://system/getSystemInfo');
      const sw = await req('ssap://com.webos.service.update/getCurrentSWInformation');
      console.log(JSON.stringify({ sys, sw }, null, 2));
    } else if (cmd === 'apps') {
      const r = await req('ssap://com.webos.applicationManager/listApps');
      r.apps.forEach((a) => console.log(a.id.padEnd(45), a.title));
    } else if (cmd === 'launch') {
      console.log(await req('ssap://system.launcher/launch', { id: arg }));
    } else if (cmd === 'foreground') {
      console.log((await req('ssap://com.webos.applicationManager/getForegroundAppInfo')).appId);
    } else if (cmd === 'keys') {
      const sock = await new Promise((resolve, reject) => lgtv.getSocket(
        'ssap://com.webos.service.networkinput/getPointerInputSocket',
        (err, s) => (err ? reject(err) : resolve(s))));
      for (const key of arg.split(',')) {
        if (key === 'WAIT') await sleep(1500);
        else { sock.send('button', { name: key }); await sleep(450); }
      }
      await sleep(300);
    } else if (cmd === 'shot') {
      const r = await req('ssap://tv/executeOneShot', { path: '/tmp/capture.jpg', method: 'DISPLAY', format: 'JPG' });
      const out = arg || '/tmp/tv.jpg';
      await new Promise((resolve, reject) => http.get(r.imageUri, (res) => {
        res.pipe(fs.createWriteStream(out)).on('finish', resolve);
      }).on('error', reject));
      console.log(out);
    } else if (cmd === 'request') {
      console.log(JSON.stringify(await req(arg, payload && JSON.parse(payload)), null, 2));
    }
  } catch (e) {
    console.error('request failed:', e.message || e);
  }
  lgtv.disconnect();
});
