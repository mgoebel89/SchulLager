'use strict';

// Backend der Lagerverwaltung (David-Roentgen-Schule).
//
// Der Container steht in einem ÖFFENTLICHEN Schulnetz. Deshalb hat diese App —
// anders als die Schwesterprojekte Imkerei und Gemeindeverwaltung — eine echte
// Nutzerverwaltung. Lesen ist bewusst auch ohne Anmeldung möglich (QR am Gerät
// scannen und sofort sehen, was es ist und wo es hingehört); jede Buchung
// verlangt eine Anmeldung.
//
// Den Bestand hält Homebox, nicht diese Datenbank. Siehe db.js.

const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const db = require('./db');
const auth = require('./auth');
const createAuthRouter = require('./routes/auth');
const createBenutzerRouter = require('./routes/benutzer');
const createLagerRouter = require('./routes/lager');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
// nginx terminiert TLS und meldet das Schema über X-Forwarded-Proto. Ohne
// trust proxy hielte Express jede Anfrage für unverschlüsselt und setzte das
// Sitzungs-Cookie ohne `Secure`.
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(auth.sitzungLesen);

// --- WebSocket-Broadcast ---
// Damit ein zweites Gerät eine Buchung sofort sieht. Die Nachrichten enthalten
// keine Geheimnisse; der Kanal ist derselbe wie in den Schwesterprojekten.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1) {
      try { c.send(data); } catch (_) {}
    }
  }
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'hello', t: Date.now() }));
});

// --- Health (immer offen, für Installer und Abnahme) ---
app.get('/api/health', (_req, res) => res.json({ ok: true, version: 1 }));

// --- Anmeldung ---
app.use('/api/auth', createAuthRouter());

// --- Benutzerverwaltung (nur Admin, prüft der Router selbst) ---
app.use('/api/benutzer', createBenutzerRouter());

// --- Lager (Homebox-Proxy; Rechte regelt der Router je Route) ---
app.use('/api/lager', createLagerRouter());

// --- App-Einstellungen ---
// Lesen darf jeder Angemeldete (die Oberfläche braucht z. B. die Klassenliste),
// Ändern nur der Admin. Zugangsdaten stehen NICHT hier drin, sondern unter
// eigenen Schlüsseln in der settings-Tabelle — siehe db.js.
app.get('/api/settings', auth.requireAuth, (_req, res) => res.json(db.getSettings() || null));
app.put('/api/settings', auth.requireRolle('admin'), (req, res) => {
  const saved = db.saveSettings(req.body || {});
  broadcast({ type: 'settings:save', settings: saved, origin: req.header('x-client-id') || '' });
  res.json(saved);
});

// --- Fehlerbehandlung ---
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Serverfehler' });
});

// Abgelaufene Sitzungen beim Start und danach stündlich wegräumen.
db.raeumeSitzungen();
setInterval(() => {
  try { db.raeumeSitzungen(); } catch (e) { console.warn('Sitzungen aufräumen:', e.message); }
}, 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`SchulLager-Backend lauscht auf http://${HOST}:${PORT}`);
  if (db.zaehleBenutzer() === 0) {
    console.log('Noch kein Benutzer angelegt — die Oberfläche zeigt beim ersten Aufruf die Ersteinrichtung.');
  }
});
