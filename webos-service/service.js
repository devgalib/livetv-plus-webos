// Live TV+ Home helper: a background service shipped inside the app package.
//  - Brings Live TV+ up at boot (a persistent Activity Manager timer calls `tick`).
//  - Watches which app is on screen through the TV's local SSAP API and brings Live TV+
//    back when LG Home or the antenna "No signal / Not programmed" screen comes up.
//  - Lists and launches the TV's apps for the home screen dock.
// Pressing Home three times within 10 seconds pauses the helper for 10 minutes.
//
// Runs on the TV's Node.js (0.12 on webOS 4.5), so: ES5 only, Buffer constructor, no ws module.
'use strict';
var fs = require('fs');
var net = require('net');
var os = require('os');
var crypto = require('crypto');
var Service = require('webos-service');

var APP_ID = 'com.devgalib.livetv';
var SERVICE_ID = APP_ID + '.service';
var STATE_FILE = __dirname + '/state.json';
// After a reboot webOS may run the service as a user that can rewrite existing files in its
// folder but not create new ones, so state falls back to /tmp, and the "already opened this boot"
// mark lives in /tmp (cleared at every boot).
var TMP_STATE_FILE = '/tmp/' + APP_ID + '.state.json';
var BOOT_MARK = '/tmp/' + APP_ID + '.boot';
var LOG_FILE = __dirname + '/helper.log';
// Opening the app at boot only happens this soon after power-on, so it can never pull you out
// of another app later, whatever the state files say.
var BOOT_WINDOW_S = 300;
// Screens that Live TV+ replaces. com.webos.app.livetv is the antenna input that shows
// "No signal" / "Not programmed" on a TV without an aerial.
var REPLACE = ['com.webos.app.livetv', 'com.webos.app.home', 'com.webos.app.fullhome'];
var LG_HOME = 'com.webos.app.home';
var PAUSE_MS = 10 * 60 * 1000;
var ESCAPE_WINDOW_MS = 10000;

var service = new Service(SERVICE_ID);
var keepAlive = null;

// ---------- state & log ----------
var memState = null;
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function readState() {
  if (!memState) {
    var main = readJson(STATE_FILE);
    var tmp = readJson(TMP_STATE_FILE);
    memState = (tmp && (!main || (tmp.savedAt || 0) > (main.savedAt || 0)) ? tmp : main) || { enabled: true };
  }
  return memState;
}
// Returns true when the state reached a file.
function writeState(patch) {
  var s = readState();
  for (var k in patch) if (patch.hasOwnProperty(k)) s[k] = patch[k];
  s.savedAt = Date.now();
  var text = JSON.stringify(s);
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', text);
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    return true;
  } catch (e) { /* folder not writable: rewrite the existing file in place */ }
  try { fs.writeFileSync(STATE_FILE, text); return true; } catch (e) { /* file not writable either */ }
  try { fs.writeFileSync(TMP_STATE_FILE, text); return true; } catch (e) { log('state write failed: ' + e); }
  return false;
}
function log(text) {
  try {
    var size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch (e) { /* no log yet */ }
    if (size > 200000) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n');
  } catch (e) { /* logging is best effort */ }
}
function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return ''; }
}
function uptimeSeconds() {
  try { return parseFloat(fs.readFileSync('/proc/uptime', 'utf8')); } catch (e) { return Infinity; }
}

// ---------- once per boot ----------
var openedBoot = '';
function openedThisBoot(boot) {
  if (openedBoot === boot) return true;
  try {
    if (fs.readFileSync(BOOT_MARK, 'utf8').trim() === boot) { openedBoot = boot; return true; }
  } catch (e) { /* no mark yet */ }
  if (readState().lastBoot === boot) { openedBoot = boot; return true; }
  return false;
}
// Remembers that Live TV+ was opened for this boot. Returns false when nothing could be saved.
function markOpened(boot) {
  openedBoot = boot;
  var saved = false;
  try { fs.writeFileSync(BOOT_MARK, boot); saved = true; } catch (e) { log('boot mark failed: ' + e); }
  if (writeState({ lastBoot: boot })) saved = true;
  return saved;
}
function paused() {
  return Date.now() < (readState().pausedUntil || 0);
}

// ---------- minimal WebSocket client (text frames only) ----------
function connectWs(host, port, handlers) {
  var sock = net.connect(port, host);
  var buf = new Buffer(0);
  var open = false;
  var text = '';
  var ended = false;

  function frame(op, data) {
    var payload = Buffer.isBuffer(data) ? data : new Buffer(data, 'utf8');
    var len = payload.length;
    var header;
    if (len < 126) { header = new Buffer(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = new Buffer(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = new Buffer(10); header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    header[0] = 0x80 | op;
    var mask = crypto.randomBytes(4);
    var masked = new Buffer(len);
    for (var i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    sock.write(Buffer.concat([header, mask, masked]));
  }

  function parse() {
    while (buf.length >= 2) {
      var b0 = buf[0];
      var b1 = buf[1];
      var len = b1 & 127;
      var off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      var maskKey = null;
      if (b1 & 128) { if (buf.length < off + 4) return; maskKey = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      var payload = buf.slice(off, off + len);
      if (maskKey) for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      buf = buf.slice(off + len);
      var op = b0 & 15;
      if (op === 0 || op === 1) {
        text += payload.toString('utf8');
        if (b0 & 128) { var msg = text; text = ''; handlers.message(msg); }
      } else if (op === 9) frame(10, payload);
      else if (op === 8) sock.end();
    }
  }

  sock.setNoDelay(true);
  sock.on('connect', function () {
    sock.write('GET / HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (!open) {
      var end = buf.toString('binary').indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!/^HTTP\/1\.[01] 101/.test(buf.slice(0, end).toString())) { sock.destroy(); return; }
      buf = buf.slice(end + 4);
      open = true;
      handlers.open();
    }
    parse();
  });
  function finish() {
    if (ended) return;
    ended = true;
    handlers.close(open);
  }
  sock.on('error', function (e) { log('ws ' + host + ' error: ' + e.code); finish(); });
  sock.on('close', finish);
  return {
    send: function (s) { if (open && !ended) frame(1, s); },
    close: function () { sock.destroy(); },
  };
}

// ---------- SSAP (the TV's local control API) ----------
var ssap = { ws: null, ready: false, prompting: false, hostIdx: 0, nextId: 1, pending: {}, retry: null };
var lastForeground = '';
var redirects = [];

function hosts() {
  var list = ['127.0.0.1'];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    ifs[name].forEach(function (a) { if (a.family === 'IPv4' && !a.internal) list.push(a.address); });
  });
  return list;
}

function pairing(signed) {
  var p = JSON.parse(fs.readFileSync(__dirname + '/pairing.json', 'utf8'));
  if (!signed) {
    delete p.manifest.signed;
    p.manifest.appVersion = '1.0';
  }
  var key = readState().clientKey;
  if (key) p['client-key'] = key;
  return p;
}

function ssapConnect() {
  if (ssap.ws) return;
  clearTimeout(ssap.retry);
  var list = hosts();
  var host = list[ssap.hostIdx % list.length];
  var signed = true;
  ssap.ws = connectWs(host, 3000, {
    open: function () {
      log('ssap connected to ' + host);
      ssap.ws.send(JSON.stringify({ type: 'register', id: 'register', payload: pairing(signed) }));
    },
    message: function (raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.id === 'register') {
        if (msg.type === 'registered') {
          ssap.ready = true;
          ssap.prompting = false;
          writeState({ clientKey: msg.payload['client-key'] });
          log('ssap registered');
          subscribeForeground();
        } else if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') {
          ssap.prompting = true;
          log('ssap waiting for the on-screen approval');
        } else if (msg.type === 'error') {
          log('ssap register error: ' + msg.error);
          if (signed) {
            signed = false;
            ssap.ws.send(JSON.stringify({ type: 'register', id: 'register', payload: pairing(false) }));
          }
        }
        return;
      }
      var cb = ssap.pending[msg.id];
      if (!cb) return;
      if (!cb.subscribe) delete ssap.pending[msg.id];
      cb.fn(msg.type === 'error' ? (msg.error || 'error') : null, msg.payload || {});
    },
    close: function (wasOpen) {
      log('ssap closed (' + host + ')');
      var pending = ssap.pending;
      ssap.ws = null;
      ssap.ready = false;
      ssap.pending = {};
      Object.keys(pending).forEach(function (id) { pending[id].fn('disconnected', {}); });
      if (!wasOpen) ssap.hostIdx++;
      ssap.retry = setTimeout(ssapConnect, wasOpen ? 2000 : 5000);
    },
  });
}

function ssapRequest(uri, payload, fn, subscribe) {
  if (!ssap.ready) { fn('not-connected', {}); return; }
  var id = 'r' + ssap.nextId++;
  ssap.pending[id] = { fn: fn, subscribe: !!subscribe };
  ssap.ws.send(JSON.stringify({ type: subscribe ? 'subscribe' : 'request', id: id, uri: uri, payload: payload || {} }));
}

function subscribeForeground() {
  ssapRequest('ssap://com.webos.applicationManager/getForegroundAppInfo', {}, function (err, res) {
    if (!err && res.appId !== undefined) onForeground(res.appId);
  }, true);
}

function toast(message) {
  ssapRequest('ssap://system.notifications/createToast', { message: message }, function () {});
}

// ---------- replacing LG screens ----------
function onForeground(appId) {
  if (appId === lastForeground) return;
  log('foreground: ' + (appId || '(none)'));
  lastForeground = appId;
  if (REPLACE.indexOf(appId) >= 0) bringBack(appId);
}

// LG Home on webOS 4.5 is an overlay: it hides Live TV+ without changing the foreground app.
// The app reports when it is hidden; if it is still the foreground app a moment later (so no
// other app is starting), the overlay is LG Home and Live TV+ comes back.
var coveredTimer = null;
function onCovered() {
  clearTimeout(coveredTimer);
  // Another app can take ~2.5 s to become the foreground app on webOS 4.5; only a cover that is
  // still there after 3.5 s counts as LG Home.
  log('app hidden, checking for LG Home');
  var checks = [1500, 2000];
  function check() {
    var delay = checks.shift();
    coveredTimer = setTimeout(function () {
      ssapRequest('ssap://com.webos.applicationManager/getForegroundAppInfo', {}, function (err, res) {
        if (err || res.appId !== APP_ID) return;
        if (checks.length) check(); else bringBack('LG Home overlay');
      });
    }, delay);
  }
  check();
}

function bringBack(what) {
  var state = readState();
  if (state.enabled === false || paused()) return;
  var now = Date.now();
  redirects = redirects.filter(function (t) { return now - t < ESCAPE_WINDOW_MS; });
  redirects.push(now);
  if (redirects.length >= 3) {
    redirects = [];
    writeState({ pausedUntil: now + PAUSE_MS });
    log('paused by repeated Home presses');
    toast('Live TV+ is paused for 10 minutes. Open Live TV+ from your apps to bring it back.');
    return;
  }
  log('bringing Live TV+ back over ' + what);
  launch(APP_ID, { from: 'helper', screen: what }, function (err, res) {
    log('launch result: ' + (err ? 'error ' + err : JSON.stringify(res)));
  });
}

function launch(id, params, cb) {
  if (ssap.ready) {
    ssapRequest('ssap://system.launcher/launch', { id: id, params: params || {} }, function (err, res) {
      if (!err) { cb(null, res); return; }
      lunaLaunch(id, params, cb);
    });
  } else lunaLaunch(id, params, cb);
}
function lunaLaunch(id, params, cb) {
  service.call('luna://com.webos.applicationManager/launch', { id: id, params: params || {} }, function (m) {
    cb(m.payload && m.payload.returnValue ? null : (m.payload && m.payload.errorText) || 'launch failed', m.payload);
  });
}

// ---------- boot ----------
function scheduleBootTimer(cb) {
  service.call('luna://com.palm.activitymanager/create', {
    activity: {
      name: APP_ID + '.boot',
      description: 'Starts Live TV+ when the TV turns on',
      type: { foreground: true, persist: true },
      schedule: { interval: '10s', precise: true },
      callback: { method: 'luna://' + SERVICE_ID + '/tick', params: {} },
    },
    start: true,
    replace: true,
    subscribe: false,
  }, function (m) {
    log('boot timer: ' + JSON.stringify(m.payload));
    if (cb) cb(m.payload);
  });
}

function ensureRunning() {
  if (!keepAlive) {
    service.activityManager.create('keepAlive', function (activity) { keepAlive = activity; });
  }
  ssapConnect();
}

function status() {
  var s = readState();
  return {
    returnValue: true,
    enabled: s.enabled !== false,
    paired: !!s.clientKey,
    connected: ssap.ready,
    waitingForApproval: ssap.prompting,
    pausedUntil: s.pausedUntil || 0,
    foreground: lastForeground,
    node: process.version,
  };
}

// ---------- service methods ----------
service.register('start', function (m) {
  ensureRunning();
  if (!readState().bootTimer) {
    scheduleBootTimer(function (r) { if (r && r.returnValue) writeState({ bootTimer: true }); });
  }
  // Opening the app counts as "the app is up for this boot".
  markOpened(bootId());
  m.respond(status());
});

service.register('status', function (m) {
  ensureRunning();
  m.respond(status());
});

var lastTickLog = 0;
service.register('tick', function (m) {
  if (Date.now() - lastTickLog > 60000) { lastTickLog = Date.now(); log('tick'); }
  ensureRunning();
  var state = readState();
  var boot = bootId();
  var result = { skipped: true };
  if (state.enabled !== false && boot && !openedThisBoot(boot) && uptimeSeconds() < BOOT_WINDOW_S) {
    // Save first and only launch if that worked, so a launch can never repeat.
    if (markOpened(boot)) {
      writeState({ pausedUntil: 0 });
      log('new boot, launching');
      result = { launched: true };
      launch(APP_ID, { from: 'boot' }, function (err) { if (err) log('boot launch failed: ' + err); });
    } else log('new boot, but nothing could be saved: not launching');
  }
  if (m.payload && m.payload.$activity && m.activity) {
    service.activityManager.complete(m.activity, { restart: true }, function () {
      m.respond({ returnValue: true, result: result });
    });
  } else m.respond({ returnValue: true, result: result });
});

service.register('apps', function (m) {
  ensureRunning();
  ssapRequest('ssap://com.webos.applicationManager/listLaunchPoints', {}, function (err, res) {
    if (err) { m.respond({ returnValue: false, errorText: String(err) }); return; }
    m.respond({
      returnValue: true,
      apps: (res.launchPoints || []).map(function (a) {
        return { id: a.id, title: a.title, icon: a.largeIcon || a.icon || '', bgColor: a.bgColor || '' };
      }),
    });
  });
});

service.register('launch', function (m) {
  ensureRunning();
  var id = m.payload.id;
  if (!id) { m.respond({ returnValue: false, errorText: 'id required' }); return; }
  // Opening LG's own Home on purpose pauses the helper so it doesn't bounce straight back.
  if (id === LG_HOME) writeState({ pausedUntil: Date.now() + PAUSE_MS });
  launch(id, m.payload.params, function (err) {
    m.respond(err ? { returnValue: false, errorText: String(err) } : { returnValue: true });
  });
});

service.register('covered', function (m) {
  ensureRunning();
  onCovered();
  m.respond({ returnValue: true });
});

service.register('uncovered', function (m) {
  clearTimeout(coveredTimer);
  m.respond({ returnValue: true });
});

service.register('setEnabled', function (m) {
  writeState({ enabled: m.payload.enabled !== false, pausedUntil: 0 });
  m.respond(status());
});

service.register('resume', function (m) {
  writeState({ pausedUntil: 0 });
  m.respond(status());
});

process.on('uncaughtException', function (e) { log('crash: ' + (e && e.stack || e)); });
process.on('exit', function (code) { log('exit ' + code); });
log('service started, node ' + process.version);
