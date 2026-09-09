'use strict';

// Paperless-ngx als Ablage für Lieferscheine und Rechnungen.
//
// Die Schule betreibt Paperless bereits. Diese App legt dort nichts Eigenes an
// und räumt dort nicht auf — sie schiebt Belege hinein und merkt sich die
// Dokument-Nummer am Vorgang. Wer den Beleg sucht, findet ihn also an beiden
// Enden: in Paperless über Tag und Ablagepfad, in der App über die Bestellung.
//
// Vorbild ist der erprobte Client des Unterrichtstools (drs-lxc,
// app/services/paperless_client.py). Alle dort teuer gelernten Eigenheiten
// stehen hier wieder — sie gelten unverändert:
//
//   * `post_document` antwortet mit der nackten Task-UUID. Das ist gültiges
//     JSON (ein String!), landet also NICHT im Parser-Fehlerzweig. Wer das
//     übersieht, verliert die Kennung und wartet danach auf ein Ergebnis, das
//     nie kommt.
//   * Der Upload ist ASYNCHRON (Paperless macht OCR). Die Dokument-Nummer gibt
//     es erst über /api/tasks/ — deshalb merkt sich diese App zuerst die
//     Task-UUID und löst sie später auf.
//   * Der Token gehört in den Kopf `Authorization: Token <…>` und bleibt auf
//     dem Server. Der Browser spricht ausschließlich mit /api/dokumente/*.
//
// Anders als in drs-lxc liegt der Zugang hier EINMAL für die ganze Schule
// (Admin pflegt ihn in den Einstellungen) und nicht je Benutzer: das Lager hat
// ein Paperless, nicht jede Lehrkraft ihr eigenes.

const db = require('./db');

const TIMEOUT_MS = 20000;      // Uploads dauern länger als ein Listenabruf
const MAX_SEITEN = 20;         // Deckel beim Durchblättern von Stammlisten

class PaperlessError extends Error {
  constructor(nachricht, status = 502) {
    super(nachricht);
    this.name = 'PaperlessError';
    this.status = status;
  }
}

// --- Konfiguration --------------------------------------------------------
function getConfig() {
  const c = db.getPaperlessConfig() || {};
  return {
    url: String(c.url || '').replace(/\/+$/, ''),
    token: String(c.token || ''),
    uploadTagId: Number(c.uploadTagId) || 0,
    ablagepfadId: Number(c.ablagepfadId) || 0,
    typLieferscheinId: Number(c.typLieferscheinId) || 0,
    typRechnungId: Number(c.typRechnungId) || 0,
  };
}

// Was der Browser sehen darf. Der Token nie — nur, DASS einer gesetzt ist.
function publicConfig() {
  const c = getConfig();
  return {
    url: c.url,
    hasToken: !!c.token,
    uploadTagId: c.uploadTagId,
    ablagepfadId: c.ablagepfadId,
    typLieferscheinId: c.typLieferscheinId,
    typRechnungId: c.typRechnungId,
    eingerichtet: isConfigured(),
  };
}

function setConfig(patch = {}) {
  const alt = getConfig();
  const neu = {
    url: patch.url !== undefined ? String(patch.url || '').trim().replace(/\/+$/, '') : alt.url,
    // Leerer Token heißt „behalten" — genau wie beim Homebox-Passwort. Sonst
    // müsste man ihn bei jeder Änderung an den Tags neu heraussuchen.
    token: patch.token ? String(patch.token).trim() : alt.token,
    uploadTagId: patch.uploadTagId !== undefined ? Number(patch.uploadTagId) || 0 : alt.uploadTagId,
    ablagepfadId: patch.ablagepfadId !== undefined ? Number(patch.ablagepfadId) || 0 : alt.ablagepfadId,
    typLieferscheinId: patch.typLieferscheinId !== undefined ? Number(patch.typLieferscheinId) || 0 : alt.typLieferscheinId,
    typRechnungId: patch.typRechnungId !== undefined ? Number(patch.typRechnungId) || 0 : alt.typRechnungId,
  };
  db.savePaperlessConfig(neu);
  return publicConfig();
}

function isConfigured() {
  const c = getConfig();
  return !!(c.url && c.token);
}

function pflichtConfig() {
  const c = getConfig();
  if (!c.url || !c.token) {
    throw new PaperlessError('Paperless ist noch nicht eingerichtet (Einstellungen → Paperless).', 503);
  }
  return c;
}

// --- Aufrufe --------------------------------------------------------------
async function call(pfad, { method = 'GET', params = null, body = null, form = null } = {}) {
  const cfg = pflichtConfig();
  const url = new URL(cfg.url + pfad);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const headers = { Authorization: `Token ${cfg.token}`, Accept: 'application/json' };
  // Bei multipart setzt fetch den Content-Type samt Grenzmarke selbst. Wer ihn
  // hier setzt, macht die Teile für Paperless unlesbar — dieselbe Falle wie
  // beim Foto-Anhang in homebox.js.
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new PaperlessError(`Paperless nicht erreichbar: ${e.message}`, 502);
  }

  if (res.status === 401 || res.status === 403) {
    throw new PaperlessError('Paperless lehnt den Zugang ab (Token prüfen).', 401);
  }
  if (res.status === 404) throw new PaperlessError('In Paperless nicht gefunden.', 404);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new PaperlessError(`Paperless meldet ${res.status}: ${txt.slice(0, 200)}`, 502);
  }

  const txt = await res.text();
  if (!txt) return {};
  let daten;
  try { daten = JSON.parse(txt); } catch (_) { return { raw: txt.trim().replace(/^"|"$/g, '') }; }
  // Siehe Kopfkommentar: post_document liefert einen JSON-STRING, keine Karte.
  if (typeof daten === 'string') return { raw: daten.trim() };
  if (Array.isArray(daten)) return { results: daten };
  return daten;
}

// Eine vollständige Stammliste über alle Seiten.
async function alleSeiten(pfad) {
  const out = [];
  for (let seite = 1; seite <= MAX_SEITEN; seite++) {
    const d = await call(pfad, { params: { page: seite, page_size: 100 } });
    out.push(...(d.results || []));
    if (!d.next) break;
  }
  return out;
}

const schlank = (liste) => liste.map(x => ({ id: x.id, name: x.name }));

// Tags, Ablagepfade und Dokumenttypen — für die Auswahl in den Einstellungen.
async function stammlisten() {
  const [tags, pfade, typen] = await Promise.all([
    alleSeiten('/api/tags/'),
    alleSeiten('/api/storage_paths/').catch(() => []),
    alleSeiten('/api/document_types/').catch(() => []),
  ]);
  return { tags: schlank(tags), ablagepfade: schlank(pfade), dokumenttypen: schlank(typen) };
}

async function test() {
  const d = await call('/api/documents/', { params: { page_size: 1 } });
  return { ok: true, dokumente: d.count != null ? d.count : null };
}

// --- Upload ---------------------------------------------------------------
// Upload-Tag und Ablagepfad werden IMMER mitgegeben — genau dafür gibt es die
// Einstellung. Zurück kommt die Task-UUID, nicht die Dokument-Nummer.
async function hochladen({ daten, dateiname, mimetype, titel = '', erstellt = '', typId = 0 }) {
  const cfg = pflichtConfig();
  const form = new FormData();
  form.append('document', new Blob([daten], { type: mimetype || 'application/octet-stream' }), dateiname || 'beleg.pdf');
  if (String(titel).trim()) form.append('title', String(titel).trim());
  if (String(erstellt).trim()) form.append('created', String(erstellt).trim());
  if (typId) form.append('document_type', String(typId));
  if (cfg.ablagepfadId) form.append('storage_path', String(cfg.ablagepfadId));
  if (cfg.uploadTagId) form.append('tags', String(cfg.uploadTagId));

  const d = await call('/api/documents/post_document/', { method: 'POST', form });
  const taskId = String(d.raw || d.task_id || '');
  if (!taskId) throw new PaperlessError('Paperless hat keine Vorgangsnummer für den Upload geliefert.', 502);
  return taskId;
}

// Status eines Uploads. `dokumentId` bleibt null, solange Paperless noch
// verarbeitet — das ist kein Fehler, sondern der Normalfall der ersten
// Sekunden.
async function taskStatus(taskId) {
  const d = await call('/api/tasks/', { params: { task_id: taskId } });
  const items = Array.isArray(d.results) ? d.results : (Array.isArray(d) ? d : []);
  if (!items.length) return { status: 'PENDING', dokumentId: null, fehler: '' };
  const t = items[0];
  return {
    status: t.status || 'PENDING',
    dokumentId: t.related_document || null,
    fehler: t.status === 'FAILURE' ? String(t.result || 'Paperless konnte die Datei nicht verarbeiten.') : '',
  };
}

async function dokument(id) {
  const d = await call(`/api/documents/${Number(id)}/`);
  return {
    id: d.id,
    titel: d.title || '',
    erstellt: (d.created_date || d.created || '').slice(0, 10),
    typId: d.document_type || 0,
    dateiname: d.original_file_name || '',
  };
}

// Vorschau, Miniatur oder Original. Läuft über den Server, damit der Browser
// weder den Token noch eine eigene Verbindung zu Paperless braucht.
async function datei(id, art = 'preview') {
  const cfg = pflichtConfig();
  const suffix = { preview: 'preview', thumb: 'thumb', download: 'download' }[art] || 'preview';
  let res;
  try {
    res = await fetch(`${cfg.url}/api/documents/${Number(id)}/${suffix}/`, {
      headers: { Authorization: `Token ${cfg.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new PaperlessError(`Paperless nicht erreichbar: ${e.message}`, 502);
  }
  if (!res.ok) throw new PaperlessError(`Datei nicht abrufbar (${res.status}).`, res.status === 404 ? 404 : 502);
  const buf = Buffer.from(await res.arrayBuffer());
  return { daten: buf, mimetype: res.headers.get('content-type') || 'application/octet-stream' };
}

module.exports = {
  PaperlessError,
  publicConfig, setConfig, isConfigured,
  stammlisten, test, hochladen, taskStatus, dokument, datei,
};
