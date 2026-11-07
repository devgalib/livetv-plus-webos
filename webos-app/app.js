// Live TV+ for LG webOS. Written for the TV's older Chromium (webOS 4.5 = Chrome 53):
// no async/await, object spread, optional chaining, padStart or Object.values.
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27, BACKSPACE: 8,
    CH_UP: 33, CH_DOWN: 34, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457,
  };
  // Tried in order on first launch until one plays; the user can pick another with Green.
  var DEFAULT_START = [
    'EkusheyTV.bd', 'News21BanglaTV.bd', 'NANTV.bd', 'ABPAnanda.in', 'Zee24Ghanta.in',
    'BBCNews.uk', 'AlJazeera.qa', 'NDTVIndia.in', 'IndiaToday.in', 'AajTak.in',
  ];
  var GROUP_TITLES = { news: 'News', kids: 'Kids', movies: 'Movies', music: 'Music' };
  var REGION_FLAGS = { Bangladesh: 'BD', India: 'IN', International: 'World' };
  var LOAD_TIMEOUT_MS = 20000;
  var OSD_MS = 5000;
  var rows = 9;          // channel rows that fit on screen; measured when the guide opens

  var isWebOS = /web0s|webos/i.test(navigator.userAgent);
  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  // ---------- storage ----------
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  // ---------- channels & sections ----------
  var channels = (window.CHANNELS || []).map(function (c, i) {
    c.num = i + 1;
    return c;
  });
  var byId = {};
  channels.forEach(function (c) { byId[c.id] = c; });

  var favs = load('favs', []).filter(function (id) { return byId[id]; });
  var startId = load('startChannel', null);

  var sections = [{ key: 'fav', title: 'Favourites', head: 'My TV' }];
  ['news', 'kids', 'movies', 'music'].forEach(function (g) {
    var first = true;
    ['Bangladesh', 'India', 'International'].forEach(function (r) {
      var list = channels.filter(function (c) { return c.group === g && c.region === r; });
      if (!list.length) return;
      sections.push({ key: g + '|' + r, title: r, fullTitle: GROUP_TITLES[g] + ' · ' + r, head: first ? GROUP_TITLES[g] : null, items: list });
      first = false;
    });
  });
  function sectionItems(s) {
    return s.key === 'fav' ? favs.map(function (id) { return byId[id]; }) : s.items;
  }
  function sectionOf(ch) {
    for (var i = 1; i < sections.length; i++) if (sections[i].items.indexOf(ch) >= 0) return i;
    return 1;
  }

  // ---------- helpers ----------
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function clock() { var d = new Date(); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function initials(name) {
    return name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w.charAt(0); }).join('').toUpperCase() || 'TV';
  }
  function setLogo(img, fallbackEl, ch) {
    // Show the logo straight away (it is usually cached) and fall back to initials if it fails.
    fallbackEl.textContent = initials(ch.name);
    fallbackEl.style.display = ch.logo ? 'none' : '';
    img.style.display = ch.logo ? '' : 'none';
    img.onerror = function () { img.style.display = 'none'; fallbackEl.style.display = ''; };
    if (ch.logo) img.src = ch.logo; else img.removeAttribute('src');
  }
  var toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.add('hidden'); }, 2500);
  }
  function showStatus(text, isError) {
    $('statusText').textContent = text;
    $('status').classList.toggle('error', !!isError);
    $('status').classList.remove('hidden');
  }
  function hideStatus() { $('status').classList.add('hidden'); }

  // ---------- player ----------
  var current = null;     // channel being played
  var zapSection = 1;     // section that Up/Down and CH+/- move through
  var attempts = [];      // [{url, engine}] still to try for the current channel
  var hls = null;
  var loadTimer = null;
  var fallbackQueue = null; // when set, failures move on to the next channel in this list

  function stopEngine() {
    clearTimeout(loadTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    try { video.load(); } catch (e) { /* ignore */ }
  }

  function buildAttempts(ch) {
    var list = [];
    var hlsOk = window.Hls && window.Hls.isSupported();
    ch.urls.forEach(function (url) {
      // The TV's own player is smoothest; hls.js is the backup (and what desktop browsers use).
      if (isWebOS || !hlsOk) list.push({ url: url, engine: 'native' });
      if (hlsOk) list.push({ url: url, engine: 'hls' });
    });
    return list;
  }

  function play(ch, opts) {
    opts = opts || {};
    current = ch;
    fallbackQueue = opts.fallback || null;
    if (opts.section !== undefined) zapSection = opts.section;
    save('lastChannel', ch.id);
    attempts = buildAttempts(ch);
    showOsd();
    if (homeOpen) renderHome();
    nextAttempt();
  }

  function nextAttempt() {
    stopEngine();
    if (!navigator.onLine) {
      showStatus('No internet connection.\nCheck the TV’s Wi-Fi — playback starts again automatically.', true);
      return;
    }
    var a = attempts.shift();
    if (!a) return channelFailed();
    showStatus('Loading ' + current.name + '…');
    loadTimer = setTimeout(nextAttempt, LOAD_TIMEOUT_MS);
    if (a.engine === 'hls') {
      hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20, backBufferLength: 10 });
      var recovered = false;
      hls.on(window.Hls.Events.ERROR, function (evt, data) {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); }
        else nextAttempt();
      });
      hls.loadSource(a.url);
      hls.attachMedia(video);
    } else {
      video.src = a.url;
    }
    var p = video.play();
    if (p && p.catch) p.catch(function () { /* autoplay errors surface via the video events */ });
  }

  function channelFailed() {
    if (fallbackQueue && fallbackQueue.length) {
      var next = fallbackQueue.shift();
      toast(current.name + ' is off air — switching to ' + next.name);
      play(next, { section: sectionOf(next), fallback: fallbackQueue });
      return;
    }
    showStatus(current.name + ' is not available right now.\nPress ▲ ▼ to change channel or OK for the list.', true);
  }

  video.addEventListener('playing', function () {
    clearTimeout(loadTimer);
    hideStatus();
  });
  video.addEventListener('waiting', function () {
    if (current) showStatus('Loading ' + current.name + '…');
  });
  video.addEventListener('error', function () {
    if (!hls && current) nextAttempt();
  });
  video.addEventListener('ended', function () {
    if (current) play(current, { fallback: fallbackQueue });
  });

  window.addEventListener('offline', function () {
    stopEngine();
    showStatus('No internet connection.\nCheck the TV’s Wi-Fi — playback starts again automatically.', true);
  });
  window.addEventListener('online', function () {
    if (current) play(current, { fallback: fallbackQueue });
  });

  function zap(step) {
    var list = sectionItems(sections[zapSection]);
    if (!list.length) { zapSection = sectionOf(current); list = sectionItems(sections[zapSection]); }
    var i = list.indexOf(current);
    var next = list[(i + step + list.length) % list.length];
    play(next);
  }

  // ---------- channel banner ----------
  var osdTimer;
  function showOsd() {
    if (!current || homeOpen) return;
    $('osdNum').textContent = current.num;
    $('osdName').textContent = current.name;
    $('osdFav').style.display = favs.indexOf(current.id) >= 0 ? '' : 'none';
    var meta = GROUP_TITLES[current.group] + '  ·  ' + current.region;
    if (startChannel() === current) meta += '  ·  Startup channel';
    $('osdMeta').textContent = meta;
    $('osdClock').textContent = clock();
    setLogo($('osdLogo'), $('osdInitials'), current);
    $('osd').classList.remove('hidden');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { $('osd').classList.add('hidden'); }, OSD_MS);
  }

  // ---------- number entry ----------
  var digits = '';
  var digitTimer;
  function enterDigit(d) {
    digits = (digits + d).slice(-3);
    $('numEntry').textContent = digits;
    $('numEntry').classList.remove('hidden');
    clearTimeout(digitTimer);
    digitTimer = setTimeout(function () {
      var ch = channels[parseInt(digits, 10) - 1];
      digits = '';
      $('numEntry').classList.add('hidden');
      if (ch) play(ch, { section: sectionOf(ch) });
      else toast('No channel with that number');
    }, 1500);
  }

  // ---------- guide ----------
  var guideOpen = false;
  var focus = 'list';   // 'sections' | 'list'
  var secIdx = 1;
  var rowIdx = 0;

  var guideFromHome = false;
  function openGuide(section) {
    guideOpen = true;
    guideFromHome = homeOpen;
    if (homeOpen) hideHome();
    secIdx = section === undefined ? zapSection : section;
    var items = sectionItems(sections[secIdx]);
    rowIdx = Math.max(0, items.indexOf(current));
    focus = items.length ? 'list' : 'sections';
    $('osd').classList.add('hidden');
    renderSections();
    $('guide').classList.remove('hidden');
    renderList(); // fills the title and footer first, so the space left for rows is final
    var rowEl = document.createElement('li');
    $('list').innerHTML = '';
    $('list').appendChild(rowEl);
    var rowH = rowEl.offsetHeight + parseFloat(getComputedStyle(rowEl).marginBottom);
    rows = Math.max(3, Math.floor($('list').clientHeight / rowH));
    renderList();
    tickClock();
  }
  function closeGuide(toHome) {
    guideOpen = false;
    $('guide').classList.add('hidden');
    if (toHome && guideFromHome) showHome();
    guideFromHome = false;
  }

  function renderSections() {
    var ul = $('sections');
    var active = null;
    ul.innerHTML = '';
    sections.forEach(function (s, i) {
      if (s.head) {
        var h = document.createElement('li');
        h.className = 'head';
        h.textContent = s.head;
        ul.appendChild(h);
      }
      var li = document.createElement('li');
      li.className = i === secIdx ? 'active' : '';
      li.innerHTML = '<span></span><span class="count"></span>';
      li.firstChild.textContent = s.key === 'fav' ? '★ ' + s.title : s.title;
      li.lastChild.textContent = sectionItems(s).length;
      li.addEventListener('click', function () { secIdx = i; rowIdx = 0; focus = 'list'; renderSections(); renderList(); });
      ul.appendChild(li);
      if (i === secIdx) active = li;
    });
    $('guide').className = 'guide focus-' + focus;
    // Keep the highlighted section (and its heading) in view when the column is taller than the screen.
    var top = active.previousSibling && active.previousSibling.className === 'head' ? active.previousSibling.offsetTop : active.offsetTop;
    if (top < ul.scrollTop) ul.scrollTop = top;
    var bottom = active.offsetTop + active.offsetHeight;
    if (bottom > ul.scrollTop + ul.clientHeight) ul.scrollTop = bottom - ul.clientHeight;
  }

  function renderList() {
    if (!guideOpen) return;
    var s = sections[secIdx];
    var items = sectionItems(s);
    $('listTitle').textContent = s.key === 'fav' ? '★ Favourites' : s.fullTitle;
    $('listEmpty').classList.toggle('hidden', !!items.length || s.key !== 'fav');
    $('listPos').textContent = items.length ? (rowIdx + 1) + ' / ' + items.length : '';
    rowIdx = Math.min(rowIdx, Math.max(0, items.length - 1));
    // Only the visible rows are in the DOM, so long lists stay fast on the TV.
    var start = Math.max(0, Math.min(rowIdx - Math.floor(rows / 2), items.length - rows));
    var ul = $('list');
    ul.innerHTML = '';
    var startCh = startChannel();
    items.slice(start, start + rows).forEach(function (ch, k) {
      var i = start + k;
      var li = document.createElement('li');
      li.className = (i === rowIdx ? 'selected ' : '') + (ch === current ? 'playing' : '');
      li.innerHTML =
        '<span class="row-num"></span><span class="row-logo"><img alt=""><span></span></span>' +
        '<span class="row-name"></span><span class="row-tags"></span>';
      li.children[0].textContent = ch.num;
      setLogo(li.children[1].children[0], li.children[1].children[1], ch);
      li.children[2].textContent = ch.name;
      li.children[3].innerHTML = (favs.indexOf(ch.id) >= 0 ? '<span class="fav">★</span>' : '') +
        (ch === startCh ? '<span class="start">START</span>' : '');
      li.addEventListener('click', function () { rowIdx = i; play(ch, { section: secIdx }); closeGuide(); });
      ul.appendChild(li);
    });
    $('guide').className = 'guide focus-' + focus;
  }

  function guideKey(code) {
    var items = sectionItems(sections[secIdx]);
    if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) {
      if (focus === 'sections' && items.length) { focus = 'list'; renderList(); } else closeGuide(true);
    } else if (focus === 'sections') {
      if (code === KEY.UP || code === KEY.DOWN) {
        secIdx = (secIdx + (code === KEY.UP ? -1 : 1) + sections.length) % sections.length;
        rowIdx = 0;
        renderSections();
        renderList();
      } else if ((code === KEY.RIGHT || code === KEY.OK) && items.length) {
        focus = 'list';
        renderList();
      }
    } else {
      if (code === KEY.UP || code === KEY.DOWN) {
        rowIdx = (rowIdx + (code === KEY.UP ? -1 : 1) + items.length) % items.length;
        renderList();
      } else if (code === KEY.CH_UP || code === KEY.CH_DOWN) {
        rowIdx = Math.max(0, Math.min(items.length - 1, rowIdx + (code === KEY.CH_UP ? -rows : rows)));
        renderList();
      } else if (code === KEY.LEFT) {
        focus = 'sections';
        renderSections();
      } else if (code === KEY.OK && items[rowIdx]) {
        play(items[rowIdx], { section: secIdx });
        closeGuide();
      } else if (code === KEY.YELLOW && items[rowIdx]) {
        toggleFav(items[rowIdx]);
      } else if (code === KEY.GREEN && items[rowIdx]) {
        setStart(items[rowIdx]);
      }
    }
  }

  // ---------- favourites & startup channel ----------
  function toggleFav(ch) {
    var i = favs.indexOf(ch.id);
    if (i >= 0) { favs.splice(i, 1); toast('Removed ' + ch.name + ' from favourites'); }
    else { favs.push(ch.id); toast('★ Added ' + ch.name + ' to favourites'); }
    save('favs', favs);
    if (guideOpen) {
      if (sections[secIdx].key === 'fav' && !favs.length) focus = 'sections';
      renderSections();
      renderList();
    }
  }
  function startChannel() {
    if (startId && byId[startId]) return byId[startId];
    for (var i = 0; i < DEFAULT_START.length; i++) if (byId[DEFAULT_START[i]]) return byId[DEFAULT_START[i]];
    return channels.filter(function (c) { return c.group === 'news'; })[0] || channels[0];
  }
  function setStart(ch) {
    startId = ch.id;
    save('startChannel', ch.id);
    toast(ch.name + ' will play when the TV turns on');
    if (guideOpen) renderList();
  }

  // ---------- Home helper service (boot start, Home button, app dock) ----------
  var SERVICE = 'luna://com.devgalib.livetv.service/';
  var bridges = [];
  function callService(method, params, cb) {
    if (!window.PalmServiceBridge) { if (cb) cb(null); return; }
    var bridge = new window.PalmServiceBridge();
    bridges.push(bridge); // keep a reference until the reply arrives
    bridge.onservicecallback = function (msg) {
      bridges.splice(bridges.indexOf(bridge), 1);
      var res = null;
      try { res = JSON.parse(msg); } catch (e) { /* ignore */ }
      if (cb) cb(res);
    };
    bridge.call(SERVICE + method, JSON.stringify(params || {}));
  }

  // Shown first in the dock, in this order, when installed. Everything else follows.
  var PREFERRED_APPS = [
    'youtube.leanback.v4', 'amazon', 'yupptv', 'com.hungama.lgtvapp', 'com.nettv.app', 'channelnewsasia',
    'tv.vixi.kiddiestv', 'tv.vixi.kiddo', 'tv.vixi.mumbojumbokids', 'com.webos.app.browser',
    'com.webos.app.photovideo', 'com.webos.app.music',
  ];
  var HIDDEN_APPS = ['com.devgalib.livetv', 'com.webos.app.livetv', 'com.webos.app.home', 'com.webos.app.fullhome'];
  var DESKTOP_APPS = [
    { id: 'youtube.leanback.v4', title: 'YouTube' }, { id: 'amazon', title: 'Prime Video' },
    { id: 'yupptv', title: 'YuppTV' }, { id: 'com.webos.app.browser', title: 'Web Browser' },
    { id: 'com.webos.app.hdmi1', title: 'HDMI1' }, { id: 'com.palm.app.settings', title: 'Settings' },
  ];
  var apps = window.PalmServiceBridge ? [] : DESKTOP_APPS;
  var helper = window.PalmServiceBridge ? null : { connected: true };

  function sortApps(list) {
    var rank = function (a) { var i = PREFERRED_APPS.indexOf(a.id); return i < 0 ? PREFERRED_APPS.length : i; };
    return list.filter(function (a) { return HIDDEN_APPS.indexOf(a.id) < 0; })
      .map(function (a, i) { a.order = i; return a; })
      .sort(function (a, b) { return rank(a) - rank(b) || a.order - b.order; });
  }

  var appsTries = 0;
  function loadApps() {
    callService('apps', {}, function (res) {
      if (res && res.returnValue && res.apps && res.apps.length) {
        apps = sortApps(res.apps);
        if (homeOpen) renderHome();
      } else if (++appsTries < 30) setTimeout(loadApps, 4000);
    });
  }
  function refreshHelper() {
    callService('status', {}, function (res) {
      if (res && res.returnValue) helper = res;
      renderHelperState();
    });
  }
  function renderHelperState() {
    var text = '';
    if (window.PalmServiceBridge) {
      if (!helper) text = 'Home helper is starting\u2026';
      else if (helper.waitingForApproval) text = 'Press OK on the TV\u2019s connection prompt to turn on the Home helper';
      else if (!helper.connected) text = 'Home helper is connecting\u2026';
      else if (helper.pausedUntil > Date.now()) text = 'Home helper paused \u2014 press Blue to resume';
    }
    $('homeHelper').textContent = text;
  }

  // ---------- home screen ----------
  var homeOpen = false;
  var rowsData = [];
  var homeRow = 0;
  var homeCols = {};
  var homeIdleTimer;
  var HOME_IDLE_MS = 45000;
  var MAX_ROW_TILES = 24;

  function pick(group, perRegion) {
    var out = [];
    ['Bangladesh', 'India', 'International'].forEach(function (r) {
      out = out.concat(channels.filter(function (c) { return c.group === group && c.region === r; }).slice(0, perRegion[r] || 0));
    });
    return out.slice(0, MAX_ROW_TILES);
  }
  function sectionKeyIndex(key) {
    for (var i = 0; i < sections.length; i++) if (sections[i].key.indexOf(key) === 0) return i;
    return 1;
  }

  // Drawn rather than a font glyph: the TV's fonts lack symbols like U+2630.
  var LIST_ICON = '<svg width="34%" viewBox="0 0 24 18" fill="#fff"><rect y="0" width="24" height="3" rx="1.5"/>' +
    '<rect y="7.5" width="24" height="3" rx="1.5"/><rect y="15" width="24" height="3" rx="1.5"/></svg>';

  function buildRows() {
    var dock = [{ type: 'action', id: 'watch', title: 'Watch', glyph: '\u25B6' },
      { type: 'action', id: 'guide', title: 'All channels', svg: LIST_ICON }]
      .concat(apps.map(function (a) { return { type: 'app', app: a, title: a.title }; }))
      .concat([{ type: 'app', app: { id: 'com.webos.app.home', title: 'LG Home' }, title: 'LG Home' }]);
    var rows = [{ title: 'Apps', items: dock }];
    var chRow = function (title, list, sectionKey) {
      if (!list.length) return;
      rows.push({ title: title, items: list.map(function (c) { return { type: 'channel', ch: c, title: c.name }; })
        .concat([{ type: 'action', id: 'more', section: sectionKey, title: 'More ' + title.toLowerCase(), glyph: '\u2026' }]) });
    };
    if (favs.length) chRow('Favourites', favs.map(function (id) { return byId[id]; }), 'fav');
    chRow('News', pick('news', { Bangladesh: 10, India: 8, International: 8 }), 'news');
    chRow('Kids', pick('kids', { Bangladesh: 4, India: 10, International: 10 }), 'kids');
    chRow('Movies', pick('movies', { Bangladesh: 4, India: 10, International: 10 }), 'movies');
    chRow('Music', pick('music', { Bangladesh: 4, India: 16, International: 4 }), 'music');
    rowsData = rows;
  }

  function tileHtml(item) {
    var cls = 'tile ' + item.type;
    var art = '';
    if (item.type === 'channel') {
      art = (item.ch.logo ? '<img src="' + encodeURI(item.ch.logo) + '" alt="">' : '') +
        '<span class="tile-initials"' + (item.ch.logo ? ' style="display:none"' : '') + '></span>' +
        (item.ch === current ? '<span class="live-dot"></span>' : '') +
        (favs.indexOf(item.ch.id) >= 0 ? '<span class="fav-mark">\u2605</span>' : '');
    } else if (item.type === 'app') {
      var icon = item.app.icon ? (/^https?:/.test(item.app.icon) ? item.app.icon : 'file://' + item.app.icon) : '';
      art = (icon ? '<img src="' + encodeURI(icon) + '" alt="">' : '') +
        '<span class="tile-initials"' + (item.app.icon ? ' style="display:none"' : '') + '></span>';
    } else {
      art = item.svg || '<span class="tile-glyph"></span>';
    }
    return '<div class="' + cls + '"><div class="tile-art"' +
      (item.type === 'app' && item.app.bgColor ? ' style="background:' + item.app.bgColor.replace(/[^#0-9a-zA-Z(),. ]/g, '') + '"' : '') +
      '>' + art + '</div><div class="tile-name"></div></div>';
  }

  function renderHome() {
    buildRows();
    var html = '';
    rowsData.forEach(function (row) {
      html += '<div class="shelf-row"><div class="shelf-row-title"></div><div class="tiles">' +
        row.items.map(tileHtml).join('') + '</div></div>';
    });
    $('rows').innerHTML = html;
    var rowEls = $('rows').children;
    rowsData.forEach(function (row, r) {
      rowEls[r].firstChild.textContent = row.title;
      var tiles = rowEls[r].lastChild.children;
      row.items.forEach(function (item, c) {
        var tile = tiles[c];
        tile.lastChild.textContent = item.title;
        var initials = tile.querySelector('.tile-initials');
        if (initials) initials.textContent = initialsOf(item.title);
        var glyph = tile.querySelector('.tile-glyph');
        if (glyph) glyph.textContent = item.glyph;
        var img = tile.querySelector('img');
        if (img) img.onerror = function () { img.style.display = 'none'; initials.style.display = ''; };
        tile.addEventListener('click', function () { homeRow = r; homeCols[r] = c; activateTile(item); });
      });
    });
    homeRow = Math.min(homeRow, rowsData.length - 1);
    $('homeNowName').textContent = current ? current.num + '  ' + current.name : '';
    $('homeClock').textContent = clock();
    renderHelperState();
    updateFocus();
  }
  function initialsOf(name) { return initials(name); }

  function updateFocus() {
    var rowEls = $('rows').children;
    if (!rowEls.length) return;
    var rowH = rowEls[0].offsetHeight;
    // Keep the focused row at the top of the shelf (the row above stays visible when there is room).
    $('rows').style.transform = 'translateY(' + (-Math.max(0, homeRow) * rowH) + 'px)';
    for (var r = 0; r < rowEls.length; r++) {
      rowEls[r].className = 'shelf-row' + (r === homeRow ? ' current' : '');
      var tiles = rowEls[r].lastChild;
      var col = Math.min(homeCols[r] || 0, rowsData[r].items.length - 1);
      homeCols[r] = col;
      for (var c = 0; c < tiles.children.length; c++) tiles.children[c].classList.toggle('focus', r === homeRow && c === col);
      // Scroll the row so the focused tile stays on screen, with one tile of context on the left.
      var tileW = tiles.children[0].offsetWidth + parseFloat(getComputedStyle(tiles.children[0]).marginRight);
      var visible = Math.floor((window.innerWidth - tiles.parentNode.offsetLeft - tileW * 0.5) / tileW);
      var first = Math.max(0, Math.min(col - 1, tiles.children.length - visible));
      tiles.style.transform = 'translateX(' + (-first * tileW) + 'px)';
    }
  }

  function showHome() {
    homeOpen = true;
    document.body.classList.add('home-open');
    $('osd').classList.add('hidden');
    renderHome();
    $('home').classList.remove('hidden');
    bumpHomeIdle();
  }
  function hideHome() {
    homeOpen = false;
    clearTimeout(homeIdleTimer);
    document.body.classList.remove('home-open');
    $('home').classList.add('hidden');
  }
  // After a while without key presses the shelf fades away and the channel plays full screen.
  function bumpHomeIdle() {
    clearTimeout(homeIdleTimer);
    homeIdleTimer = setTimeout(function () {
      if (homeOpen && !guideOpen) { hideHome(); showOsd(); }
    }, HOME_IDLE_MS);
  }

  function focusedItem() {
    var row = rowsData[homeRow];
    return row ? row.items[homeCols[homeRow] || 0] : null;
  }

  function activateTile(item) {
    if (!item) return;
    if (item.type === 'channel') {
      var sec = favs.indexOf(item.ch.id) >= 0 && rowsData[homeRow].title === 'Favourites' ? 0 : sectionOf(item.ch);
      if (item.ch !== current) play(item.ch, { section: sec });
      hideHome();
      showOsd();
    } else if (item.type === 'app') {
      openedAppAt = Date.now();
      callService('launch', { id: item.app.id }, function (res) {
        if (res && !res.returnValue) toast('Could not open ' + item.title);
      });
      if (!window.PalmServiceBridge) toast('Opens ' + item.title + ' on the TV');
    } else if (item.id === 'watch') {
      hideHome();
      showOsd();
    } else if (item.id === 'guide') {
      openGuide();
    } else if (item.id === 'more') {
      openGuide(item.section === 'fav' ? 0 : sectionKeyIndex(item.section));
    }
  }

  function homeKey(code) {
    bumpHomeIdle();
    var row = rowsData[homeRow];
    var col = homeCols[homeRow] || 0;
    if (code === KEY.LEFT && col > 0) homeCols[homeRow] = col - 1;
    else if (code === KEY.RIGHT && col < row.items.length - 1) homeCols[homeRow] = col + 1;
    else if (code === KEY.UP && homeRow > 0) homeRow--;
    else if (code === KEY.DOWN && homeRow < rowsData.length - 1) homeRow++;
    else if (code === KEY.OK) { activateTile(focusedItem()); return; }
    else if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) { hideHome(); showOsd(); return; }
    else if (code === KEY.CH_UP || code === KEY.CH_DOWN) { zap(code === KEY.CH_UP ? -1 : 1); renderHome(); return; }
    else if (code === KEY.YELLOW || code === KEY.GREEN) {
      var item = focusedItem();
      if (item && item.type === 'channel') {
        if (code === KEY.YELLOW) toggleFav(item.ch); else setStart(item.ch);
        renderHome();
      }
      return;
    } else return;
    updateFocus();
  }

  // ---------- keys ----------
  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;
    // Desktop testing: G/Y/B/I keys stand in for the Green, Yellow, Blue and Info remote buttons.
    if (!isWebOS) code = { 71: KEY.GREEN, 89: KEY.YELLOW, 66: KEY.BLUE, 73: KEY.INFO }[code] || code;
    e.preventDefault();
    if (code === KEY.BLUE) {
      callService('resume', {}, function (res) { if (res) { helper = res; renderHelperState(); } });
      toast('Home helper is on');
      return;
    }
    if (guideOpen) { guideKey(code); return; }
    if (homeOpen) { homeKey(code); return; }

    if (code >= 48 && code <= 57) enterDigit(code - 48);
    else if (code >= 96 && code <= 105) enterDigit(code - 96);
    else if (code === KEY.OK || code === KEY.LEFT || code === KEY.RIGHT) openGuide();
    else if (code === KEY.UP || code === KEY.CH_UP) zap(-1);
    else if (code === KEY.DOWN || code === KEY.CH_DOWN) zap(1);
    else if (code === KEY.INFO) showOsd();
    else if (code === KEY.YELLOW && current) { toggleFav(current); showOsd(); }
    else if (code === KEY.GREEN && current) { setStart(current); showOsd(); }
    else if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) showHome();
  });

  // ---------- clock, visibility, startup ----------
  function tickClock() {
    $('homeClock').textContent = clock();
    $('guideClock').textContent = clock();
    $('osdClock').textContent = clock();
  }
  setInterval(tickClock, 15000);

  // Stop streaming in the background. Coming back soon resumes the same channel; coming back
  // after a while (e.g. the TV was switched off) goes to the startup news channel.
  var AWAY_RESET_MS = 10 * 60 * 1000;
  var hiddenAt = 0;
  function resume() {
    closeGuide();
    var away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (!current || away > AWAY_RESET_MS) startUp();
    else if (away > 0) play(current, { fallback: fallbackQueue }); // the stream was stopped while hidden
    showHome();
    refreshHelper();
  }
  var openedAppAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      hiddenAt = Date.now();
      stopEngine();
      // Let the helper check whether LG Home is covering us (skipped right after opening an app from the dock).
      if (Date.now() - openedAppAt > 15000) callService('covered', {});
    } else {
      callService('uncovered', {});
      resume();
    }
  });

  function startUp() {
    if (!channels.length) { showStatus('No channels found.', true); return; }
    var first = startChannel();
    // If the startup channel is off air, keep trying other news channels so the TV never opens on a blank screen.
    var queue = DEFAULT_START.map(function (id) { return byId[id]; })
      .concat(channels.filter(function (c) { return c.group === 'news'; }))
      .filter(function (c, i, arr) { return c && c !== first && arr.indexOf(c) === i; })
      .slice(0, 15);
    play(first, { section: sectionOf(first), fallback: queue });
  }

  // With handlesRelaunch the app must bring itself to the front when launched again
  // (by the Home helper, or from the TV's app list).
  document.addEventListener('webOSRelaunch', function () {
    var sys = window.webOSSystem || window.PalmSystem;
    if (sys && sys.activate) sys.activate();
    resume();
  });

  startUp();
  showHome();
  callService('start', {}, function (res) {
    if (res && res.returnValue) helper = res;
    renderHelperState();
    loadApps();
    setTimeout(refreshHelper, 3000); // the helper usually finishes connecting a moment after starting
  });
  setInterval(refreshHelper, 20000);
})();
