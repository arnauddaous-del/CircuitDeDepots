/* Circuit Dépôts — logique pure (sans DOM), testable sous Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Circuit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
  var BIG = 1e7;
  /* Point de référence pour les Plus Codes courts (« FHW7+VQ8 Bayonne ») : Bayonne par défaut. */
  var REF = { lat: 43.4929, lon: -1.4748 };
  function setReference(lat, lon) { if (validCoords(lat, lon)) REF = { lat: lat, lon: lon }; }
  function getReference() { return { lat: REF.lat, lon: REF.lon }; }

  function validCoords(lat, lon) {
    return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }
  function fix(v) { return Math.round(v * 1e6) / 1e6; }

  function coordsFromText(s) {
    var str = String(s).trim();
    var m = COORD_RE.exec(str);
    if (!m) {
      /* virgule décimale : « 43,4929 ; -1,4748 » */
      var m2 = /^\s*(-?\d{1,2},\d+)\s*[;\s]\s*(-?\d{1,3},\d+)\s*$/.exec(str);
      if (!m2) return null;
      m = [null, m2[1].replace(',', '.'), m2[2].replace(',', '.')];
    }
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    return validCoords(lat, lon) ? { lat: lat, lon: lon } : null;
  }

  /* ---------- Plus Codes (Open Location Code) ---------- */
  var OLC = '23456789CFGHJMPQRVWX';
  var PLUS_RE = /(^|[\s,])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3})(?=$|[\s,])/i;

  function olcDecode(code) {
    code = String(code).toUpperCase().replace('+', '').replace(/0+$/, '');
    var lat = -90, lng = -180, res = 20, i, n = Math.min(code.length, 10);
    for (i = 0; i < n; i += 2) {
      var a = OLC.indexOf(code[i]), b = OLC.indexOf(code[i + 1]);
      if (a < 0 || b < 0) return null;
      lat += a * res; lng += b * res;
      if (i + 2 < n) res /= 20;
    }
    var latRes = res, lngRes = res;
    for (i = 10; i < code.length; i++) {
      var d = OLC.indexOf(code[i]); if (d < 0) return null;
      latRes /= 5; lngRes /= 4;
      lat += Math.floor(d / 4) * latRes; lng += (d % 4) * lngRes;
    }
    return { lat: lat + latRes / 2, lon: lng + lngRes / 2 };
  }
  function olcPrefix(lat, lng, len) {
    lat = Math.min(89.9999, Math.max(-90, lat)) + 90; lng = ((lng + 180) % 360 + 360) % 360;
    var out = '', res = 20;
    for (var i = 0; i < len; i += 2) {
      var a = Math.floor(lat / res), b = Math.floor(lng / res);
      out += OLC[a] + OLC[b]; lat -= a * res; lng -= b * res; res /= 20;
    }
    return out;
  }
  function olcRecover(code, refLat, refLon) {
    code = String(code).toUpperCase();
    var plus = code.indexOf('+');
    if (plus < 0) return null;
    if (plus >= 8) return olcDecode(code);
    var pad = 8 - plus, resolution = Math.pow(20, 2 - pad / 2), half = resolution / 2;
    var c = olcDecode(olcPrefix(refLat, refLon, pad) + code);
    if (!c) return null;
    if (refLat + half < c.lat && c.lat - resolution >= -90) c.lat -= resolution;
    else if (refLat - half > c.lat && c.lat + resolution <= 90) c.lat += resolution;
    if (refLon + half < c.lon) c.lon -= resolution;
    else if (refLon - half > c.lon) c.lon += resolution;
    return c;
  }
  function plusCodeFrom(s) {
    var m = PLUS_RE.exec(String(s));
    if (!m || m[2].length < 6) return null;
    var c = olcRecover(m[2], REF.lat, REF.lon);
    return c && validCoords(c.lat, c.lon) ? { code: m[2].toUpperCase(), lat: fix(c.lat), lon: fix(c.lon) } : null;
  }

  function fromAddressText(s) {
    var c = coordsFromText(s);
    if (c) return { kind: 'coords', lat: c.lat, lon: c.lon, label: String(s).trim() };
    var pc = plusCodeFrom(s);
    if (pc) return { kind: 'coords', lat: pc.lat, lon: pc.lon, label: String(s).trim(), plusCode: pc.code };
    return { kind: 'address', text: String(s).replace(/\s*[\r\n]+\s*/g, ', ').replace(/\s+/g, ' ').trim() };
  }

  /* Interprète le contenu d'un QR code.
     table : { "code": "adresse" } optionnelle (import CSV). */
  function parseQR(raw, table) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return { kind: 'error', message: 'QR code vide' };

    if (table && Object.prototype.hasOwnProperty.call(table, text)) {
      return fromAddressText(table[text]);
    }

    var g = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(text);
    if (g) {
      var glat = parseFloat(g[1]), glon = parseFloat(g[2]);
      if (validCoords(glat, glon)) return { kind: 'coords', lat: glat, lon: glon, label: glat.toFixed(5) + ', ' + glon.toFixed(5) };
      var gq = /[?&]q=([^&]+)/.exec(text);
      if (gq) { try { return fromAddressText(decodeURIComponent(gq[1].replace(/\+/g, ' '))); } catch (e) { /* suite */ } }
    }

    if (text.charAt(0) === '{') {
      try {
        var o = JSON.parse(text);
        var lat = parseFloat(o.lat != null ? o.lat : o.latitude);
        var lon = parseFloat(o.lon != null ? o.lon : (o.lng != null ? o.lng : o.longitude));
        if (validCoords(lat, lon)) return { kind: 'coords', lat: lat, lon: lon, label: String(o.adresse || o.address || o.nom || lat.toFixed(5) + ', ' + lon.toFixed(5)) };
        var a = o.adresse || o.address || o.addr;
        if (a) return fromAddressText(a);
      } catch (e) { /* pas du JSON */ }
      return { kind: 'error', message: 'QR non reconnu (JSON sans adresse)' };
    }

    if (/^https?:\/\//i.test(text)) return parseUrl(text);

    var cleaned = text.replace(/^(adresse|address|addr)\s*[:=]\s*/i, '');
    var direct = fromAddressText(cleaned);
    if (direct.kind === 'coords') return direct;
    if (!/[a-zà-ÿ]/i.test(cleaned)) {
      return { kind: 'error', message: 'Code « ' + clip(text) + ' » sans adresse associée. Importez la table code ; adresse.' };
    }
    if (/^[A-Za-z0-9_\-.:\/]{3,}$/.test(cleaned) && !/[a-zà-ÿ]{4,}\s/i.test(cleaned) && /\d/.test(cleaned) && cleaned.indexOf(' ') < 0) {
      return { kind: 'error', message: 'Code « ' + clip(text) + ' » inconnu. Importez la table code ; adresse.' };
    }
    if (cleaned.length < 6) return { kind: 'error', message: 'Texte trop court pour être une adresse' };
    return direct;
  }

  function clip(s) { s = String(s); return s.length > 28 ? s.slice(0, 27) + '…' : s; }

  function parseUrl(text) {
    var u;
    try { u = new URL(text); } catch (e) { return { kind: 'error', message: 'Lien invalide' }; }
    var host = u.hostname.toLowerCase();
    var isShort = host === 'goo.gl' || host === 'maps.app.goo.gl' || host === 'bit.ly' || host === 'g.co';
    if (isShort) return { kind: 'error', message: 'Lien court illisible. Collez les coordonnées ou l’adresse.' };
    var isMap = /(^|\.)(google\.[a-z.]+|apple\.com|openstreetmap\.org|waze\.com)$/.test(host);
    if (!isMap) return { kind: 'error', message: 'Lien non reconnu. Importez la table code ; adresse.' };

    var full;
    try { full = decodeURIComponent(u.pathname + u.search + u.hash); } catch (e) { full = u.pathname + u.search + u.hash; }
    var m34 = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(full);
    if (m34) {
      var a1 = parseFloat(m34[1]), o1 = parseFloat(m34[2]);
      if (validCoords(a1, o1)) return { kind: 'coords', lat: a1, lon: o1, label: a1.toFixed(5) + ', ' + o1.toFixed(5) };
    }
    var keys = ['ll', 'q', 'query', 'daddr', 'destination', 'address', 'to'];
    var textParam = null;
    for (var i = 0; i < keys.length; i++) {
      var v = u.searchParams.get(keys[i]);
      if (!v) continue;
      var c = coordsFromText(v);
      if (c) return { kind: 'coords', lat: c.lat, lon: c.lon, label: c.lat.toFixed(5) + ', ' + c.lon.toFixed(5) };
      if (!textParam && keys[i] !== 'll') textParam = v;
    }
    if (textParam) return fromAddressText(textParam);
    var place = /\/place\/([^\/@]+)/.exec(u.pathname);
    if (place) { try { return fromAddressText(decodeURIComponent(place[1]).replace(/\+/g, ' ')); } catch (e) { /* suite */ } }
    var at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(full);
    if (at) {
      var a2 = parseFloat(at[1]), o2 = parseFloat(at[2]);
      if (validCoords(a2, o2)) return { kind: 'coords', lat: a2, lon: o2, label: a2.toFixed(5) + ', ' + o2.toFixed(5) };
    }
    return { kind: 'error', message: 'Aucune adresse trouvée dans ce lien' };
  }

  /* ---------- Fichiers importés ---------- */
  function splitCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = first.indexOf('\t') >= 0 ? '\t' : (first.split(';').length >= first.split(',').length ? ';' : ',');
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }
  function headKey(h) { return String(h).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  /* Carnet de dépôts exporté par le créateur de QR codes :
     colonnes nom ; saisie ; latitude ; longitude ; contenu_qr (ordre libre). */
  function parseCarnet(text) {
    var rows = splitCsv(text);
    if (rows.length < 2) return null;
    var h = rows[0].map(headKey);
    var col = function (names) { for (var i = 0; i < names.length; i++) { var k = h.indexOf(names[i]); if (k >= 0) return k; } return -1; };
    var cQ = col(['contenu_qr', 'qr', 'contenu']), cN = col(['nom', 'name', 'depot']), cS = col(['saisie', 'adresse', 'address']);
    var cLa = col(['latitude', 'lat']), cLo = col(['longitude', 'lon', 'lng']);
    if (cQ < 0 || (cN < 0 && cS < 0)) return null;
    var out = [];
    rows.slice(1).forEach(function (r) {
      var qr = String(r[cQ] || '').trim(); if (!qr) return;
      var e = { qr: qr, name: cN >= 0 ? String(r[cN] || '').trim() : '', saisie: cS >= 0 ? String(r[cS] || '').trim() : '' };
      var la = cLa >= 0 ? parseFloat(String(r[cLa]).replace(',', '.')) : NaN;
      var lo = cLo >= 0 ? parseFloat(String(r[cLo]).replace(',', '.')) : NaN;
      if (validCoords(la, lo)) { e.lat = la; e.lon = lo; }
      else {
        var p = parseQR(e.saisie) ; if (p.kind !== 'coords') p = parseQR(qr);
        if (p.kind === 'coords') { e.lat = p.lat; e.lon = p.lon; }
      }
      out.push(e);
    });
    return out;
  }

  /* Table "code ; adresse" (CSV, TSV). */
  function parseTable(text) {
    var out = {}, count = 0;
    String(text || '').split(/\r?\n/).forEach(function (line, idx) {
      line = line.trim();
      if (!line || line.charAt(0) === '#') return;
      var sep = line.indexOf('\t') >= 0 ? '\t' : (line.indexOf(';') >= 0 ? ';' : ',');
      var k = line.indexOf(sep);
      if (k < 1) return;
      var key = line.slice(0, k).trim().replace(/^"|"$/g, '');
      var val = line.slice(k + 1).trim().replace(/^"|"$/g, '');
      if (!key || !val) return;
      if (idx === 0 && /^(code|id|qr|qrcode|identifiant)$/i.test(key) && /^(adresse|address|addr)/i.test(val)) return;
      out[key] = val;
      count++;
    });
    return { table: out, count: count };
  }

  /* ---------- Distances et durées estimées sans réseau ---------- */
  function haversine(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function estimateMatrices(points) {
    var n = points.length, D = [], K = [];
    for (var i = 0; i < n; i++) {
      D.push(new Array(n)); K.push(new Array(n));
      for (var j = 0; j < n; j++) {
        if (i === j) { D[i][j] = 0; K[i][j] = 0; continue; }
        var m = haversine(points[i], points[j]) * 1.35;
        K[i][j] = m;
        D[i][j] = m / 6.9 + 20; // ≈ 25 km/h en ville + 20 s par arrêt
      }
    }
    return { D: D, K: K };
  }

  /* Réponse OSRM /table -> matrices propres. */
  function normalizeOSRM(resp) {
    if (!resp || resp.code !== 'Ok' || !resp.durations) throw new Error('Réponse OSRM invalide');
    var clean = function (M) {
      return M.map(function (row, i) {
        return row.map(function (v, j) { return i === j ? 0 : (v == null ? BIG : v); });
      });
    };
    return { D: clean(resp.durations), K: resp.distances ? clean(resp.distances) : null };
  }

  /* ---------- Ordre de passage le plus rapide ----------
     D : durées n×n entre dépôts (peut être asymétrique : sens uniques).
     startRow : durées départ -> dépôt (null = départ libre).
     endCol : durées dépôt -> point de retour (null = pas de retour, fin au dernier dépôt).
     Plusieurs départs (plus proche voisin, insertions aléatoires), puis 2-opt et
     déplacement de blocs, en recalculant le coût complet (exact même avec sens uniques). */
  function solvePath(D, startRow, endCol, maxMs) {
    var n = D.length;
    if (n === 0) return { order: [], cost: 0 };
    var S = n, E = n + 1, M = [], i, j;
    for (i = 0; i < n + 2; i++) M.push(new Float64Array(n + 2));
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) M[i][j] = i === j ? 0 : D[i][j];
    for (j = 0; j < n; j++) { M[S][j] = startRow ? startRow[j] : 0; M[j][E] = endCol ? endCol[j] : 0; }
    if (n === 1) return { order: [0], cost: M[S][0] + M[0][E] };

    function cost(p) { var c = 0; for (var k = 0; k < p.length - 1; k++) c += M[p[k]][p[k + 1]]; return c; }

    /* Jusqu’à 15 dépôts : calcul exact (programmation dynamique de Held-Karp). */
    if (n <= 15) {
      var FULL = (1 << n) - 1, dp = new Float64Array((FULL + 1) * n).fill(Infinity), par = new Int8Array((FULL + 1) * n).fill(-1);
      for (j = 0; j < n; j++) dp[(1 << j) * n + j] = M[S][j];
      for (var mask = 1; mask <= FULL; mask++) {
        for (j = 0; j < n; j++) {
          if (!(mask & (1 << j))) continue;
          var v = dp[mask * n + j]; if (v === Infinity) continue;
          for (var k = 0; k < n; k++) {
            if (mask & (1 << k)) continue;
            var nm = mask | (1 << k), nv = v + M[j][k];
            if (nv < dp[nm * n + k]) { dp[nm * n + k] = nv; par[nm * n + k] = j; }
          }
        }
      }
      var bj = 0, bv = Infinity;
      for (j = 0; j < n; j++) { var tot = dp[FULL * n + j] + M[j][E]; if (tot < bv) { bv = tot; bj = j; } }
      var ord = [], mk = FULL, cj = bj;
      while (cj >= 0) { ord.push(cj); var pj = par[mk * n + cj]; mk &= ~(1 << cj); cj = pj; }
      return { order: ord.reverse(), cost: bv, exact: true };
    }

    var seed = 20261025;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

    function improve(p, deadline) {
      var L = p.length, cur = cost(p), better = true;
      while (better && Date.now() < deadline) {
        better = false;
        for (var a = 1; a < L - 2; a++) {
          for (var b = a + 1; b < L - 1; b++) {
            var x = a, y = b, t;
            while (x < y) { t = p[x]; p[x] = p[y]; p[y] = t; x++; y--; }
            var c = cost(p);
            if (c < cur - 1e-6) { cur = c; better = true; }
            else { x = a; y = b; while (x < y) { t = p[x]; p[x] = p[y]; p[y] = t; x++; y--; } }
          }
        }
        for (var len = 1; len <= 3; len++) {
          for (var s = 1; s + len < L; s++) {
            var seg = p.slice(s, s + len);
            var rest = p.slice(0, s).concat(p.slice(s + len));
            var bestC = cur - 1e-6, bestP = null;
            for (var q = 1; q < rest.length; q++) {
              if (q === s) continue;
              var cand = rest.slice(0, q).concat(seg, rest.slice(q));
              var cc = cost(cand);
              if (cc < bestC) { bestC = cc; bestP = cand; }
              if (len > 1) {
                var cand2 = rest.slice(0, q).concat(seg.slice().reverse(), rest.slice(q));
                var cc2 = cost(cand2);
                if (cc2 < bestC) { bestC = cc2; bestP = cand2; }
              }
            }
            if (bestP) { for (var z = 0; z < L; z++) p[z] = bestP[z]; cur = bestC; better = true; }
          }
        }
      }
      return cur;
    }

    var deadline = Date.now() + (maxMs || 1500);
    var best = null, bestCost = Infinity, tries = 0;
    while (tries < 40 && (tries < 2 || Date.now() < deadline)) {
      var p;
      if (tries === 0) {
        var left = []; for (i = 0; i < n; i++) left.push(i);
        p = [S]; var cur = S;
        while (left.length) {
          var bi = 0; for (j = 1; j < left.length; j++) if (M[cur][left[j]] < M[cur][left[bi]]) bi = j;
          cur = left.splice(bi, 1)[0]; p.push(cur);
        }
        p.push(E);
      } else {
        var sh = []; for (i = 0; i < n; i++) sh.push(i);
        for (i = n - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); var tt = sh[i]; sh[i] = sh[j]; sh[j] = tt; }
        p = [S, E];
        sh.forEach(function (node) {
          var bp = 1, bc = Infinity;
          for (var z = 0; z < p.length - 1; z++) {
            var dc = M[p[z]][node] + M[node][p[z + 1]] - M[p[z]][p[z + 1]];
            if (dc < bc) { bc = dc; bp = z + 1; }
          }
          p.splice(bp, 0, node);
        });
      }
      var c = improve(p, deadline + 500);
      if (c < bestCost - 1e-6) { bestCost = c; best = p.slice(); }
      tries++;
    }
    return { order: best.slice(1, -1), cost: bestCost, tries: tries };
  }
  /* Compatibilité : ancien nom. */
  function solveOpenPath(D, startRow, maxMs) { return solvePath(D, startRow, null, maxMs); }

  function splitLegs(order, size) {
    var legs = [];
    size = Math.max(1, size || 10);
    for (var i = 0; i < order.length; i += size) legs.push(order.slice(i, i + size));
    return legs;
  }

  /* Durée et distance de chaque tronçon. La liaison entre deux tronçons
     est comptée dans le tronçon qui suit ; le retour éventuel est à part. */
  function legStats(order, D, K, startD, startK, size, endD, endK) {
    size = Math.max(1, size || 10);
    var legs = [], totalSec = 0, totalM = 0;
    for (var p = 0; p < order.length; p++) {
      var li = Math.floor(p / size);
      if (!legs[li]) legs[li] = { sec: 0, m: 0 };
      var s = 0, m = 0;
      if (p === 0) {
        if (startD) { s = startD[order[0]]; m = startK ? startK[order[0]] : 0; }
      } else {
        s = D[order[p - 1]][order[p]];
        m = K ? K[order[p - 1]][order[p]] : 0;
      }
      legs[li].sec += s; legs[li].m += m; totalSec += s; totalM += m;
    }
    var back = null;
    if (endD && order.length) {
      var last = order[order.length - 1];
      back = { sec: endD[last], m: endK ? endK[last] : 0 };
      totalSec += back.sec; totalM += back.m;
    }
    return { legs: legs, totalSec: totalSec, totalM: totalM, back: back };
  }

  function ll(p) { return p.lat.toFixed(6) + ',' + p.lon.toFixed(6); }

  /* Google Maps : jusqu'à 9 étapes + destination. Sans origine, Maps part de la position actuelle. */
  function gmapsLegUrl(stops, origin) {
    if (!stops.length) return '';
    var dest = stops[stops.length - 1], via = stops.slice(0, -1);
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination=' + encodeURIComponent(ll(dest));
    if (origin) url += '&origin=' + encodeURIComponent(ll(origin));
    if (via.length) url += '&waypoints=' + encodeURIComponent(via.map(ll).join('|'));
    return url;
  }
  function gmapsPointUrl(p) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ll(p));
  }

  function appleUrl(p) {
    return 'https://maps.apple.com/?daddr=' + encodeURIComponent(ll(p)) + '&dirflg=d';
  }

  function fmtDuration(sec) {
    var m = Math.round(sec / 60);
    if (m < 1) return '< 1 min';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h ' + (r < 10 ? '0' : '') + r;
  }

  function fmtKm(m) {
    var km = m / 1000;
    return (km < 10 ? km.toFixed(1) : Math.round(km)).toString().replace('.', ',') + ' km';
  }

  return {
    parseQR: parseQR, parseTable: parseTable, parseCarnet: parseCarnet, splitCsv: splitCsv, haversine: haversine,
    estimateMatrices: estimateMatrices, normalizeOSRM: normalizeOSRM,
    solvePath: solvePath, solveOpenPath: solveOpenPath, splitLegs: splitLegs, legStats: legStats,
    gmapsLegUrl: gmapsLegUrl, gmapsPointUrl: gmapsPointUrl, appleUrl: appleUrl,
    fmtDuration: fmtDuration, fmtKm: fmtKm,
    olcDecode: olcDecode, olcRecover: olcRecover, setReference: setReference, getReference: getReference
  };
});
