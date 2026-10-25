/* Circuit Dépôts — logique pure (sans DOM), testable sous Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Circuit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
  var BIG = 1e7;

  function validCoords(lat, lon) {
    return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }

  function coordsFromText(s) {
    var m = COORD_RE.exec(String(s));
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    return validCoords(lat, lon) ? { lat: lat, lon: lon } : null;
  }

  function fromAddressText(s, raw) {
    var c = coordsFromText(s);
    if (c) return { kind: 'coords', lat: c.lat, lon: c.lon, label: String(s).trim() };
    return { kind: 'address', text: String(s).replace(/\s*[\r\n]+\s*/g, ', ').replace(/\s+/g, ' ').trim() };
  }

  /* Interprète le contenu d'un QR code.
     table : { "code": "adresse" } optionnelle (import CSV). */
  function parseQR(raw, table) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return { kind: 'error', message: 'QR code vide' };

    if (table && Object.prototype.hasOwnProperty.call(table, text)) {
      return fromAddressText(table[text], text);
    }

    var g = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(text);
    if (g) {
      var glat = parseFloat(g[1]), glon = parseFloat(g[2]);
      if (validCoords(glat, glon)) return { kind: 'coords', lat: glat, lon: glon, label: glat.toFixed(5) + ', ' + glon.toFixed(5) };
    }

    if (text.charAt(0) === '{') {
      try {
        var o = JSON.parse(text);
        var lat = parseFloat(o.lat != null ? o.lat : o.latitude);
        var lon = parseFloat(o.lon != null ? o.lon : (o.lng != null ? o.lng : o.longitude));
        if (validCoords(lat, lon)) return { kind: 'coords', lat: lat, lon: lon, label: String(o.adresse || o.address || o.nom || lat.toFixed(5) + ', ' + lon.toFixed(5)) };
        var a = o.adresse || o.address || o.addr;
        if (a) return fromAddressText(a, text);
      } catch (e) { /* pas du JSON */ }
      return { kind: 'error', message: 'QR non reconnu (JSON sans adresse)' };
    }

    if (/^https?:\/\//i.test(text)) return parseUrl(text);

    var cleaned = text.replace(/^(adresse|address|addr)\s*[:=]\s*/i, '');
    if (coordsFromText(cleaned)) return fromAddressText(cleaned, text);
    if (!/[a-zà-ÿ]/i.test(cleaned)) {
      return { kind: 'error', message: 'Code « ' + clip(text) + ' » sans adresse associée. Importez la table code ; adresse.' };
    }
    if (/^[A-Za-z0-9_\-.:\/]{3,}$/.test(cleaned) && !/[a-zà-ÿ]{4,}\s/i.test(cleaned) && /\d/.test(cleaned) && cleaned.indexOf(' ') < 0) {
      return { kind: 'error', message: 'Code « ' + clip(text) + ' » inconnu. Importez la table code ; adresse.' };
    }
    if (cleaned.length < 6) return { kind: 'error', message: 'Texte trop court pour être une adresse' };
    return fromAddressText(cleaned, text);
  }

  function clip(s) { s = String(s); return s.length > 28 ? s.slice(0, 27) + '…' : s; }

  function parseUrl(text) {
    var u;
    try { u = new URL(text); } catch (e) { return { kind: 'error', message: 'Lien invalide' }; }
    var host = u.hostname.toLowerCase();
    var isShort = host === 'goo.gl' || host === 'maps.app.goo.gl' || host === 'bit.ly' || host === 'g.co';
    if (isShort) return { kind: 'error', message: 'Lien court non lisible hors ligne. Utilisez l’adresse ou la table code ; adresse.' };
    var isMap = /(^|\.)(google\.[a-z.]+|apple\.com|openstreetmap\.org|waze\.com)$/.test(host);
    if (!isMap) return { kind: 'error', message: 'Lien non reconnu. Importez la table code ; adresse.' };

    var full = decodeURIComponent(u.pathname + u.search + u.hash);
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
    if (textParam) return fromAddressText(textParam, text);
    var place = /\/place\/([^\/@]+)/.exec(u.pathname);
    if (place) return fromAddressText(decodeURIComponent(place[1]).replace(/\+/g, ' '), text);
    var at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(full);
    if (at) {
      var a2 = parseFloat(at[1]), o2 = parseFloat(at[2]);
      if (validCoords(a2, o2)) return { kind: 'coords', lat: a2, lon: o2, label: a2.toFixed(5) + ', ' + o2.toFixed(5) };
    }
    return { kind: 'error', message: 'Aucune adresse trouvée dans ce lien' };
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

  /* Distances et durées estimées sans réseau. */
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
        var m = haversine(points[i], points[j]) * 1.3;
        K[i][j] = m;
        D[i][j] = m / 12.5; // ≈ 45 km/h de moyenne
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

  /* Chemin ouvert le plus court (durée), départ fixe.
     D : matrice n×n entre dépôts. startRow : durées position -> dépôt, ou null (départ libre).
     Heuristique : plus proche voisin, puis 2-opt et déplacement de blocs (Or-opt). */
  function solveOpenPath(D, startRow, maxMs) {
    var n = D.length;
    if (n === 0) return { order: [], cost: 0 };
    if (n === 1) return { order: [0], cost: startRow ? startRow[0] : 0 };
    var S = n, M = [], i, j;
    for (i = 0; i <= n; i++) M.push(new Float64Array(n + 1));
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) M[i][j] = i === j ? 0 : D[i][j];
    for (j = 0; j < n; j++) M[S][j] = startRow ? startRow[j] : 0;

    function cost(p) {
      var c = 0;
      for (var k = 0; k < p.length - 1; k++) c += M[p[k]][p[k + 1]];
      return c;
    }

    var visited = new Array(n).fill(false), path = [S], cur = S;
    for (var step = 0; step < n; step++) {
      var best = -1, bv = Infinity;
      for (j = 0; j < n; j++) if (!visited[j] && M[cur][j] < bv) { bv = M[cur][j]; best = j; }
      visited[best] = true; path.push(best); cur = best;
    }

    var deadline = Date.now() + (maxMs || 1500);
    var bestCost = cost(path), L = path.length, improved = true;

    function reverse(p, a, b) {
      while (a < b) { var t = p[a]; p[a] = p[b]; p[b] = t; a++; b--; }
    }

    while (improved && Date.now() < deadline) {
      improved = false;
      var a, b;
      for (a = 1; a < L - 1; a++) {
        for (b = a + 1; b < L; b++) {
          reverse(path, a, b);
          var c = cost(path);
          if (c < bestCost - 1e-6) { bestCost = c; improved = true; } else reverse(path, a, b);
        }
      }
      var moved = true;
      while (moved && Date.now() < deadline) {
        moved = false;
        for (var len = 1; len <= 3 && !moved; len++) {
          for (a = 1; a + len <= L && !moved; a++) {
            var seg = path.slice(a, a + len);
            var rest = path.slice(0, a).concat(path.slice(a + len));
            for (var p = 1; p <= rest.length; p++) {
              if (p === a) continue;
              var cand = rest.slice(0, p).concat(seg, rest.slice(p));
              var cc = cost(cand);
              if (cc < bestCost - 1e-6) { path = cand; bestCost = cc; moved = true; improved = true; break; }
            }
          }
        }
      }
    }
    return { order: path.slice(1), cost: bestCost };
  }

  function splitLegs(order, size) {
    var legs = [];
    size = Math.max(1, size || 10);
    for (var i = 0; i < order.length; i += size) legs.push(order.slice(i, i + size));
    return legs;
  }

  /* Durée et distance de chaque tronçon. La liaison entre deux tronçons
     est comptée dans le tronçon qui suit. */
  function legStats(order, D, K, startD, startK, size) {
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
    return { legs: legs, totalSec: totalSec, totalM: totalM };
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

  function wazeUrl(p) {
    return 'https://waze.com/ul?ll=' + encodeURIComponent(p.lat.toFixed(6) + ',' + p.lon.toFixed(6)) + '&navigate=yes&zoom=17';
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
    parseQR: parseQR, parseTable: parseTable, haversine: haversine,
    estimateMatrices: estimateMatrices, normalizeOSRM: normalizeOSRM,
    solveOpenPath: solveOpenPath, splitLegs: splitLegs, legStats: legStats,
    gmapsLegUrl: gmapsLegUrl, wazeUrl: wazeUrl, appleUrl: appleUrl,
    fmtDuration: fmtDuration, fmtKm: fmtKm
  };
});
