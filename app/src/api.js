(function () {
  'use strict';
  window.SL = window.SL || {};

  const WS_PATH = '/ws';

  // Eigene Client-Kennung: der Server schickt sie bei Broadcasts als `origin`
  // zurück, damit ein Gerät seine eigenen Änderungen nicht doppelt anwendet.
  const CLIENT_ID = (function () {
    let id = '';
    try { id = sessionStorage.getItem('sl.clientId') || ''; } catch (_) {}
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || ('c-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      try { sessionStorage.setItem('sl.clientId', id); } catch (_) {}
    }
    return id;
  })();

  const listeners = [];
  let ws = null;
  let wsReconnectTimer = null;
  let wsBackoff = 1000;

  // Fehler tragen den HTTP-Status mit. Die Oberfläche unterscheidet daran
  // „nicht angemeldet" (401) und „Passwort erst wechseln" (403 mit Code) von
  // echten Störungen — ohne den Status müsste sie in Texten herumraten.
  class ApiFehler extends Error {
    constructor(nachricht, status, code) {
      super(nachricht);
      this.name = 'ApiFehler';
      this.status = status;
      this.code = code || '';
    }
  }

  async function jsonFetch(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      // Ohne credentials schickt der Browser das Sitzungs-Cookie nicht mit.
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let daten = null;
      const txt = await res.text().catch(() => '');
      try { daten = JSON.parse(txt); } catch (_) {}
      throw new ApiFehler(
        (daten && daten.error) || `Fehler ${res.status}`,
        res.status,
        daten && daten.code,
      );
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('Content-Type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // --- Zustand ---
  const health = () => jsonFetch('/api/health');

  // --- Anmeldung ---
  const ich = () => jsonFetch('/api/auth/ich');
  const ersteinrichtung = (d) => jsonFetch('/api/auth/ersteinrichtung', { method: 'POST', body: d });
  const anmelden = (benutzername, passwort) => jsonFetch('/api/auth/anmelden', { method: 'POST', body: { benutzername, passwort } });
  const abmelden = () => jsonFetch('/api/auth/abmelden', { method: 'POST' });
  const passwortAendern = (alt, neu) => jsonFetch('/api/auth/passwort', { method: 'POST', body: { alt, neu } });

  // --- Benutzerverwaltung (Admin) ---
  const listBenutzer = () => jsonFetch('/api/benutzer');
  const benutzerAnlegen = (b) => jsonFetch('/api/benutzer', { method: 'POST', body: b });
  const benutzerSpeichern = (id, b) => jsonFetch(`/api/benutzer/${encodeURIComponent(id)}`, { method: 'PUT', body: b });
  const benutzerPasswort = (id, passwort) => jsonFetch(`/api/benutzer/${encodeURIComponent(id)}/passwort`, { method: 'POST', body: { passwort } });
  const benutzerLoeschen = (id) => jsonFetch(`/api/benutzer/${encodeURIComponent(id)}`, { method: 'DELETE' });

  // --- Einstellungen ---
  const getSettings = () => jsonFetch('/api/settings');
  const putSettings = (s) => jsonFetch('/api/settings', { method: 'PUT', body: s });

  // --- Lager (Homebox-Proxy) ---
  const lagerConfig = () => jsonFetch('/api/lager/config');
  const putLagerConfig = (c) => jsonFetch('/api/lager/config', { method: 'PUT', body: c });
  const lagerHealth = () => jsonFetch('/api/lager/health');
  const lagerSammlungen = () => jsonFetch('/api/lager/sammlungen');
  function lagerSuchen({ q = '', ortId = '', seite = 1, proSeite = 25 } = {}) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (ortId) p.set('ortId', ortId);
    p.set('seite', String(seite));
    p.set('proSeite', String(proSeite));
    return jsonFetch('/api/lager/?' + p.toString());
  }
  const lagerOrte = () => jsonFetch('/api/lager/orte');
  const lagerOrt = (id) => jsonFetch(`/api/lager/orte/${encodeURIComponent(id)}`);
  const lagerMarken = () => jsonFetch('/api/lager/marken');
  const lagerArtikel = (id) => jsonFetch(`/api/lager/${encodeURIComponent(id)}`);
  const lagerBeiBarcode = (code) => jsonFetch(`/api/lager/barcode/${encodeURIComponent(code)}`);
  const lagerBeiCode = (code) => jsonFetch(`/api/lager/code/${encodeURIComponent(code)}`);
  const lagerAnlegen = (a) => jsonFetch('/api/lager/', { method: 'POST', body: a });
  const lagerSpeichern = (id, a) => jsonFetch(`/api/lager/${encodeURIComponent(id)}`, { method: 'PUT', body: a });
  const lagerBestand = (id, arg) => jsonFetch(`/api/lager/${encodeURIComponent(id)}/bestand`, { method: 'POST', body: arg });

  const lagerNachbestellung = () => jsonFetch('/api/lager/nachbestellung');

  // Datei-Upload läuft NICHT über jsonFetch: bei multipart muss der Browser den
  // Content-Type samt Grenzmarke selbst setzen. Wer ihn von Hand setzt, macht
  // die Teile für den Server unlesbar.
  async function lagerFoto(id, datei) {
    const fd = new FormData();
    fd.append('foto', datei, datei.name || 'foto.jpg');
    const res = await fetch(`/api/lager/${encodeURIComponent(id)}/foto`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Client-Id': CLIENT_ID },
      body: fd,
    });
    if (!res.ok) {
      let daten = null;
      const txt = await res.text().catch(() => '');
      try { daten = JSON.parse(txt); } catch (_) {}
      throw new ApiFehler((daten && daten.error) || `Fehler ${res.status}`, res.status);
    }
    return res.json().catch(() => ({ ok: true }));
  }

  // --- WebSocket ---
  function subscribe(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    } catch (_) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => { wsBackoff = 1000; };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      for (const fn of listeners) { try { fn(msg); } catch (e) { console.warn('ws listener', e); } }
    };
    ws.onclose = () => scheduleReconnect();
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      wsBackoff = Math.min(wsBackoff * 2, 30000);
      connectWs();
    }, wsBackoff);
  }

  SL.api = {
    ApiFehler,
    clientId: CLIENT_ID,
    health,
    ich, ersteinrichtung, anmelden, abmelden, passwortAendern,
    listBenutzer, benutzerAnlegen, benutzerSpeichern, benutzerPasswort, benutzerLoeschen,
    getSettings, putSettings,
    lagerConfig, putLagerConfig, lagerHealth, lagerSammlungen,
    lagerSuchen, lagerOrte, lagerOrt, lagerMarken, lagerArtikel, lagerBeiBarcode, lagerBeiCode,
    lagerAnlegen, lagerSpeichern, lagerBestand, lagerNachbestellung, lagerFoto,
    subscribe, connectWs,
  };
})();
