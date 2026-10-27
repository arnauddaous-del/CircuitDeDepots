/* QR Dépôts — création des QR codes des dépôts, impression, échange avec Circuit Dépôts. */
(function () {
  'use strict';

  var C = window.Circuit;
  var $ = function (s) { return document.querySelector(s); };
  var LS = { items: 'qrdepots.items.v1', opts: 'qrdepots.opts.v1', memo: 'circuit.memo.v1' };
  if (window.qrcode && qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Stockage plein ou bloqué : la liste n’a pas pu être enregistrée.', 4000); } }

  var items = load(LS.items, []);
  var opts = Object.assign({ fmt: 'gmaps', per: 12, which: 'all' }, load(LS.opts, {}));
  var editingId = null;

  var HINTS = {
    gmaps: 'Lien Google Maps : lu par l’appareil photo de n’importe quel téléphone et par Circuit Dépôts.',
    geo: 'Format geo: : Android propose ses applis de cartes, iPhone ouvre Plans. Lu aussi par Circuit Dépôts.'
  };

  /* ---------- Utilitaires ---------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function norm(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function slug(s) { return norm(s || 'depot').replace(/ /g, '-').slice(0, 50) || 'depot'; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hasPos(it) { return !!it && typeof it.lat === 'number' && typeof it.lon === 'number' && isFinite(it.lat) && isFinite(it.lon); }
  function n6(v) { return String(Number(Number(v).toFixed(6))); }
  function coordText(it) { return it.lat.toFixed(5) + ', ' + it.lon.toFixed(5); }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2400);
  }

  /* ---------- Contenu du QR code ---------- */
  function addrText(it) {
    var p = C.parseQR(it.raw || '');
    return p.kind === 'address' ? p.text : '';
  }
  function payload(it, fmt) {
    fmt = fmt || opts.fmt;
    if (hasPos(it)) {
      var ll = n6(it.lat) + ',' + n6(it.lon);
      return fmt === 'geo' ? 'geo:' + ll : 'https://www.google.com/maps/search/?api=1&query=' + ll;
    }
    var a = addrText(it) || it.raw || it.name;
    return fmt === 'geo' ? 'geo:0,0?q=' + encodeURIComponent(a) : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a);
  }
  function subText(it) {
    var a = addrText(it);
    if (a) return a;
    return hasPos(it) ? coordText(it) : (it.raw || '');
  }

  /* ---------- Dessin des QR codes ---------- */
  function makeQR(text) { var q = qrcode(0, 'M'); q.addData(text); q.make(); return q; }
  function paintQR(ctx, q, x, y, size) {
    var n = q.getModuleCount(), total = n + 8, cell = Math.max(1, Math.floor(size / total)), off = (size - cell * total) / 2;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (q.isDark(r, c)) ctx.fillRect(Math.round(x + off + (c + 4) * cell), Math.round(y + off + (r + 4) * cell), cell, cell);
    }
  }
  function qrCanvas(text, css) {
    var cv = document.createElement('canvas'), dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cv.width = cv.height = Math.round(css * dpr); cv.style.width = css + 'px';
    try { paintQR(cv.getContext('2d'), makeQR(text), 0, 0, cv.width); } catch (e) { /* texte trop long */ }
    return cv;
  }
  function qrDataUrl(text, px) {
    var cv = document.createElement('canvas'); cv.width = cv.height = px;
    paintQR(cv.getContext('2d'), makeQR(text), 0, 0, px);
    return cv.toDataURL('image/png');
  }
  function fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }
  function labelPng(it) {
    return new Promise(function (resolve) {
      var W = 900, H = 1010, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      paintQR(ctx, makeQR(payload(it)), 50, 40, 800);
      ctx.textAlign = 'center'; ctx.fillStyle = '#0b1220'; ctx.font = '700 46px system-ui, -apple-system, Arial, sans-serif';
      ctx.fillText(fit(ctx, it.name, W - 100), W / 2, 920);
      ctx.fillStyle = '#566882'; ctx.font = '400 28px ui-monospace, Menlo, monospace';
      ctx.fillText(fit(ctx, subText(it), W - 100), W / 2, 966);
      cv.toBlob(resolve, 'image/png');
    });
  }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- Localisation des adresses ---------- */
  function reference() {
    var pts = items.filter(hasPos);
    if (!pts.length) return C.getReference();
    var la = 0, lo = 0; pts.forEach(function (p) { la += p.lat; lo += p.lon; });
    return { lat: la / pts.length, lon: lo / pts.length };
  }
  function updateReference() { var r = reference(); C.setReference(r.lat, r.lon); }

  function expandAbbr(q) {
    return String(q)
      .replace(/^\s*(à proximité de|a proximite de|près de|pres de|face au|face à|devant)\s+/i, '')
      .replace(/\ball\.?(?=\s)/gi, 'allée').replace(/\bav\.?(?=\s)/gi, 'avenue').replace(/\bbd\.?(?=\s)/gi, 'boulevard')
      .replace(/\bpl\.?(?=\s)/gi, 'place').replace(/\bchem\.?(?=\s)/gi, 'chemin').replace(/\bch\.?(?=\s)/gi, 'chemin')
      .replace(/\bimp\.?(?=\s)/gi, 'impasse').replace(/\brte\.?(?=\s)/gi, 'route').replace(/\bdr\.?(?=\s)/gi, 'docteur')
      .replace(/\bst\.?(?=\s)/gi, 'saint').replace(/\bgal\.?(?=\s)/gi, 'général').replace(/\brem\.?(?=\s)/gi, 'rempart');
  }
  function fetchJSON(url, ms) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms || 10000);
    return fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }
  var lastNominatim = 0;
  async function geocode(q) {
    var query = expandAbbr(q).slice(0, 190), ref = reference(), pc = /\b(\d{5})\b/.exec(query);
    try {
      var r = await fetchJSON('https://api-adresse.data.gouv.fr/search/?limit=1&q=' + encodeURIComponent(query) +
        '&lat=' + ref.lat.toFixed(4) + '&lon=' + ref.lon.toFixed(4) + (pc ? '&postcode=' + pc[1] : ''));
      var f = r.features && r.features[0];
      if (f && f.properties && f.properties.score >= 0.45) {
        return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.label,
          approx: f.properties.type !== 'housenumber' || f.properties.score < 0.7 };
      }
    } catch (e) { /* autre service */ }
    try {
      var wait = 1100 - (Date.now() - lastNominatim); if (wait > 0) await sleep(wait);
      lastNominatim = Date.now();
      var n = await fetchJSON('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=fr&q=' + encodeURIComponent(query));
      if (n && n[0]) return { lat: parseFloat(n[0].lat), lon: parseFloat(n[0].lon), label: n[0].display_name, approx: n[0].addresstype !== 'house' && n[0].type !== 'house' };
    } catch (e) { /* réseau */ }
    return null;
  }

  /* ---------- Échange avec Circuit Dépôts ----------
     Les deux apps sont sur le même site : Circuit Dépôts lit cette mémoire
     et reconnaît chaque QR code (ancien ou nouveau contenu) avec son nom et sa position. */
  function syncMemo() {
    var memo = Object.assign({ raw: {}, txt: {} }, load(LS.memo, {}));
    items.forEach(function (it) {
      var e = { lat: hasPos(it) ? it.lat : null, lon: hasPos(it) ? it.lon : null, label: it.found || it.raw || '', name: it.name, src: 'qr', approx: !!it.approx };
      var keys = (it.payloads || []).concat([payload(it, 'gmaps'), payload(it, 'geo')]);
      keys.forEach(function (k) {
        if (!k) return;
        var old = memo.raw[k];
        var oldPos = old && typeof old.lat === 'number' && isFinite(old.lat);
        /* Une position corrigée à la main dans Circuit Dépôts reste prioritaire sur une position approximative. */
        if (oldPos && (!hasPos(it) || (old.src === 'manuel' && it.approx))) { memo.raw[k] = Object.assign({}, old, { name: it.name }); return; }
        memo.raw[k] = e;
      });
      var a = addrText(it); if (a && hasPos(it)) memo.txt[norm(a)] = e;
    });
    save(LS.memo, memo);
  }
  function remember(it) {
    it.payloads = it.payloads || [];
    var p = payload(it, 'gmaps');
    if (it.payloads.indexOf(p) < 0) it.payloads.push(p);
  }
  function persist() {
    items.forEach(remember);
    save(LS.items, items); syncMemo();
  }

  /* ---------- Onglets ---------- */
  function showView(name) {
    ['new', 'list', 'print'].forEach(function (v) {
      $('#view-' + v).hidden = v !== name;
      $('#tab-' + v).setAttribute('aria-selected', String(v === name));
    });
    if (name === 'list') renderList();
    if (name === 'print') renderSheet();
    if (name === 'new') renderPreview();
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showView(b.dataset.view); }); });

  function renderSummary() {
    var gps = items.filter(hasPos).length, apx = items.filter(function (i) { return hasPos(i) && i.approx; }).length;
    $('#count').textContent = items.length;
    $('#summary').textContent = items.length
      ? items.length + ' dépôt' + (items.length > 1 ? 's' : '') + ' · ' + gps + ' avec point GPS' + (apx ? ' · ' + apx + ' à vérifier' : '')
      : 'Aucun dépôt';
  }

  /* ---------- Nouveau dépôt ---------- */
  var draft = { lat: null, lon: null, found: '', approx: false, forText: '' };
  function renderPreview() {
    var name = $('#in-name').value.trim(), raw = $('#in-loc').value.trim();
    var p = raw ? C.parseQR(raw) : null, det = $('#detect');
    det.className = 'detect';
    var located = false;
    $('#btn-locate').hidden = true; $('#btn-check').hidden = true;
    if (!p) det.textContent = 'Saisissez une adresse, des coordonnées (latitude, longitude), un Plus Code ou un lien Maps.';
    else if (p.kind === 'coords') {
      draft = { lat: p.lat, lon: p.lon, found: '', approx: false, forText: raw };
      det.className = 'detect ok';
      det.innerHTML = '<b>' + (p.plusCode ? 'Plus Code ' + esc(p.plusCode) : 'Point GPS') + '</b> <span class="mono">' + esc(p.lat.toFixed(5) + ', ' + p.lon.toFixed(5)) + '</span>';
      located = true;
    } else if (p.kind === 'address') {
      if (draft.forText === raw && hasPos(draft)) {
        det.className = draft.approx ? 'detect warn' : 'detect ok';
        det.innerHTML = draft.approx
          ? 'Trouvé approximativement : ' + esc(draft.found) + '. Vérifiez, ou collez les coordonnées exactes.'
          : '<b>Localisé</b> : ' + esc(draft.found) + ' <span class="mono">' + esc(coordText(draft)) + '</span>';
        located = true;
      } else {
        det.textContent = 'Adresse sans point GPS. Localisez-la pour un QR code précis.';
        $('#btn-locate').hidden = false;
      }
    } else { det.className = 'detect warn'; det.textContent = p.message || 'Saisie non reconnue.'; }
    if (located) { $('#btn-check').hidden = false; $('#btn-check').href = C.gmapsPointUrl(draft); }

    var box = $('#preview'); box.innerHTML = '';
    if (!p || p.kind === 'error') {
      box.innerHTML = '<div class="qr-empty">Le QR code apparaît ici dès que la localisation est reconnue.</div>';
    } else {
      var tmp = { name: name, raw: raw, lat: located ? draft.lat : null, lon: located ? draft.lon : null };
      var text = payload(tmp), wrap = document.createElement('div'); wrap.className = 'qr';
      wrap.appendChild(qrCanvas(text, 200)); box.appendChild(wrap);
      var pp = document.createElement('p'); pp.className = 'payload'; pp.textContent = text; box.appendChild(pp);
    }
    $('#btn-add').disabled = !(name && p && p.kind !== 'error');
    $('#fmt-hint').textContent = HINTS[opts.fmt];
  }
  async function locateDraft() {
    var raw = $('#in-loc').value.trim(), p = C.parseQR(raw);
    if (p.kind !== 'address') return;
    var b = $('#btn-locate'); b.disabled = true; b.textContent = 'Recherche…';
    var g = await geocode(p.text);
    b.disabled = false; b.textContent = 'Localiser l’adresse';
    if (!g) { toast('Adresse introuvable ou pas de réseau. Collez les coordonnées du dépôt.', 4000); return; }
    draft = { lat: g.lat, lon: g.lon, found: g.label, approx: g.approx, forText: raw };
    renderPreview();
  }
  $('#btn-locate').addEventListener('click', locateDraft);
  $('#in-name').addEventListener('input', renderPreview);
  var locTimer = null;
  $('#in-loc').addEventListener('input', function () { clearTimeout(locTimer); locTimer = setTimeout(renderPreview, 150); });
  $('#btn-reset').addEventListener('click', function () { $('#in-name').value = ''; $('#in-loc').value = ''; draft = { lat: null, lon: null, found: '', approx: false, forText: '' }; renderPreview(); $('#in-name').focus(); });
  $('#form-new').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('#in-name').value.trim(), raw = $('#in-loc').value.trim(), p = C.parseQR(raw);
    if (!name || p.kind === 'error') return;
    if (p.kind === 'address' && !(draft.forText === raw && hasPos(draft))) await locateDraft();
    var it = { id: uid(), name: name, raw: raw, lat: null, lon: null, found: '', approx: false, print: true, created: Date.now() };
    if (p.kind === 'coords') { it.lat = p.lat; it.lon = p.lon; }
    else if (draft.forText === raw && hasPos(draft)) { it.lat = draft.lat; it.lon = draft.lon; it.found = draft.found; it.approx = draft.approx; }
    items.push(it); persist(); updateReference(); renderSummary();
    $('#in-name').value = ''; $('#in-loc').value = ''; draft = { lat: null, lon: null, found: '', approx: false, forText: '' };
    renderPreview();
    toast(hasPos(it) ? 'Dépôt ajouté avec son point GPS' : 'Dépôt ajouté sans point GPS : localisez-le dans « Dépôts »', 3200);
    $('#in-name').focus();
  });
  $('#fmt').addEventListener('change', function (e) { if (e.target.name === 'fmt') { opts.fmt = e.target.value; save(LS.opts, opts); syncMemo(); renderPreview(); } });

  /* ---------- Liste des dépôts ---------- */
  function renderList() {
    renderSummary();
    var ul = $('#cards'), n = items.length;
    $('#list-empty').hidden = n > 0;
    $('#btn-export').hidden = !n; $('#btn-wipe').hidden = !n;
    var missing = items.filter(function (i) { return !hasPos(i); }).length;
    var apx = items.filter(function (i) { return hasPos(i) && i.approx; }).length;
    $('#btn-locate-all').hidden = !missing;
    $('#btn-locate-all').textContent = 'Localiser les ' + missing + ' adresse' + (missing > 1 ? 's' : '');
    var bn = $('#list-banner'), msg = [];
    if (missing) msg.push(missing + ' dépôt' + (missing > 1 ? 's' : '') + ' sans point GPS : leur QR code contient seulement l’adresse.');
    if (apx) msg.push(apx + ' localisé' + (apx > 1 ? 's' : '') + ' approximativement : vérifiez avec « Voir » puis « Corriger » si besoin.');
    if (msg.length) msg.push('Après une correction, réimprimez l’étiquette pour avoir le point GPS dans le QR code.');
    bn.hidden = !msg.length || !n; bn.textContent = msg.join(' ');
    var canShare = !!(navigator.canShare && window.File);
    ul.innerHTML = items.map(function (it) {
      var chip = hasPos(it) ? (it.approx ? '<span class="chip warn">À vérifier</span>' : '<span class="chip ok">Point GPS</span>') : '<span class="chip bad">Sans point GPS</span>';
      var edit = editingId === it.id
        ? '<form class="edit" data-edit="' + it.id + '">' +
          '<label for="ed-name">Nom</label><input id="ed-name" name="name" type="text" value="' + esc(it.name) + '">' +
          '<label for="ed-loc">Adresse, coordonnées GPS ou lien Maps</label><input id="ed-loc" name="loc" type="text" value="' + esc(it.raw) + '">' +
          '<p class="hint">Pour corriger la position sans changer l’adresse affichée, collez les coordonnées ici : l’adresse est conservée.</p>' +
          '<div class="row"><button class="mini" type="submit">Enregistrer</button><button class="mini" type="button" data-act="cancel">Annuler</button></div></form>'
        : '';
      return '<li class="card" data-id="' + it.id + '">' +
        '<div class="qr" data-qr="' + it.id + '"></div>' +
        '<div><h3>' + esc(it.name) + '</h3><p class="addr">' + esc(subText(it)) + '</p>' +
        (hasPos(it) ? '<p class="gps">' + esc(coordText(it)) + '</p>' : '') + chip + '</div>' +
        '<div class="acts">' +
        '<button class="mini" data-act="png">PNG</button>' +
        (canShare ? '<button class="mini" data-act="share">Partager</button>' : '') +
        (hasPos(it) ? '<a class="mini" target="_blank" rel="noopener" href="' + C.gmapsPointUrl(it) + '">Voir</a>' : '<button class="mini" data-act="locate">Localiser</button>') +
        '<button class="mini" data-act="edit">Corriger</button>' +
        '<button class="mini bad" data-act="del">Supprimer</button>' +
        '<label class="check"><input type="checkbox" data-print="' + it.id + '"' + (it.print !== false ? ' checked' : '') + '> À imprimer</label>' +
        '</div>' + edit + '</li>';
    }).join('');
    items.forEach(function (it) {
      var box = ul.querySelector('[data-qr="' + it.id + '"]');
      if (box) box.appendChild(qrCanvas(payload(it), 112));
    });
    var inp = ul.querySelector('.edit input[name="loc"]');
    if (inp) inp.focus();
  }

  var delArm = null;
  $('#cards').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var li = b.closest('.card'), it = items.find(function (x) { return x.id === li.dataset.id; }); if (!it) return;
    var act = b.dataset.act;
    if (act === 'png') { download(await labelPng(it), 'qr-' + slug(it.name) + '.png'); }
    else if (act === 'share') {
      try {
        var f = new File([await labelPng(it)], 'qr-' + slug(it.name) + '.png', { type: 'image/png' });
        if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: it.name });
        else download(f, f.name);
      } catch (err) { /* partage annulé */ }
    }
    else if (act === 'locate') {
      var a = addrText(it) || it.raw; b.disabled = true; b.textContent = 'Recherche…';
      var g = await geocode(a);
      if (g) { it.lat = g.lat; it.lon = g.lon; it.found = g.label; it.approx = g.approx; persist(); updateReference(); toast(g.approx ? 'Localisé approximativement : vérifiez' : 'Localisé'); }
      else toast('Adresse introuvable ou pas de réseau. Utilisez « Corriger » pour coller les coordonnées.', 4000);
      renderList();
    }
    else if (act === 'edit') { editingId = it.id; renderList(); }
    else if (act === 'cancel') { editingId = null; renderList(); }
    else if (act === 'del') {
      if (delArm !== it.id) { delArm = it.id; b.textContent = 'Confirmer'; setTimeout(function () { if (delArm === it.id) { delArm = null; b.textContent = 'Supprimer'; } }, 3500); return; }
      delArm = null; items = items.filter(function (x) { return x.id !== it.id; }); persist(); renderList();
    }
  });
  $('#cards').addEventListener('change', function (e) {
    var id = e.target.dataset && e.target.dataset.print; if (!id) return;
    var it = items.find(function (x) { return x.id === id; }); if (it) { it.print = e.target.checked; save(LS.items, items); }
  });
  $('#cards').addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = e.target.closest('form[data-edit]'); if (!form) return;
    var it = items.find(function (x) { return x.id === form.dataset.edit; }); if (!it) return;
    var nm = form.querySelector('[name=name]').value.trim(), v = form.querySelector('[name=loc]').value.trim();
    if (nm) it.name = nm;
    var p = v ? C.parseQR(v) : { kind: 'error' };
    if (p.kind === 'coords') {
      /* Coordonnées collées : on garde l'adresse lisible si elle existait. */
      if (!addrText(it)) it.raw = v;
      it.lat = p.lat; it.lon = p.lon; it.approx = false; it.found = '';
    } else if (p.kind === 'address' && v !== it.raw) {
      it.raw = v; it.lat = null; it.lon = null; it.found = ''; it.approx = false;
      var g = await geocode(p.text);
      if (g) { it.lat = g.lat; it.lon = g.lon; it.found = g.label; it.approx = g.approx; }
    }
    editingId = null; persist(); updateReference(); renderList();
    toast('Dépôt enregistré');
  });

  $('#btn-locate-all').addEventListener('click', async function () {
    var b = this, todo = items.filter(function (i) { return !hasPos(i); }), ok = 0;
    b.disabled = true;
    for (var k = 0; k < todo.length; k++) {
      b.textContent = 'Recherche ' + (k + 1) + ' / ' + todo.length + '…';
      var it = todo[k], g = await geocode(addrText(it) || it.raw);
      if (g) { it.lat = g.lat; it.lon = g.lon; it.found = g.label; it.approx = g.approx; ok++; persist(); updateReference(); }
    }
    b.disabled = false; renderList();
    var apx = todo.filter(function (i) { return hasPos(i) && i.approx; }).length;
    toast(ok + ' sur ' + todo.length + ' localisé' + (ok > 1 ? 's' : '') + (apx ? ', dont ' + apx + ' à vérifier' : ''), 4000);
  });

  var wipeArm = null;
  $('#btn-wipe').addEventListener('click', function () {
    var b = this;
    if (!wipeArm) { b.textContent = 'Confirmer : tout supprimer'; wipeArm = setTimeout(function () { wipeArm = null; b.textContent = 'Tout supprimer'; }, 3500); return; }
    clearTimeout(wipeArm); wipeArm = null; b.textContent = 'Tout supprimer';
    items = []; save(LS.items, items); renderList(); toast('Liste vidée');
  });

  /* ---------- Import / export CSV ---------- */
  function headKey(h) { return norm(h).replace(/ /g, '_'); }
  $('#file-import').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = ''; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var rows = C.splitCsv(String(rd.result));
      if (rows.length < 2) { toast('Fichier vide ou illisible.', 3500); return; }
      var h = rows[0].map(headKey);
      var col = function (names) { for (var i = 0; i < names.length; i++) { var k = h.indexOf(names[i]); if (k >= 0) return k; } return -1; };
      var cN = col(['nom', 'name', 'depot']), cS = col(['saisie', 'adresse', 'address', 'localisation']);
      var cLa = col(['latitude', 'lat']), cLo = col(['longitude', 'lon', 'lng']), cQ = col(['contenu_qr', 'qr']);
      if (cN < 0 && cS < 0) { toast('Colonnes « nom » et « saisie » introuvables.', 3500); return; }
      var added = 0, updated = 0, t = Date.now();
      rows.slice(1).forEach(function (r, i) {
        var name = String(cN >= 0 ? r[cN] || '' : '').trim(), raw = String(cS >= 0 ? r[cS] || '' : '').trim();
        if (!name && !raw) return;
        if (!name) name = raw.slice(0, 80);
        var la = cLa >= 0 ? parseFloat(String(r[cLa]).replace(',', '.')) : NaN, lo = cLo >= 0 ? parseFloat(String(r[cLo]).replace(',', '.')) : NaN;
        var qr = cQ >= 0 ? String(r[cQ] || '').trim() : '';
        var it = items.find(function (x) { return x.name === name && x.raw === raw; });
        if (!it) { it = { id: uid(), name: name, raw: raw, lat: null, lon: null, found: '', approx: false, print: true, created: t + i }; items.push(it); added++; }
        else updated++;
        if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)) { it.lat = la; it.lon = lo; it.approx = false; }
        else if (!hasPos(it)) { var p = C.parseQR(raw); if (p.kind === 'coords') { it.lat = p.lat; it.lon = p.lon; } }
        it.payloads = it.payloads || [];
        if (qr && it.payloads.indexOf(qr) < 0) it.payloads.push(qr);
      });
      persist(); updateReference(); renderList();
      var missing = items.filter(function (x) { return !hasPos(x); }).length;
      toast(added + ' ajouté' + (added > 1 ? 's' : '') + (updated ? ', ' + updated + ' mis à jour' : '') + (missing ? ' · ' + missing + ' à localiser' : ''), 4000);
    };
    rd.readAsText(f);
  });
  $('#btn-export').addEventListener('click', function () {
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = ['nom;saisie;latitude;longitude;contenu_qr'];
    items.forEach(function (it) { lines.push([q(it.name), q(it.raw), q(hasPos(it) ? n6(it.lat) : ''), q(hasPos(it) ? n6(it.lon) : ''), q(payload(it))].join(';')); });
    download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), 'depots-qr.csv');
  });

  /* ---------- Impression ---------- */
  function renderSheet() {
    $('#opt-per').value = String(opts.per); $('#opt-which').value = opts.which;
    var list = opts.which === 'checked' ? items.filter(function (i) { return i.print !== false; }) : items.slice();
    var per = opts.per, pages = Math.ceil(list.length / per), html = '';
    var px = per === 1 ? 1200 : per === 6 ? 700 : 500;
    for (var p = 0; p < pages; p++) {
      html += '<div class="page per-' + per + '">';
      list.slice(p * per, (p + 1) * per).forEach(function (it) {
        html += '<div class="tag"><img alt="QR code ' + esc(it.name) + '" src="' + qrDataUrl(payload(it), px) + '"><b>' + esc(it.name) + '</b><small>' + esc(subText(it)) + '</small></div>';
      });
      html += '</div>';
    }
    $('#sheet').innerHTML = html;
    var noGps = list.filter(function (i) { return !hasPos(i); }).length;
    $('#print-info').textContent = list.length
      ? list.length + ' étiquette' + (list.length > 1 ? 's' : '') + ' sur ' + pages + ' page' + (pages > 1 ? 's' : '') + '.' + (noGps ? ' Attention : ' + noGps + ' sans point GPS.' : '')
      : 'Aucun dépôt à imprimer.';
    $('#btn-print').disabled = !list.length;
  }
  $('#opt-per').addEventListener('change', function () { opts.per = parseInt(this.value, 10) || 12; save(LS.opts, opts); renderSheet(); });
  $('#opt-which').addEventListener('change', function () { opts.which = this.value; save(LS.opts, opts); renderSheet(); });
  $('#btn-print').addEventListener('click', function () { renderSheet(); setTimeout(function () { window.print(); }, 50); });

  /* ---------- Démarrage ---------- */
  var r0 = document.querySelector('input[name=fmt][value="' + opts.fmt + '"]'); if (r0) r0.checked = true;
  updateReference(); renderSummary(); renderPreview();
  if (items.length) syncMemo();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.register('sw.js').then(function (reg) { if (reg && reg.update) reg.update().catch(function () { /* hors ligne */ }); }).catch(function () { /* hors ligne non disponible */ });
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
