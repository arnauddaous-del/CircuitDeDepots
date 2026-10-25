/* Circuit Dépôts — interface : caméra, liste, calcul du circuit. */
(function () {
  'use strict';

  var C = window.Circuit;
  var $ = function (s) { return document.querySelector(s); };
  var LS = { stops: 'circuit.stops.v1', table: 'circuit.table.v1', route: 'circuit.route.v1', opts: 'circuit.opts.v1' };

  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage plein ou bloqué */ } }

  var stops = load(LS.stops, []);
  var table = load(LS.table, {});
  var route = load(LS.route, null);
  var opts = Object.assign({ legSize: 10, usePosition: true }, load(LS.opts, {}));
  var editingId = null;

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function norm(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function persist() { save(LS.stops, stops); save(LS.route, route); }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2200);
  }

  /* ---------- Onglets ---------- */
  function showView(name) {
    ['scan', 'stops', 'route'].forEach(function (v) {
      $('#view-' + v).hidden = v !== name;
      $('#tab-' + v).setAttribute('aria-selected', String(v === name));
    });
    if (name !== 'scan') stopScan();
    if (name === 'stops') renderStops();
    if (name === 'route') renderRoute();
  }
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.dataset.view); });
  });

  /* ---------- Ajout d'un dépôt ---------- */
  function addFromRaw(raw) {
    var p = C.parseQR(raw, table);
    if (p.kind === 'error') { toast(p.message, 3200); return { ok: false, message: p.message }; }
    var key = p.kind === 'coords' ? p.lat.toFixed(5) + ',' + p.lon.toFixed(5) : norm(p.text);
    var rawKey = String(raw).trim();
    var dup = stops.some(function (s) { return s.key === key || s.raw === rawKey; });
    if (dup) { toast('Déjà dans la liste'); return { ok: false, duplicate: true, message: 'Déjà scanné' }; }
    var s = {
      id: uid(), raw: rawKey, key: key, done: false,
      label: p.kind === 'coords' ? p.label : p.text,
      lat: p.kind === 'coords' ? p.lat : null,
      lon: p.kind === 'coords' ? p.lon : null,
      resolved: '', status: p.kind === 'coords' ? 'ok' : 'pending'
    };
    stops.push(s);
    markStale();
    persist(); renderCounts(); renderStops();
    pump();
    return { ok: true, stop: s };
  }

  function markStale() { if (route) route.stale = true; }

  /* ---------- Géocodage : base adresse nationale, puis OpenStreetMap ---------- */
  var lastNominatim = 0;

  function fetchJSON(url, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 10000);
    return fetch(url, { signal: ctl.signal, headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }

  async function geocode(q) {
    var query = String(q).slice(0, 190);
    try {
      var r = await fetchJSON('https://api-adresse.data.gouv.fr/search/?limit=1&q=' + encodeURIComponent(query));
      var f = r.features && r.features[0];
      if (f && f.properties && f.properties.score >= 0.45) {
        return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.label };
      }
    } catch (e) { /* on essaie l'autre service */ }
    try {
      var wait = 1100 - (Date.now() - lastNominatim);
      if (wait > 0) await sleep(wait);
      lastNominatim = Date.now();
      var n = await fetchJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query));
      if (n && n[0]) return { lat: parseFloat(n[0].lat), lon: parseFloat(n[0].lon), label: n[0].display_name };
    } catch (e) { /* réseau */ }
    return null;
  }

  var pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      var next;
      while ((next = stops.find(function (s) { return s.status === 'pending'; }))) {
        var g = await geocode(next.label);
        var still = stops.find(function (s) { return s.id === next.id; });
        if (!still) continue;
        if (g && isFinite(g.lat) && isFinite(g.lon)) {
          still.lat = g.lat; still.lon = g.lon; still.resolved = g.label; still.status = 'ok';
        } else {
          still.status = 'error';
        }
        persist(); renderCounts(); renderStops();
      }
    } finally { pumping = false; }
    var errs = stops.filter(function (s) { return s.status === 'error'; }).length;
    if (errs) toast(errs + ' adresse(s) introuvable(s). Corrigez-les dans « Dépôts ».', 3600);
  }

  /* ---------- Affichage de la liste ---------- */
  function renderCounts() {
    var ok = stops.filter(function (s) { return s.status === 'ok'; }).length;
    var pend = stops.filter(function (s) { return s.status === 'pending'; }).length;
    var err = stops.filter(function (s) { return s.status === 'error'; }).length;
    $('#count-stops').textContent = stops.length;
    var parts = [];
    if (!stops.length) parts.push('Aucun dépôt scanné');
    else {
      parts.push(stops.length + (stops.length > 1 ? ' dépôts' : ' dépôt'));
      parts.push(ok + ' localisé' + (ok > 1 ? 's' : ''));
      if (pend) parts.push(pend + ' en cours');
      if (err) parts.push(err + ' à corriger');
    }
    $('#summary').textContent = parts.join(' · ');
  }

  function renderStops() {
    var ul = $('#stops-list');
    $('#stops-empty').hidden = stops.length > 0;
    $('#btn-clear').hidden = stops.length === 0;
    $('#btn-retry').hidden = !stops.some(function (s) { return s.status === 'error'; });
    ul.innerHTML = stops.map(function (s, i) {
      var chip = s.status === 'ok' ? '<span class="chip ok">Localisé</span>'
        : s.status === 'pending' ? '<span class="chip pending">Recherche…</span>'
        : '<span class="chip error">Adresse introuvable</span>';
      var edit = editingId === s.id
        ? '<form class="edit" data-edit="' + s.id + '"><input type="text" value="' + esc(s.label) + '" aria-label="Adresse"><button class="mini" type="submit">Valider</button><button class="mini" type="button" data-act="cancel">Annuler</button></form>'
        : '';
      return '<li class="stop' + (s.done ? ' done' : '') + '" data-id="' + s.id + '">' +
        '<div class="n">' + (s.done ? '✓' : (i + 1)) + '</div>' +
        '<div class="addr">' + esc(s.label) + (s.resolved && s.status === 'ok' ? '<span class="res">' + esc(s.resolved) + '</span>' : '') + chip + '</div>' +
        '<div class="acts"><button class="mini" data-act="edit">Modifier</button><button class="mini bad" data-act="del" aria-label="Supprimer ce dépôt">Retirer</button></div>' +
        edit + '</li>';
    }).join('');
    var inp = ul.querySelector('.edit input');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }

  $('#stops-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var li = btn.closest('.stop'); if (!li) return;
    var id = li.dataset.id, act = btn.dataset.act;
    if (act === 'del') {
      stops = stops.filter(function (s) { return s.id !== id; });
      markStale(); persist(); renderCounts(); renderStops();
    } else if (act === 'edit') { editingId = id; renderStops(); }
    else if (act === 'cancel') { editingId = null; renderStops(); }
  });
  $('#stops-list').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target.closest('form[data-edit]'); if (!form) return;
    var s = stops.find(function (x) { return x.id === form.dataset.edit; });
    var v = form.querySelector('input').value.trim();
    editingId = null;
    if (s && v) {
      var c = C.parseQR(v, table);
      s.label = c.kind === 'address' ? c.text : v;
      if (c.kind === 'coords') { s.lat = c.lat; s.lon = c.lon; s.status = 'ok'; s.resolved = ''; }
      else { s.status = 'pending'; s.lat = null; s.lon = null; s.resolved = ''; }
      s.key = c.kind === 'coords' ? c.lat.toFixed(5) + ',' + c.lon.toFixed(5) : norm(s.label);
      markStale(); persist(); renderCounts(); pump();
    }
    renderStops();
  });

  var clearArmed = false, clearTimer = null;
  $('#btn-clear').addEventListener('click', function () {
    var b = this;
    if (!clearArmed) {
      clearArmed = true; b.textContent = 'Confirmer : tout effacer';
      clearTimer = setTimeout(function () { clearArmed = false; b.textContent = 'Tout effacer'; }, 3500);
      return;
    }
    clearTimeout(clearTimer); clearArmed = false; b.textContent = 'Tout effacer';
    stops = []; route = null; persist(); renderCounts(); renderStops(); renderRoute();
  });
  $('#btn-retry').addEventListener('click', function () {
    stops.forEach(function (s) { if (s.status === 'error') s.status = 'pending'; });
    persist(); renderCounts(); renderStops(); pump();
  });

  /* ---------- Table code -> adresse ---------- */
  function renderTableInfo() {
    var n = Object.keys(table).length;
    $('#table-count').textContent = n ? '(' + n + ' entrée' + (n > 1 ? 's' : '') + ')' : '';
  }
  function tableToText() { return Object.keys(table).map(function (k) { return k + ' ; ' + table[k]; }).join('\n'); }
  $('#btn-table-save').addEventListener('click', function () {
    var r = C.parseTable($('#table-text').value);
    table = r.table; save(LS.table, table); renderTableInfo();
    toast(r.count + ' correspondance' + (r.count > 1 ? 's' : '') + ' enregistrée' + (r.count > 1 ? 's' : ''));
  });
  $('#btn-table-clear').addEventListener('click', function () {
    table = {}; save(LS.table, table); $('#table-text').value = ''; renderTableInfo(); toast('Table vidée');
  });
  $('#file-table').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      $('#table-text').value = String(rd.result);
      var r = C.parseTable(rd.result); table = r.table; save(LS.table, table); renderTableInfo();
      toast(r.count + ' correspondances importées');
    };
    rd.readAsText(f);
    this.value = '';
  });

  /* ---------- Saisie manuelle ---------- */
  $('#form-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('#in-address'), v = inp.value.trim();
    if (!v) return;
    var r = addFromRaw(v);
    if (r.ok) { inp.value = ''; setLast('Ajouté : ' + v); }
  });

  /* ---------- Caméra ---------- */
  var video = $('#video'), stream = null, scanning = false, detector = null, scanTimer = null;
  var lastCode = '', lastAt = 0, canvas = null, ctx = null, wakeLock = null, audio = null, torchOn = false;

  function setLast(t) { $('#last-scan').textContent = t; }

  function beep(ok) {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = ok ? 880 : 220;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + (ok ? 0.09 : 0.18));
    } catch (e) { /* audio indisponible */ }
  }
  function feedback(ok) {
    var f = $('#frame');
    f.classList.remove('hit', 'miss'); void f.offsetWidth;
    f.classList.add(ok ? 'hit' : 'miss');
    setTimeout(function () { f.classList.remove('hit', 'miss'); }, 450);
    beep(ok);
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [40, 60, 40]);
  }

  function onCode(value) {
    var now = Date.now();
    if (value === lastCode && now - lastAt < 3000) { lastAt = now; return; }
    lastCode = value; lastAt = now;
    var r = addFromRaw(value);
    feedback(!!r.ok);
    if (r.ok) setLast('Dernier scan : ' + r.stop.label);
    else if (r.duplicate) setLast('Dernier scan : déjà dans la liste');
    else setLast('Non reconnu : ' + r.message);
  }

  function decodeJsQR() {
    if (!window.jsQR || !video.videoWidth) return [];
    var w = Math.min(720, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
    if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h);
    var c = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    return c && c.data ? [c.data] : [];
  }

  async function tick() {
    if (!scanning) return;
    if (video.readyState >= 2) {
      var values = [];
      try {
        if (detector) {
          var codes = await detector.detect(video);
          values = codes.map(function (c) { return c.rawValue; });
        } else values = decodeJsQR();
      } catch (e) { values = []; }
      for (var i = 0; i < values.length; i++) if (values[i]) onCode(values[i]);
    }
    scanTimer = setTimeout(tick, detector ? 90 : 140);
  }

  async function startScan() {
    if (scanning) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Caméra indisponible. Ouvrez l’app en HTTPS.', 4000); return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
      });
    } catch (e) {
      toast(e && e.name === 'NotAllowedError' ? 'Accès caméra refusé. Autorisez-le dans les réglages du navigateur.' : 'Impossible d’ouvrir la caméra.', 4200);
      return;
    }
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* lecture auto */ }
    scanning = true;
    $('#camera').classList.add('live');
    $('#btn-scan').textContent = 'Arrêter la caméra';
    if ('BarcodeDetector' in window) {
      try {
        var fm = await window.BarcodeDetector.getSupportedFormats();
        if (fm.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) { detector = null; }
    }
    try {
      var track = stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      $('#btn-torch').hidden = !caps.torch;
    } catch (e) { $('#btn-torch').hidden = true; }
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
    tick();
  }

  function stopScan() {
    scanning = false;
    clearTimeout(scanTimer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; video.srcObject = null; torchOn = false;
    $('#camera').classList.remove('live');
    $('#btn-scan').textContent = 'Démarrer la caméra';
    $('#btn-torch').hidden = true; $('#btn-torch').setAttribute('aria-pressed', 'false');
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* déjà libéré */ } wakeLock = null; }
  }

  $('#btn-scan').addEventListener('click', function () { scanning ? stopScan() : startScan(); });
  $('#btn-torch').addEventListener('click', async function () {
    if (!stream) return;
    torchOn = !torchOn;
    try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); }
    catch (e) { torchOn = false; }
    this.setAttribute('aria-pressed', String(torchOn));
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopScan(); });

  /* ---------- Calcul du circuit ---------- */
  function getPosition() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
        function () { resolve(null); },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

  async function osrmMatrices(points) {
    if (points.length > 100) throw new Error('trop de points pour le serveur public');
    var coords = points.map(function (p) { return p.lon.toFixed(6) + ',' + p.lat.toFixed(6); }).join(';');
    var data = await fetchJSON('https://router.project-osrm.org/table/v1/driving/' + coords + '?annotations=duration,distance', 20000);
    return C.normalizeOSRM(data);
  }

  async function computeRoute() {
    var todo = stops.filter(function (s) { return !s.done && s.status === 'ok'; });
    if (!todo.length) { toast('Aucun dépôt localisé à ordonner.'); return; }
    var btn = $('#btn-compute');
    btn.disabled = true; btn.textContent = 'Calcul en cours…';
    $('#compute-note').textContent = '';
    try {
      var pos = opts.usePosition ? await getPosition() : null;
      var pts = (pos ? [pos] : []).concat(todo.map(function (s) { return { lat: s.lat, lon: s.lon }; }));
      var mats, estimated = false;
      try { mats = await osrmMatrices(pts); }
      catch (e) { mats = C.estimateMatrices(pts); estimated = true; }
      var off = pos ? 1 : 0;
      var D = mats.D.slice(off).map(function (r) { return r.slice(off); });
      var K = mats.K ? mats.K.slice(off).map(function (r) { return r.slice(off); }) : null;
      var sD = pos ? mats.D[0].slice(1) : null, sK = pos && mats.K ? mats.K[0].slice(1) : null;
      var res = C.solveOpenPath(D, sD, 2000);
      var st = C.legStats(res.order, D, K, sD, sK, opts.legSize);
      route = {
        order: res.order.map(function (i) { return todo[i].id; }),
        size: opts.legSize, computedAt: Date.now(), estimated: estimated,
        position: pos, legs: st.legs, totalSec: st.totalSec, totalM: st.totalM, stale: false
      };
      persist();
      renderRoute();
      toast(estimated ? 'Circuit calculé (durées estimées)' : 'Circuit calculé');
    } catch (e) {
      toast('Échec du calcul : ' + (e && e.message ? e.message : 'erreur'), 4000);
    } finally {
      btn.disabled = false; btn.textContent = 'Calculer le circuit le plus rapide';
    }
  }
  $('#btn-compute').addEventListener('click', computeRoute);
  $('#opt-size').addEventListener('change', function () { opts.legSize = parseInt(this.value, 10) || 10; save(LS.opts, opts); });
  $('#opt-pos').addEventListener('change', function () { opts.usePosition = this.checked; save(LS.opts, opts); });

  /* ---------- Affichage du circuit ---------- */
  function renderRoute() {
    $('#opt-size').value = String(opts.legSize);
    $('#opt-pos').checked = !!opts.usePosition;
    var out = $('#route-out'), banner = $('#route-banner');
    banner.hidden = true;
    var byId = {}; stops.forEach(function (s) { byId[s.id] = s; });
    if (!route || !route.order) {
      out.innerHTML = '<p class="empty">Scannez vos dépôts, puis calculez le circuit. Il sera découpé en tronçons de ' + opts.legSize + ' pour Google Maps.</p>';
      $('#compute-note').textContent = '';
      return;
    }
    var ordered = route.order.map(function (id) { return byId[id]; }).filter(Boolean);
    var known = {}; ordered.forEach(function (s) { known[s.id] = 1; });
    var missing = stops.filter(function (s) { return !s.done && !known[s.id]; }).length;
    var msgs = [];
    if (missing) msgs.push(missing + ' dépôt(s) ajouté(s) depuis le dernier calcul. Recalculez pour les inclure.');
    if (route.estimated) msgs.push('Durées estimées à vol d’oiseau : le serveur de trajets n’a pas répondu. Recalculez avec du réseau pour un ordre précis.');
    if (msgs.length) { banner.hidden = false; banner.textContent = msgs.join(' '); }
    $('#compute-note').textContent = 'Dernier calcul : ' + new Date(route.computedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + (route.position ? ' · départ de votre position' : ' · départ libre');

    var html = '';
    var next = ordered.find(function (s) { return !s.done; });
    html += '<div class="total"><strong>' + C.fmtDuration(route.totalSec) + '</strong><span>' + C.fmtKm(route.totalM) + ' · ' + ordered.length + ' dépôts · ' + Math.ceil(ordered.length / route.size) + ' tronçon(s)</span></div>';

    if (next) {
      var idx = ordered.indexOf(next) + 1;
      html += '<div class="next"><h3>Prochain dépôt · n° ' + idx + ' sur ' + ordered.length + '</h3>' +
        '<div class="addr">' + esc(next.label) + '</div>' +
        '<div class="row"><a class="btn dark grow" target="_blank" rel="noopener" href="' + C.wazeUrl(next) + '">Waze</a>' +
        '<a class="btn grow" target="_blank" rel="noopener" href="' + C.gmapsLegUrl([next]) + '">Google Maps</a>' +
        '<button class="btn grow" data-act="done" data-id="' + next.id + '">Fait ✓</button></div></div>';
    } else {
      html += '<div class="banner info">Tous les dépôts du circuit sont faits.</div>';
    }

    html += '<h2 class="section-title">Tronçons Google Maps</h2><ul class="legs">';
    var legs = C.splitLegs(ordered, route.size);
    legs.forEach(function (leg, li) {
      var st = route.legs && route.legs[li];
      var doneN = leg.filter(function (s) { return s.done; }).length;
      var first = ordered.indexOf(leg[0]) + 1;
      html += '<li class="leg"><h3>Tronçon ' + (li + 1) + ' sur ' + legs.length +
        '<span>' + (st ? C.fmtDuration(st.sec) + ' · ' + C.fmtKm(st.m) : '') + '</span></h3><ol>' +
        leg.map(function (s, k) { return '<li class="' + (s.done ? 'done' : '') + '"><b>' + (first + k) + '.</b><span>' + esc(s.label) + '</span></li>'; }).join('') +
        '</ol><div class="row"><a class="btn primary grow" target="_blank" rel="noopener" href="' + C.gmapsLegUrl(leg) + '">Ouvrir dans Google Maps</a>' +
        '<button class="btn" data-act="legdone" data-leg="' + li + '"' + (doneN === leg.length ? ' disabled' : '') + '>Tronçon terminé ✓</button></div></li>';
    });
    html += '</ul>';
    out.innerHTML = html;
  }

  $('#route-out').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    if (b.dataset.act === 'done') {
      var s = stops.find(function (x) { return x.id === b.dataset.id; });
      if (s) s.done = true;
    } else if (b.dataset.act === 'legdone') {
      var byId = {}; stops.forEach(function (x) { byId[x.id] = x; });
      var ordered = route.order.map(function (id) { return byId[id]; }).filter(Boolean);
      var leg = C.splitLegs(ordered, route.size)[parseInt(b.dataset.leg, 10)] || [];
      leg.forEach(function (x) { x.done = true; });
    }
    persist(); renderCounts(); renderRoute();
  });

  /* ---------- Démarrage ---------- */
  $('#table-text').value = tableToText();
  renderTableInfo(); renderCounts(); renderStops();
  if (stops.some(function (s) { return s.status === 'pending'; })) pump();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* hors ligne non disponible */ });
  }
})();
