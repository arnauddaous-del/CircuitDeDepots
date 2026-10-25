/* Circuit Dépôts — interface : caméra, liste, calcul du circuit. */
(function () {
  'use strict';

  var C = window.Circuit;
  var $ = function (s) { return document.querySelector(s); };
  var LS = { stops: 'circuit.stops.v1', table: 'circuit.table.v1', route: 'circuit.route.v1', opts: 'circuit.opts.v1', memo: 'circuit.memo.v1' };

  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage plein ou bloqué */ } }

  var stops = load(LS.stops, []);
  var table = load(LS.table, {});
  var route = load(LS.route, null);
  var opts = Object.assign({ legSize: 10, usePosition: true, returnHome: false }, load(LS.opts, {}));
  var editingId = null;

  /* Mémoire des dépôts : coordonnées et noms retenus d'une tournée à l'autre.
     raw = contenu exact du QR code, txt = adresse normalisée. */
  var memo = Object.assign({ raw: {}, txt: {} }, load(LS.memo, {}));
  function memoGet(raw, text) {
    return memo.raw[String(raw).trim()] || (text ? memo.txt[norm(text)] : null) || null;
  }
  function memoPut(raw, text, entry) {
    var e = { lat: entry.lat, lon: entry.lon, label: entry.label || '', name: entry.name || '', src: entry.src || '', approx: !!entry.approx };
    if (raw) memo.raw[String(raw).trim()] = e;
    if (text) memo.txt[norm(text)] = e;
    save(LS.memo, memo);
  }
  function hasPos(m) { return !!m && typeof m.lat === 'number' && typeof m.lon === 'number' && isFinite(m.lat) && isFinite(m.lon); }
  function memoCount() { return Object.keys(memo.raw).filter(function (k) { return hasPos(memo.raw[k]); }).length; }

  /* Point de référence (Plus Codes courts, priorité géographique de la recherche d'adresses). */
  function updateReference() {
    var pts = stops.filter(function (s) { return s.status === 'ok'; });
    if (!pts.length) pts = Object.keys(memo.raw).map(function (k) { return memo.raw[k]; }).filter(hasPos);
    if (!pts.length) return;
    var la = 0, lo = 0; pts.forEach(function (p) { la += p.lat; lo += p.lon; });
    C.setReference(la / pts.length, lo / pts.length);
  }

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
    var m = memoGet(rawKey, p.kind === 'address' ? p.text : null);
    var s = {
      id: uid(), raw: rawKey, key: key, done: false,
      label: p.kind === 'coords' ? p.label : p.text,
      name: m && m.name ? m.name : '',
      lat: p.kind === 'coords' ? p.lat : null,
      lon: p.kind === 'coords' ? p.lon : null,
      resolved: '', approx: false, status: p.kind === 'coords' ? 'ok' : 'pending'
    };
    if (hasPos(m)) {
      /* Dépôt déjà connu : on reprend ses coordonnées (y compris une correction manuelle). */
      s.lat = m.lat; s.lon = m.lon; s.status = 'ok'; s.resolved = m.label || ''; s.approx = !!m.approx;
      if (m.label && p.kind !== 'coords') s.label = p.text;
    }
    if (s.status === 'ok') s.key = s.lat.toFixed(5) + ',' + s.lon.toFixed(5);
    if (stops.some(function (x) { return x.key === s.key; })) { toast('Déjà dans la liste'); return { ok: false, duplicate: true, message: 'Déjà scanné' }; }
    stops.push(s);
    updateReference();
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

  /* « 13 all. Marines » → « 13 allée Marines » : abréviations courantes avant la recherche. */
  function expandAbbr(q) {
    return String(q)
      .replace(/^\s*(à proximité de|a proximite de|près de|pres de|face au|face à|devant)\s+/i, '')
      .replace(/\ball\.?(?=\s)/gi, 'allée').replace(/\bav\.?(?=\s)/gi, 'avenue').replace(/\bbd\.?(?=\s)/gi, 'boulevard')
      .replace(/\bpl\.?(?=\s)/gi, 'place').replace(/\bchem\.?(?=\s)/gi, 'chemin').replace(/\bch\.?(?=\s)/gi, 'chemin')
      .replace(/\bimp\.?(?=\s)/gi, 'impasse').replace(/\brte\.?(?=\s)/gi, 'route').replace(/\bdr\.?(?=\s)/gi, 'docteur')
      .replace(/\bst\.?(?=\s)/gi, 'saint').replace(/\bgal\.?(?=\s)/gi, 'général').replace(/\brem\.?(?=\s)/gi, 'rempart');
  }

  async function geocode(q) {
    var query = expandAbbr(String(q)).slice(0, 190);
    var ref = C.getReference();
    var pc = /\b(\d{5})\b/.exec(query);
    var ban = 'https://api-adresse.data.gouv.fr/search/?limit=1&q=' + encodeURIComponent(query) +
      '&lat=' + ref.lat.toFixed(4) + '&lon=' + ref.lon.toFixed(4) + (pc ? '&postcode=' + pc[1] : '');
    try {
      var r = await fetchJSON(ban);
      var f = r.features && r.features[0];
      if (f && f.properties && f.properties.score >= 0.45) {
        var pr = f.properties;
        return {
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: pr.label, src: 'ban',
          /* Rue entière ou commune au lieu du numéro exact, ou score faible : à vérifier. */
          approx: pr.type !== 'housenumber' || pr.score < 0.7
        };
      }
    } catch (e) { /* on essaie l'autre service */ }
    try {
      var wait = 1100 - (Date.now() - lastNominatim);
      if (wait > 0) await sleep(wait);
      lastNominatim = Date.now();
      var n = await fetchJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=fr&q=' + encodeURIComponent(query));
      if (n && n[0]) return { lat: parseFloat(n[0].lat), lon: parseFloat(n[0].lon), label: n[0].display_name, src: 'osm', approx: n[0].addresstype !== 'house' && n[0].type !== 'house' };
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
          still.lat = g.lat; still.lon = g.lon; still.resolved = g.label; still.status = 'ok'; still.approx = !!g.approx;
          still.key = g.lat.toFixed(5) + ',' + g.lon.toFixed(5);
          memoPut(still.raw, still.label, { lat: g.lat, lon: g.lon, label: g.label, name: still.name, src: g.src, approx: g.approx });
          updateReference();
        } else {
          still.status = 'error';
        }
        persist(); renderCounts(); renderStops();
      }
    } finally { pumping = false; }
    var errs = stops.filter(function (s) { return s.status === 'error'; }).length;
    var approx = stops.filter(function (s) { return s.status === 'ok' && s.approx; }).length;
    if (errs) toast(errs + ' adresse(s) introuvable(s). Corrigez-les dans « Dépôts ».', 3600);
    else if (approx) toast(approx + ' adresse(s) localisée(s) approximativement. Vérifiez-les dans « Dépôts ».', 3600);
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
      var apx = stops.filter(function (s) { return s.status === 'ok' && s.approx; }).length;
      if (apx) parts.push(apx + ' à vérifier');
    }
    $('#summary').textContent = parts.join(' · ');
  }

  function renderStops() {
    var ul = $('#stops-list');
    $('#stops-empty').hidden = stops.length > 0;
    $('#btn-clear').hidden = stops.length === 0;
    $('#btn-retry').hidden = !stops.some(function (s) { return s.status === 'error'; });
    ul.innerHTML = stops.map(function (s, i) {
      var chip = s.status === 'ok' ? (s.approx ? '<span class="chip pending">À vérifier</span>' : '<span class="chip ok">Localisé</span>')
        : s.status === 'pending' ? '<span class="chip pending">Recherche…</span>'
        : '<span class="chip error">Adresse introuvable</span>';
      var edit = editingId === s.id
        ? '<form class="edit" data-edit="' + s.id + '">' +
          '<label class="fl" for="edit-name">Nom</label><input id="edit-name" name="name" type="text" value="' + esc(s.name || '') + '" placeholder="Ex. Bourgneuf">' +
          '<label class="fl" for="edit-loc">Adresse, coordonnées GPS ou lien Maps</label><input id="edit-loc" name="loc" type="text" value="' + esc(s.status === 'ok' && s.approx ? s.lat.toFixed(6) + ', ' + s.lon.toFixed(6) : s.label) + '">' +
          '<p class="hint">Le plus précis : dans Google Maps, appui long sur l’entrée du dépôt, puis copiez les coordonnées affichées.</p>' +
          '<div class="row"><button class="mini" type="submit">Valider</button><button class="mini" type="button" data-act="cancel">Annuler</button></div></form>'
        : '';
      var look = s.status === 'ok' ? '<a class="mini" target="_blank" rel="noopener" href="' + C.gmapsPointUrl(s) + '">Voir</a>' : '';
      var title = s.name ? esc(s.name) + '<span class="res">' + esc(s.label) + '</span>' : esc(s.label);
      return '<li class="stop' + (s.done ? ' done' : '') + '" data-id="' + s.id + '">' +
        '<div class="n">' + (s.done ? '✓' : (i + 1)) + '</div>' +
        '<div class="addr">' + title + (s.resolved && s.status === 'ok' && s.resolved !== s.label ? '<span class="res">Trouvé : ' + esc(s.resolved) + '</span>' : '') + chip + '</div>' +
        '<div class="acts">' + look + '<button class="mini" data-act="edit">Corriger</button><button class="mini bad" data-act="del" aria-label="Retirer ce dépôt de la tournée">Retirer</button></div>' +
        edit + '</li>';
    }).join('');
    var inp = ul.querySelector('.edit input[name="loc"]');
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
    var v = form.querySelector('input[name="loc"]').value.trim();
    var nm = form.querySelector('input[name="name"]').value.trim();
    editingId = null;
    if (s) {
      s.name = nm;
      var c = v ? C.parseQR(v, table) : { kind: 'error' };
      if (c.kind === 'coords') {
        /* Position exacte donnée à la main : mémorisée pour les prochaines tournées. */
        s.lat = c.lat; s.lon = c.lon; s.status = 'ok'; s.approx = false; s.resolved = '';
        if (!s.label || /^-?\d/.test(s.label)) s.label = c.label;
        s.key = c.lat.toFixed(5) + ',' + c.lon.toFixed(5);
        memoPut(s.raw, null, { lat: c.lat, lon: c.lon, label: '', name: nm, src: 'manuel', approx: false });
        toast('Position enregistrée pour les prochaines tournées');
      } else if (c.kind === 'address' && c.text !== s.label) {
        s.label = c.text; s.status = 'pending'; s.lat = null; s.lon = null; s.resolved = ''; s.approx = false;
        s.key = norm(s.label);
      } else if (s.status === 'ok') {
        memoPut(s.raw, null, { lat: s.lat, lon: s.lon, label: s.resolved, name: nm, src: 'manuel', approx: s.approx });
      }
      markStale(); persist(); renderCounts(); pump(); updateReference();
    }
    renderStops();
  });

  var clearArmed = false, clearTimer = null;
  $('#btn-clear').addEventListener('click', function () {
    var b = this;
    if (!clearArmed) {
      clearArmed = true; b.textContent = 'Confirmer : vider la liste du jour';
      clearTimer = setTimeout(function () { clearArmed = false; b.textContent = 'Nouvelle tournée'; }, 3500);
      return;
    }
    clearTimeout(clearTimer); clearArmed = false; b.textContent = 'Nouvelle tournée';
    stops = []; route = null; persist(); renderCounts(); renderStops(); renderRoute();
    toast('Liste vidée. Les positions des dépôts restent en mémoire.');
    showView('scan');
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
      var carnet = C.parseCarnet(rd.result);
      if (carnet && carnet.length) {
        /* Fichier exporté par le créateur de QR codes : noms et positions connus d'avance. */
        var withPos = 0;
        carnet.forEach(function (e) {
          var p = C.parseQR(e.qr, table);
          var text = p.kind === 'address' ? p.text : null;
          if (isFinite(e.lat) && isFinite(e.lon)) {
            memoPut(e.qr, text, { lat: e.lat, lon: e.lon, label: e.saisie, name: e.name, src: 'carnet', approx: false });
            withPos++;
          } else {
            if (!hasPos(memo.raw[e.qr])) memo.raw[e.qr] = { lat: null, lon: null, label: '', name: e.name, src: 'carnet' };
            else memo.raw[e.qr].name = e.name;
          }
        });
        save(LS.memo, memo); renderMemoInfo();
        stops.forEach(function (s) {
          var m = memoGet(s.raw); if (!m) return;
          if (m.name && !s.name) s.name = m.name;
          if (hasPos(m) && s.status !== 'ok') { s.lat = m.lat; s.lon = m.lon; s.status = 'ok'; s.approx = false; }
        });
        persist(); renderCounts(); renderStops();
        toast(carnet.length + ' dépôts importés, dont ' + withPos + ' avec leur position GPS', 3600);
        return;
      }
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
      if (opts.usePosition && !pos) toast('Position indisponible : départ du premier dépôt du circuit.', 3600);
      var pts = (pos ? [pos] : []).concat(todo.map(function (s) { return { lat: s.lat, lon: s.lon }; }));
      var mats, estimated = false;
      try { mats = await osrmMatrices(pts); }
      catch (e) { mats = C.estimateMatrices(pts); estimated = true; }
      var off = pos ? 1 : 0;
      var D = mats.D.slice(off).map(function (r) { return r.slice(off); });
      var K = mats.K ? mats.K.slice(off).map(function (r) { return r.slice(off); }) : null;
      var sD = pos ? mats.D[0].slice(1) : null, sK = pos && mats.K ? mats.K[0].slice(1) : null;
      var back = pos && opts.returnHome;
      var eD = back ? mats.D.slice(1).map(function (r) { return r[0]; }) : null;
      var eK = back && mats.K ? mats.K.slice(1).map(function (r) { return r[0]; }) : null;
      var res = C.solvePath(D, sD, eD, 2500);
      var st = C.legStats(res.order, D, K, sD, sK, opts.legSize, eD, eK);
      route = {
        order: res.order.map(function (i) { return todo[i].id; }),
        size: opts.legSize, computedAt: Date.now(), estimated: estimated, exact: !!res.exact,
        position: pos, returnHome: !!back, back: st.back,
        legs: st.legs, totalSec: st.totalSec, totalM: st.totalM, stale: false
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
  $('#opt-pos').addEventListener('change', function () { opts.usePosition = this.checked; save(LS.opts, opts); renderRouteOpts(); });
  $('#opt-back').addEventListener('change', function () { opts.returnHome = this.checked; save(LS.opts, opts); });

  function renderRouteOpts() {
    $('#opt-size').value = String(opts.legSize);
    $('#opt-pos').checked = !!opts.usePosition;
    $('#opt-back').checked = !!opts.returnHome;
    $('#opt-back').disabled = !opts.usePosition;
    $('#opt-back-wrap').classList.toggle('off', !opts.usePosition);
  }

  /* ---------- Plan schématique (pour vérifier l'ordre d'un coup d'œil) ---------- */
  function drawPlan(ordered) {
    var cv = $('#plan'); if (!cv) return;
    var W = Math.max(260, cv.parentElement.clientWidth || 360), H = Math.round(Math.min(340, Math.max(220, W * 0.7)));
    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px';
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cs = getComputedStyle(document.documentElement), col = function (n) { return cs.getPropertyValue(n).trim() || '#888'; };
    ctx.fillStyle = col('--surface'); ctx.fillRect(0, 0, W, H);
    var pts = ordered.map(function (s) { return { lat: s.lat, lon: s.lon, done: s.done }; });
    var home = route && route.position ? { lat: route.position.lat, lon: route.position.lon } : null;
    var all = home ? [home].concat(pts) : pts;
    if (!all.length) return;
    var minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
    all.forEach(function (p) { minLa = Math.min(minLa, p.lat); maxLa = Math.max(maxLa, p.lat); minLo = Math.min(minLo, p.lon); maxLo = Math.max(maxLo, p.lon); });
    var kx = Math.cos((minLa + maxLa) / 2 * Math.PI / 180);
    var sx = Math.max((maxLo - minLo) * kx, 0.002), sy = Math.max(maxLa - minLa, 0.002), pad = 24;
    var sc = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy), cx = (minLo + maxLo) / 2, cy = (minLa + maxLa) / 2;
    var X = function (p) { return W / 2 + (p.lon - cx) * kx * sc; }, Y = function (p) { return H / 2 - (p.lat - cy) * sc; };
    var seq = (home ? [home] : []).concat(pts).concat(home && route.returnHome ? [home] : []);
    ctx.strokeStyle = col('--accent'); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.8;
    ctx.beginPath(); seq.forEach(function (p, k) { if (k) ctx.lineTo(X(p), Y(p)); else ctx.moveTo(X(p), Y(p)); }); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = col('--accent');
    for (var k = 0; k < seq.length - 1; k++) {
      var a = seq[k], b = seq[k + 1], x1 = X(a), y1 = Y(a), x2 = X(b), y2 = Y(b);
      if (Math.hypot(x2 - x1, y2 - y1) < 34) continue;
      ctx.save(); ctx.translate((x1 + x2) / 2, (y1 + y2) / 2); ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
      ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 10px ' + (cs.getPropertyValue('--font') || 'sans-serif');
    if (home) {
      ctx.fillStyle = col('--signal'); ctx.strokeStyle = col('--surface'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(X(home) - 10, Y(home) - 10, 20, 20); ctx.fill(); ctx.stroke();
      ctx.fillStyle = col('--on-signal'); ctx.fillText('D', X(home), Y(home) + 0.5);
    }
    pts.forEach(function (p, i) {
      ctx.fillStyle = p.done ? col('--ok') : col('--accent'); ctx.strokeStyle = col('--surface'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(p), Y(p), 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = p.done ? '#fff' : col('--on-accent'); ctx.fillText(String(i + 1), X(p), Y(p) + 0.5);
    });
  }

  /* ---------- Affichage du circuit ---------- */
  var lastOrdered = [];
  function stopName(s) { return s.name ? s.name : s.label; }
  function renderRoute() {
    renderRouteOpts();
    var out = $('#route-out'), banner = $('#route-banner');
    banner.hidden = true;
    var byId = {}; stops.forEach(function (s) { byId[s.id] = s; });
    if (!route || !route.order) {
      out.innerHTML = '<p class="empty">Scannez vos dépôts du jour, puis calculez le circuit. Il sera découpé en tronçons de ' + opts.legSize + ' pour Google Maps.</p>';
      $('#compute-note').textContent = '';
      lastOrdered = [];
      return;
    }
    var ordered = route.order.map(function (id) { return byId[id]; }).filter(Boolean);
    lastOrdered = ordered;
    var known = {}; ordered.forEach(function (s) { known[s.id] = 1; });
    var missing = stops.filter(function (s) { return !s.done && !known[s.id]; }).length;
    var approx = ordered.filter(function (s) { return s.approx; }).length;
    var msgs = [];
    if (missing) msgs.push(missing + ' dépôt(s) ajouté(s) ou corrigé(s) depuis le dernier calcul. Recalculez pour les inclure.');
    if (route.estimated) msgs.push('Durées estimées à vol d’oiseau : le serveur de trajets n’a pas répondu. Recalculez avec du réseau pour un ordre précis.');
    if (approx) msgs.push(approx + ' dépôt(s) localisé(s) approximativement : vérifiez-les dans « Dépôts », sinon l’ordre peut être faux.');
    if (msgs.length) { banner.hidden = false; banner.textContent = msgs.join(' '); }
    $('#compute-note').textContent = 'Dernier calcul : ' + new Date(route.computedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) +
      (route.position ? ' · départ de votre position' : ' · départ libre') + (route.returnHome ? ' · retour au départ' : '') +
      (route.exact ? ' · meilleur ordre garanti' : '');

    var html = '';
    var next = ordered.find(function (s) { return !s.done; });
    html += '<div class="total"><strong>' + C.fmtDuration(route.totalSec) + '</strong><span>' + C.fmtKm(route.totalM) + ' · ' + ordered.length + ' dépôts · ' + Math.ceil(ordered.length / route.size) + ' tronçon(s)' + (route.estimated ? ' · estimation' : ' · trajets routiers réels') + '</span></div>';

    if (next) {
      var idx = ordered.indexOf(next) + 1;
      html += '<div class="next"><h3>Prochain dépôt · n° ' + idx + ' sur ' + ordered.length + '</h3>' +
        '<div class="addr">' + esc(stopName(next)) + (next.name ? '<span class="res">' + esc(next.label) + '</span>' : '') + '</div>' +
        '<div class="row"><a class="btn dark grow" target="_blank" rel="noopener" href="' + C.gmapsLegUrl([next]) + '">Y aller avec Google Maps</a>' +
        '<button class="btn grow" data-act="done" data-id="' + next.id + '">Fait ✓</button></div></div>';
    } else {
      html += '<div class="banner info">Tous les dépôts du circuit sont faits.</div>';
    }

    html += '<div class="plan"><canvas id="plan" role="img" aria-label="Plan schématique du circuit"></canvas></div>';

    html += '<h2 class="section-title">Tronçons Google Maps</h2><ul class="legs">';
    var legs = C.splitLegs(ordered, route.size);
    legs.forEach(function (leg, li) {
      var st = route.legs && route.legs[li];
      var doneN = leg.filter(function (s) { return s.done; }).length;
      var first = ordered.indexOf(leg[0]) + 1;
      html += '<li class="leg"><h3>Tronçon ' + (li + 1) + ' sur ' + legs.length +
        '<span>' + (st ? C.fmtDuration(st.sec) + ' · ' + C.fmtKm(st.m) : '') + '</span></h3><ol>' +
        leg.map(function (s, k) { return '<li class="' + (s.done ? 'done' : '') + '"><b>' + (first + k) + '.</b><span>' + esc(stopName(s)) + '</span></li>'; }).join('') +
        '</ol><div class="row"><a class="btn primary grow" target="_blank" rel="noopener" href="' + C.gmapsLegUrl(leg) + '">Ouvrir dans Google Maps</a>' +
        '<button class="btn" data-act="legdone" data-leg="' + li + '"' + (doneN === leg.length ? ' disabled' : '') + '>Tronçon terminé ✓</button></div></li>';
    });
    if (route.returnHome && route.position) {
      html += '<li class="leg"><h3>Retour au point de départ<span>' + (route.back ? C.fmtDuration(route.back.sec) + ' · ' + C.fmtKm(route.back.m) : '') + '</span></h3>' +
        '<div class="row"><a class="btn grow" target="_blank" rel="noopener" href="' + C.gmapsLegUrl([route.position]) + '">Ouvrir le retour dans Google Maps</a></div></li>';
    }
    html += '</ul>';
    out.innerHTML = html;
    drawPlan(ordered);
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
  var rz = null;
  window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (!$('#view-route').hidden && lastOrdered.length) drawPlan(lastOrdered); }, 150); });

  function renderMemoInfo() {
    var n = memoCount();
    $('#memo-info').textContent = n ? n + ' dépôt' + (n > 1 ? 's' : '') + ' en mémoire : leur position est reprise dès le scan, sans nouvelle recherche.' : 'Aucun dépôt en mémoire pour l’instant.';
  }
  var forgetArmed = null;
  $('#btn-forget').addEventListener('click', function () {
    var b = this;
    if (!forgetArmed) { b.textContent = 'Confirmer : tout oublier'; forgetArmed = setTimeout(function () { forgetArmed = null; b.textContent = 'Oublier les positions mémorisées'; }, 3500); return; }
    clearTimeout(forgetArmed); forgetArmed = null; b.textContent = 'Oublier les positions mémorisées';
    memo = { raw: {}, txt: {} }; save(LS.memo, memo); renderMemoInfo(); toast('Mémoire des dépôts effacée');
  });

  /* ---------- Démarrage ---------- */
  $('#table-text').value = tableToText();
  updateReference();
  renderTableInfo(); renderMemoInfo(); renderCounts(); renderStops(); renderRouteOpts();
  if (stops.some(function (s) { return s.status === 'pending'; })) pump();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.register('sw.js').then(function (reg) { if (reg && reg.update) reg.update().catch(function () { /* hors ligne */ }); }).catch(function () { /* hors ligne non disponible */ });
    /* Nouvelle version installée : on recharge une fois pour l'afficher. */
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
