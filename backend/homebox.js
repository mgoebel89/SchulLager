'use strict';

// REST-Client gegen Homebox.
//
// Homebox ist die führende Quelle fürs Lager. Es gibt bewusst KEINE lokale
// Kopie der Artikel: der Schulbestand ist dort bereits gepflegt und soll dort
// bleiben — die Homebox-Oberfläche muss weiter benutzbar sein. Fällt Homebox
// aus, ist die Lageransicht leer, aber Anmeldung und Ausleihdaten bleiben.
//
// Diese Datei ist aus der ImkereiApp übernommen und um das erweitert, was die
// Schule zusätzlich braucht: verschachtelte Lagerorte, eine eigene Kurzkennung
// für QR-Etiketten und ein Mindestbestand. Die dort teuer gelernten Fallen
// gelten unverändert und sind an Ort und Stelle kommentiert:
//
// 1. KEINE dauerhaften API-Tokens. Homebox kennt `POST /v1/users/login` und
//    gibt einen zeitlich begrenzten Token zurück. Zugangsdaten liegen deshalb
//    serverseitig; bei 401 meldet sich der Client selbst neu an.
// 2. API-BRUCH: neuere Versionen haben Items und Locations zu „Entities"
//    verschmolzen (`locationId` → `parentId`, Labels → Tags). Der Client
//    probiert neu, fällt bei 404 auf alt zurück und merkt sich den Stil.
// 3. SAMMLUNGEN: ein Konto kann mehrere getrennte Bestände haben. Welcher
//    gemeint ist, entscheidet `X-Tenant: <group-uuid>`.
// 4. Die Listenantwort ist eine KURZFASSUNG ohne Feldwerte. Wer den Treffer
//    eines Feld-Filters über den Feldwert nachprüft, findet nie etwas.

const db = require('./db');

const ENV_URL = (process.env.HOMEBOX_URL || '').replace(/\/+$/, '');
const ENV_USER = process.env.HOMEBOX_USER || '';
const ENV_PASS = process.env.HOMEBOX_PASSWORD || '';
const ENV_GROUP = process.env.HOMEBOX_GROUP_ID || '';

// Benutzerdefinierte Felder, die diese App in Homebox pflegt. Sie stehen in
// Homebox' eigener Oberfläche mit sichtbar — das ist gewollt.
//
// FELD_BARCODE      Hersteller-/Handelsbarcode (EAN). Die Asset-ID vergibt
//                   Homebox selbst und taugt dafür nicht.
// FELD_CODE         Kurzkennung dieser App für den QR-Code auf dem Etikett,
//                   z. B. "A-1042". Warum nicht die Homebox-ID? Die ist eine
//                   36-stellige UUID; als QR auf 12-mm-Band wird das Raster so
//                   fein, dass keine Handykamera es mehr liest.
// FELD_MINDEST      Mindestbestand für die Nachbestell-Liste.
const FELD_BARCODE = 'Barcode';
const FELD_CODE = 'Code';
const FELD_MINDEST = 'Mindestbestand';

let cfg = { url: ENV_URL, username: ENV_USER, password: ENV_PASS, groupId: ENV_GROUP, groupName: '' };
let token = '';
let tokenBis = 0;          // Zeitpunkt, ab dem neu angemeldet wird
let apiStil = null;        // 'entities' | 'items' — einmal erkannt, dann gemerkt
let feldFilter = null;     // kann der Server nach Feldwerten filtern? (siehe feldFilterPruefen)

function loadConfig() {
  let stored = null;
  try { stored = db.getHomeboxConfig(); } catch (_) { stored = null; }
  cfg = {
    url: ((stored && stored.url) ? String(stored.url) : ENV_URL).replace(/\/+$/, ''),
    username: (stored && stored.username) ? String(stored.username) : ENV_USER,
    password: (stored && stored.password) ? String(stored.password) : ENV_PASS,
    groupId: (stored && stored.groupId) ? String(stored.groupId) : ENV_GROUP,
    groupName: (stored && stored.groupName) ? String(stored.groupName) : '',
  };
  return cfg;
}
loadConfig();

// Leeres Passwortfeld lässt das bestehende stehen — so lässt sich die URL
// ändern, ohne das Passwort erneut einzutippen.
function setConfig({ url, username, password, groupId, groupName } = {}) {
  const cur = (() => { try { return db.getHomeboxConfig() || {}; } catch (_) { return {}; } })();
  const next = {
    url: (url != null ? String(url).trim() : (cur.url || '')).replace(/\/+$/, ''),
    username: (username != null ? String(username).trim() : (cur.username || '')),
    password: (password != null && String(password) !== '') ? String(password) : (cur.password || ''),
    // Leerer String ist hier eine gültige Angabe („Standard-Sammlung nehmen"),
    // deshalb auf undefined prüfen und nicht auf Wahrheitswert.
    groupId: (groupId !== undefined ? String(groupId || '').trim() : (cur.groupId || '')),
    groupName: (groupName !== undefined ? String(groupName || '').trim() : (cur.groupName || '')),
  };
  db.saveHomeboxConfig(next);
  loadConfig();
  // Zugang geändert → alles neu ermitteln. Auch den Feldfilter: eine andere
  // Homebox kann eine andere Version sein.
  token = ''; tokenBis = 0; apiStil = null; feldFilter = null;
  cacheVerwerfen();
  return publicConfig();
}

// Fürs Frontend: Passwort NIE herausgeben.
function publicConfig() {
  let stored = null;
  try { stored = db.getHomeboxConfig(); } catch (_) { stored = null; }
  const source = (stored && (stored.url || stored.username)) ? 'app' : ((ENV_URL || ENV_USER) ? 'env' : 'none');
  return {
    url: cfg.url || '',
    username: cfg.username || '',
    hasPassword: !!cfg.password,
    groupId: cfg.groupId || '',
    groupName: cfg.groupName || '',
    source,
    felder: { barcode: FELD_BARCODE, code: FELD_CODE, mindestbestand: FELD_MINDEST },
  };
}

function isConfigured() {
  return !!(cfg.url && cfg.username && cfg.password);
}

class HomeboxError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HomeboxError';
    this.status = status || 502;
  }
}

// --- Anmeldung ------------------------------------------------------------
async function login() {
  if (!isConfigured()) {
    throw new HomeboxError('Homebox ist nicht eingerichtet (Einstellungen → Homebox).', 503);
  }
  let res;
  try {
    res = await fetch(cfg.url + '/api/v1/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password, stayLoggedIn: true }),
    });
  } catch (e) {
    throw new HomeboxError(`Homebox nicht erreichbar: ${e.message}`, 502);
  }
  if (!res.ok) {
    // Homebox antwortet bei Anmeldefehlern bewusst mit 500, um keine Hinweise
    // zu geben. Für den Nutzer ist die wahrscheinlichste Ursache die richtige.
    const text = await res.text().catch(() => '');
    throw new HomeboxError(
      res.status === 500 || res.status === 401
        ? 'Anmeldung bei Homebox fehlgeschlagen — Benutzername oder Passwort stimmt nicht.'
        : `Homebox ${res.status}: ${text.slice(0, 200)}`,
      res.status === 500 ? 401 : res.status,
    );
  }
  const data = await res.json().catch(() => null);
  const roh = data && (data.token || data.Token);
  if (!roh) throw new HomeboxError('Homebox hat keinen Token geliefert.', 502);

  // Je nach Version enthält der Token das „Bearer "-Präfix bereits.
  token = String(roh).startsWith('Bearer ') ? String(roh) : 'Bearer ' + roh;

  // Ablauf: wenn Homebox einen nennt, den nehmen (mit Sicherheitsabstand),
  // sonst konservative sechs Stunden.
  const abl = data.expiresAt || data.expires_at;
  const ms = abl ? (new Date(abl).getTime() - Date.now()) : 0;
  tokenBis = Date.now() + (ms > 60000 ? ms - 60000 : 6 * 3600 * 1000);
  return token;
}

async function tokenHolen() {
  if (token && Date.now() < tokenBis) return token;
  return login();
}

// --- HTTP -----------------------------------------------------------------
// Ein 401 heißt fast immer „Token abgelaufen" — dann einmal neu anmelden und
// den Aufruf wiederholen, statt den Nutzer mit einem Fehler zu behelligen.
// `ohneSammlung` unterdrückt den X-Tenant-Header. Das braucht die Abfrage der
// Sammlungsliste: steht dort eine ungültige ID in der Konfiguration, antwortet
// Homebox mit 403 — und man käme nicht mehr an die Liste, um sie zu korrigieren.
async function api(pfad, { method = 'GET', body, params, wiederholt = false, ohneSammlung = false } = {}) {
  if (!isConfigured()) {
    throw new HomeboxError('Homebox ist nicht eingerichtet (Einstellungen → Homebox).', 503);
  }
  const t = await tokenHolen();
  const u = new URL(cfg.url + pfad);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { for (const x of v) u.searchParams.append(k, String(x)); }
    else u.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(u, {
      method,
      headers: {
        Authorization: t,
        Accept: 'application/json',
        // Ohne Header nimmt Homebox die Standard-Sammlung des Kontos.
        ...(!ohneSammlung && cfg.groupId ? { 'X-Tenant': cfg.groupId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new HomeboxError(`Homebox nicht erreichbar: ${e.message}`, 502);
  }

  if (res.status === 401 && !wiederholt) {
    token = ''; tokenBis = 0;
    return api(pfad, { method, body, params, ohneSammlung, wiederholt: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Homebox lehnt eine fremde Sammlung mit 403 ab und eine, die keine UUID
    // ist, mit 400. Beides ist derselbe Bedienfehler — also dieselbe Antwort.
    if (cfg.groupId && !ohneSammlung
        && (res.status === 403 || (res.status === 400 && /tenant/i.test(text)))) {
      throw new HomeboxError(
        `Kein Zugriff auf die eingestellte Sammlung${cfg.groupName ? ` „${cfg.groupName}"` : ''}. `
        + 'Bitte unter Einstellungen → Homebox eine andere wählen.', 403);
    }
    throw new HomeboxError(`Homebox ${res.status}: ${text.slice(0, 250)}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// Alle Sammlungen des Kontos. Bewusst OHNE X-Tenant, damit die Liste auch dann
// erreichbar bleibt, wenn die gespeicherte Sammlung nicht (mehr) zugänglich ist.
async function sammlungen() {
  const data = await api('/api/v1/groups/all', { ohneSammlung: true });
  const arr = Array.isArray(data) ? data : (data && data.items) || [];
  return arr.map(g => ({ id: g.id, name: g.name || '(ohne Namen)', waehrung: g.currency || '' }));
}

// --- API-Stil erkennen ----------------------------------------------------
async function stilErmitteln() {
  if (apiStil) return apiStil;
  try {
    await api('/api/v1/entities', { params: { page: 1, pageSize: 1 } });
    apiStil = 'entities';
  } catch (e) {
    if (e.status === 404) {
      await api('/api/v1/items', { params: { page: 1, pageSize: 1 } });
      apiStil = 'items';
    } else {
      throw e;   // 401/503 usw. sind echte Fehler, kein Versionsproblem
    }
  }
  return apiStil;
}

function artikelPfad(stil, id) {
  const basis = stil === 'entities' ? '/api/v1/entities' : '/api/v1/items';
  return id ? `${basis}/${encodeURIComponent(id)}` : basis;
}

// --- Benutzerdefinierte Felder -------------------------------------------
function feldLesen(felder, name) {
  const f = (felder || []).find(x => String(x.name || '').toLowerCase() === name.toLowerCase());
  if (!f) return '';
  // Homebox kennt mehrere Feldtypen; die App legt alle als Text an, liest aber
  // defensiv auch numerische, falls jemand das Feld in Homebox anders anlegt.
  if (f.textValue != null && f.textValue !== '') return String(f.textValue);
  if (f.numberValue != null) return String(f.numberValue);
  return '';
}

function feldSchreiben(roh, name, wert) {
  if (!Array.isArray(roh.fields)) roh.fields = [];
  const i = roh.fields.findIndex(f => String(f.name || '').toLowerCase() === name.toLowerCase());
  const text = (wert === null || wert === undefined) ? '' : String(wert);
  if (i >= 0) roh.fields[i].textValue = text;
  else roh.fields.push({ name, type: 'text', textValue: text });
}

// --- Normalisierung -------------------------------------------------------
// Beide API-Stile auf EINE Form bringen, damit das Frontend nichts von der
// Homebox-Version wissen muss.
function normArtikel(roh) {
  if (!roh) return null;
  const felder = roh.fields || [];
  const ort = roh.parent || roh.location || null;
  const marken = roh.tags || roh.labels || [];
  const mindest = feldLesen(felder, FELD_MINDEST);
  return {
    id: roh.id,
    name: roh.name || '',
    beschreibung: roh.description || '',
    menge: Number(roh.quantity) || 0,
    barcode: feldLesen(felder, FELD_BARCODE),
    code: feldLesen(felder, FELD_CODE),
    mindestbestand: mindest === '' ? null : (Number(mindest) || 0),
    ortId: ort ? ort.id : '',
    ortName: ort ? ort.name : '',
    marken: marken.map(m => ({ id: m.id, name: m.name })),
    assetId: roh.assetId || roh.assetID || '',
    kaufpreis: roh.purchasePrice != null ? Number(roh.purchasePrice) : null,
    kaufdatum: roh.purchaseTime || '',
    lieferant: roh.purchaseFrom || '',
    hersteller: roh.manufacturer || '',
    notizen: roh.notes || '',
    archiviert: !!roh.archived,
    // Kurzfassungen aus Listenantworten tragen KEINE Feldwerte. Wer das nicht
    // weiß, hält einen leeren Barcode für „kein Barcode gesetzt".
    vollstaendig: Array.isArray(roh.fields),
  };
}

function normOrt(roh) {
  const eltern = roh.parent || null;
  return {
    id: roh.id,
    name: roh.name || '',
    beschreibung: roh.description || '',
    elternId: roh.parentId || (eltern ? eltern.id : ''),
    anzahl: roh.itemCount != null ? roh.itemCount : null,
    // Kurzkennung fürs QR-Etikett am Fach (ab Phase 3 vergeben). Die alte
    // Locations-API kennt keine benutzerdefinierten Felder — dort bleibt der
    // Wert leer, und der Ort wird über seine ID angesprochen.
    code: feldLesen(roh.fields, FELD_CODE),
  };
}

function listeAus(data) {
  if (!data) return { eintraege: [], gesamt: 0 };
  const arr = data.items || data.results || (Array.isArray(data) ? data : []);
  return { eintraege: arr, gesamt: data.total != null ? data.total : arr.length };
}

// --- Lesen ----------------------------------------------------------------
async function suchen({ q = '', seite = 1, proSeite = 25, ortId = '' } = {}) {
  const stil = await stilErmitteln();
  const data = stil === 'entities'
    ? await api('/api/v1/entities', { params: { q, page: seite, pageSize: proSeite, parentIds: ortId || undefined } })
    : await api('/api/v1/items', { params: { q, page: seite, pageSize: proSeite, locations: ortId || undefined } });
  const { eintraege, gesamt } = listeAus(data);
  return { artikel: eintraege.map(normArtikel), gesamt, seite, proSeite };
}

async function holen(id) {
  const stil = await stilErmitteln();
  return normArtikel(await api(artikelPfad(stil, id)));
}

// Codes werden verglichen, nicht interpretiert — Leerzeichen aus der
// Handeingabe dürfen keinen Fehltreffer erzeugen.
function gleicherCode(a, b) {
  return String(a || '').trim() === String(b || '').trim();
}

// Kann diese Homebox serverseitig nach Feldwerten filtern? Einmal ermitteln
// und merken.
//
// Die Prüfung muss sein, weil ein nicht unterstützter Parameter schlicht
// ignoriert würde — die Antwort sähe dann aus wie „alles passt". Deshalb wird
// mit einem Wert gefragt, den es garantiert nicht gibt: kommt nichts zurück,
// obwohl das Lager gefüllt ist, hat der Server wirklich gefiltert.
async function feldFilterPruefen() {
  if (feldFilter !== null) return feldFilter;
  if (await stilErmitteln() !== 'entities') { feldFilter = false; return false; }
  try {
    const ohne = listeAus(await api('/api/v1/entities', { params: { page: 1, pageSize: 1 } }));
    // Leeres Lager: nichts zu erkennen — und nichts zu merken, sonst bliebe
    // das Ergebnis für die ganze Laufzeit falsch.
    if (!ohne.eintraege.length) return false;
    const mit = listeAus(await api('/api/v1/entities', {
      params: { fields: [`${FELD_BARCODE}=__gibt-es-nicht__`], page: 1, pageSize: 1 },
    }));
    feldFilter = mit.eintraege.length === 0;
  } catch (_) {
    feldFilter = false;
  }
  return feldFilter;
}

// Artikel über einen Feldwert finden (Barcode oder Kurzkennung).
//
// FALLE, die in der ImkereiApp real zugeschlagen hat: die Listenantwort ist
// eine Kurzfassung OHNE Feldwerte. Der Treffer des Serverfilters darf deshalb
// NICHT über den Feldwert nachgeprüft werden — der ist in der Liste immer leer,
// die App fände ihren eigenen Artikel nie wieder und legte ihn doppelt an.
// Der Filtertreffer ist maßgeblich; das Detail wird nur nachgeladen.
async function beiFeld(feldName, wert) {
  const code = String(wert || '').trim();
  if (!code) return null;

  if (await feldFilterPruefen()) {
    const data = await api('/api/v1/entities', {
      params: { fields: [`${feldName}=${code}`], page: 1, pageSize: 5 },
    });
    const { eintraege } = listeAus(data);
    if (!eintraege.length) return null;      // der Server hat exakt gefiltert
    return holen(eintraege[0].id);           // Detail nachladen (Feldwerte!)
  }
  return durchsuchenNachFeld(feldName, code);
}

const beiBarcode = (code) => beiFeld(FELD_BARCODE, code);
const beiCode = (code) => beiFeld(FELD_CODE, code);

// Rückfallweg für ältere Homebox-Versionen, deren Suche `q` nur Name und
// Beschreibung durchsucht und die keinen Feld-Filter kennt: erst `q`, dann
// seitenweise durchgehen und Details in Bündeln nachladen. Es entsteht dabei
// KEINE Kopie — alles bleibt innerhalb des einen Aufrufs.
const MAX_DURCHSUCHT = 1500;

async function durchsuchenNachFeld(feldName, code) {
  const stil = await stilErmitteln();
  const listenPfad = artikelPfad(stil);
  const feldWert = (a) => (feldName === FELD_CODE ? a.code : a.barcode);

  // 1. Der billige Versuch.
  try {
    const data = await api(listenPfad, { params: { q: code, pageSize: 10 } });
    const treffer = listeAus(data).eintraege.map(normArtikel).find(a => gleicherCode(feldWert(a), code));
    if (treffer) return holen(treffer.id);
  } catch (_) { /* egal, unten weiter */ }

  // 2. Vollständiger Durchgang.
  const proSeite = 100;
  let geprueft = 0;
  for (let seite = 1; seite <= Math.ceil(MAX_DURCHSUCHT / proSeite); seite++) {
    const data = await api(listenPfad, { params: { page: seite, pageSize: proSeite } });
    const { eintraege, gesamt } = listeAus(data);
    if (!eintraege.length) break;

    const artikel = eintraege.map(normArtikel);
    const direkt = artikel.find(a => gleicherCode(feldWert(a), code));
    if (direkt) return holen(direkt.id);

    // Keine Feldwerte in der Liste → Details nachladen, 10 gleichzeitig.
    if (artikel.some(a => !a.vollstaendig)) {
      for (let i = 0; i < artikel.length; i += 10) {
        const buendel = artikel.slice(i, i + 10);
        const details = await Promise.all(buendel.map(a => holen(a.id).catch(() => null)));
        const t = details.find(d => d && gleicherCode(feldWert(d), code));
        if (t) return t;
      }
    }

    geprueft += eintraege.length;
    if (eintraege.length < proSeite || (gesamt && geprueft >= gesamt)) break;
    if (geprueft >= MAX_DURCHSUCHT) {
      throw new HomeboxError(
        `In den ersten ${MAX_DURCHSUCHT} Artikeln nicht gefunden. Diese Homebox-Version kann nicht nach Feldwerten suchen — bitte über den Namen suchen.`,
        404,
      );
    }
  }
  return null;
}

// --- Lagerorte ------------------------------------------------------------
// Flache Liste MIT Elternbezug; den Baum baut das Frontend. So bleibt der
// Server dumm und die Anzeige (auf-/zuklappen, Suche) frei.
async function orte() {
  const stil = await stilErmitteln();
  const data = stil === 'entities'
    ? await api('/api/v1/entities', { params: { isLocation: true, pageSize: 500 } })
    : await api('/api/v1/locations', { params: { filterChildren: false } });
  const { eintraege } = listeAus(data);
  return eintraege.map(normOrt);
}

async function ortHolen(id) {
  const stil = await stilErmitteln();
  const pfad = stil === 'entities'
    ? `/api/v1/entities/${encodeURIComponent(id)}`
    : `/api/v1/locations/${encodeURIComponent(id)}`;
  return normOrt(await api(pfad));
}

async function marken() {
  const stil = await stilErmitteln();
  if (stil === 'items') {
    const { eintraege } = listeAus(await api('/api/v1/labels'));
    return eintraege.map(m => ({ id: m.id, name: m.name }));
  }
  const { eintraege } = listeAus(await api('/api/v1/tags', { params: { pageSize: 200 } }).catch(() => null));
  return eintraege.map(m => ({ id: m.id, name: m.name }));
}

// --- Schreiben ------------------------------------------------------------
// Homebox' PUT erwartet das VOLLSTÄNDIGE Objekt. Deshalb wird der Rohdatensatz
// geladen, verändert und zurückgeschrieben — sonst gingen Felder verloren, die
// diese App gar nicht kennt (und die in Homebox gepflegt wurden).
async function aktualisieren(id, patch) {
  const stil = await stilErmitteln();
  const pfad = artikelPfad(stil, id);
  const roh = await api(pfad);
  if (!roh) throw new HomeboxError('Artikel nicht gefunden.', 404);

  if (patch.name !== undefined) roh.name = patch.name;
  if (patch.beschreibung !== undefined) roh.description = patch.beschreibung;
  if (patch.menge !== undefined) roh.quantity = Number(patch.menge) || 0;
  if (patch.notizen !== undefined) roh.notes = patch.notizen;
  if (patch.hersteller !== undefined) roh.manufacturer = patch.hersteller;
  if (patch.lieferant !== undefined) roh.purchaseFrom = patch.lieferant;
  if (patch.kaufdatum !== undefined) roh.purchaseTime = patch.kaufdatum || null;
  if (patch.kaufpreis !== undefined) roh.purchasePrice = patch.kaufpreis === null ? 0 : Number(patch.kaufpreis);
  if (patch.ortId !== undefined) {
    if (stil === 'entities') roh.parentId = patch.ortId; else roh.locationId = patch.ortId;
  }
  if (patch.markenIds !== undefined) {
    if (stil === 'entities') roh.tagIds = patch.markenIds; else roh.labelIds = patch.markenIds;
  }
  if (patch.barcode !== undefined) feldSchreiben(roh, FELD_BARCODE, patch.barcode);
  if (patch.code !== undefined) feldSchreiben(roh, FELD_CODE, patch.code);
  if (patch.mindestbestand !== undefined) {
    feldSchreiben(roh, FELD_MINDEST, patch.mindestbestand === null ? '' : patch.mindestbestand);
  }

  // PUT will die IDs der Beziehungen, nicht die eingebetteten Objekte.
  if (stil === 'entities') {
    if (roh.parentId === undefined && roh.parent) roh.parentId = roh.parent.id;
    if (roh.tagIds === undefined && roh.tags) roh.tagIds = roh.tags.map(t => t.id);
  } else {
    if (roh.locationId === undefined && roh.location) roh.locationId = roh.location.id;
    if (roh.labelIds === undefined && roh.labels) roh.labelIds = roh.labels.map(l => l.id);
  }

  await api(pfad, { method: 'PUT', body: roh });
  // Jede Änderung kann die Nachbestell-Liste umwerfen (Menge, Mindestbestand).
  cacheVerwerfen();
  return holen(id);
}

async function anlegen({ name, beschreibung, menge, ortId, barcode, code, mindestbestand, markenIds, hersteller, kaufpreis, kaufdatum, lieferant, notizen }) {
  const stil = await stilErmitteln();
  const basis = {
    name: String(name || '').trim(),
    description: beschreibung || '',
    quantity: Number(menge) || 1,
  };
  if (stil === 'entities') {
    basis.parentId = ortId || undefined;
    if (markenIds && markenIds.length) basis.tagIds = markenIds;
  } else {
    basis.locationId = ortId || undefined;
    if (markenIds && markenIds.length) basis.labelIds = markenIds;
  }

  const angelegt = await api(artikelPfad(stil), { method: 'POST', body: basis });
  const id = angelegt && angelegt.id;
  if (!id) throw new HomeboxError('Homebox hat keine ID für den neuen Artikel geliefert.', 502);

  // Benutzerdefinierte Felder kann POST nicht — sie kommen per Update
  // hinterher. Das ist ein Aufruf mehr, aber der einzige verlässliche Weg.
  const nach = {};
  if (barcode) nach.barcode = barcode;
  if (code) nach.code = code;
  if (mindestbestand != null) nach.mindestbestand = mindestbestand;
  if (hersteller) nach.hersteller = hersteller;
  if (kaufpreis != null) nach.kaufpreis = kaufpreis;
  if (kaufdatum) nach.kaufdatum = kaufdatum;
  if (lieferant) nach.lieferant = lieferant;
  if (notizen) nach.notizen = notizen;
  if (Object.keys(nach).length) return aktualisieren(id, nach);
  // Ohne Nachtrag läuft kein aktualisieren() — der Merker muss trotzdem weg,
  // sonst fehlt ein frisch angelegter knapper Artikel in der Nachbestell-Liste.
  cacheVerwerfen();
  return holen(id);
}

// Bestand ändern. `delta` bucht relativ (Entnahme/Zugang), `menge` setzt absolut.
// Relativ ist der Normalfall am Lager und verhindert, dass zwei gleichzeitige
// Buchungen sich gegenseitig überschreiben.
async function bestandAendern(id, { delta, menge }) {
  if (menge != null) return aktualisieren(id, { menge: Math.max(0, Number(menge) || 0) });
  const a = await holen(id);
  if (!a) throw new HomeboxError('Artikel nicht gefunden.', 404);
  return aktualisieren(id, { menge: Math.max(0, a.menge + (Number(delta) || 0)) });
}

// --- Nachbestell-Liste ----------------------------------------------------
// „Was ist knapp?" kann Homebox nicht beantworten: der Mindestbestand ist ein
// benutzerdefiniertes Feld, und danach lässt sich nicht rechnen. Also geht der
// Server die Artikel einmal durch und vergleicht selbst.
//
// Das ist die teuerste Abfrage der ganzen App — deshalb ein kurzer
// Zwischenspeicher. Er wird bei jedem Schreibvorgang verworfen, damit eine
// Entnahme sofort in der Liste auftaucht; die 60 Sekunden fangen nur ab, dass
// mehrere Geräte gleichzeitig dasselbe ausrechnen lassen.
const NACHBESTELL_TTL_MS = 60 * 1000;
const MAX_DURCHGANG = 2000;
let nachbestellCache = null;
let herstellerCache = null;   // Deklaration hier, damit cacheVerwerfen() sie sicher kennt

function cacheVerwerfen() {
  nachbestellCache = null;
  herstellerCache = null;
  // Eine Änderung kann eine Marke setzen oder nehmen — der Demonstrator-Merker
  // wäre sonst bis zu einer Minute falsch.
  markeCacheVerwerfen();
}

async function nachbestellung() {
  if (nachbestellCache && Date.now() - nachbestellCache.zeit < NACHBESTELL_TTL_MS) {
    return nachbestellCache.daten;
  }
  const stil = await stilErmitteln();
  const listenPfad = artikelPfad(stil);
  const proSeite = 100;
  const knapp = [];
  let geprueft = 0;
  let unvollstaendig = false;

  for (let seite = 1; seite <= Math.ceil(MAX_DURCHGANG / proSeite); seite++) {
    const data = await api(listenPfad, { params: { page: seite, pageSize: proSeite } });
    const { eintraege, gesamt } = listeAus(data);
    if (!eintraege.length) break;

    const artikel = eintraege.map(normArtikel);
    // Kurzfassungen tragen keine Feldwerte — ohne die weiß niemand, ob ein
    // Mindestbestand gesetzt ist. Dann Details in Bündeln nachladen.
    const vollstaendig = artikel.every(a => a.vollstaendig);
    const geprueftePosten = vollstaendig ? artikel : await detailsNachladen(artikel);

    for (const a of geprueftePosten) {
      if (a && a.mindestbestand != null && a.menge <= a.mindestbestand) knapp.push(a);
    }

    geprueft += eintraege.length;
    if (eintraege.length < proSeite || (gesamt && geprueft >= gesamt)) break;
    if (geprueft >= MAX_DURCHGANG) { unvollstaendig = true; break; }
  }

  // Am dringendsten zuerst: der größte Fehlbetrag zum Mindestbestand.
  knapp.sort((a, b) => (a.menge - a.mindestbestand) - (b.menge - b.mindestbestand));
  const daten = { artikel: knapp, geprueft, unvollstaendig, stand: new Date().toISOString() };
  nachbestellCache = { zeit: Date.now(), daten };
  return daten;
}

async function detailsNachladen(artikel) {
  const out = [];
  for (let i = 0; i < artikel.length; i += 10) {
    const buendel = artikel.slice(i, i + 10);
    out.push(...await Promise.all(buendel.map(a => holen(a.id).catch(() => null))));
  }
  return out;
}

// --- Artikel einer Marke (Tag) --------------------------------------------
// Die Schule unterscheidet Bauteile von Schuldemonstratoren. Getragen wird der
// Unterschied von einem Homebox-Tag (Voreinstellung „Demonstrator") — bewusst
// kein eigenes Feld: Tags sind auch in Homebox' eigener Oberfläche sichtbar und
// lassen sich dort bequem an vorhandene Artikel vergeben.
//
// FALLE, dieselbe wie beim Feldfilter: ein Filterparameter, den der Server
// nicht kennt, wird schlicht IGNORIERT — die Antwort sähe dann aus wie „alles
// passt", und jedes Kleinteil gälte als Demonstrator. Deshalb wird das Ergebnis
// des Serverfilters überprüft: trägt auch nur ein Treffer die Marke nicht, war
// der Filter wirkungslos, und es wird selbst gefiltert.
const MARKE_TTL_MS = 60 * 1000;
let markeCache = new Map();

function markeCacheVerwerfen() { markeCache = new Map(); }

function hatMarke(artikel, name) {
  const n = String(name || '').trim().toLowerCase();
  return (artikel.marken || []).some(m => String(m.name || '').trim().toLowerCase() === n);
}

async function nachMarke(markeName) {
  const name = String(markeName || '').trim();
  if (!name) return { artikel: [], geprueft: 0, unvollstaendig: false, markeGefunden: false };

  const gemerkt = markeCache.get(name.toLowerCase());
  if (gemerkt && Date.now() - gemerkt.zeit < MARKE_TTL_MS) return gemerkt.daten;

  const stil = await stilErmitteln();
  const alleMarken = await marken().catch(() => []);
  const marke = alleMarken.find(m => String(m.name || '').trim().toLowerCase() === name.toLowerCase());

  // Gibt es die Marke gar nicht, ist die Antwort „keine Demonstratoren" —
  // und die Oberfläche kann erklären, dass der Tag erst vergeben werden muss.
  if (!marke) {
    const daten = { artikel: [], geprueft: 0, unvollstaendig: false, markeGefunden: false };
    markeCache.set(name.toLowerCase(), { zeit: Date.now(), daten });
    return daten;
  }

  // 1. Serverfilter versuchen — und das Ergebnis nachprüfen.
  try {
    const params = stil === 'entities'
      ? { tagIds: marke.id, pageSize: 200 }
      : { labels: marke.id, pageSize: 200 };
    const { eintraege } = listeAus(await api(artikelPfad(stil), { params }));
    const artikel = eintraege.map(normArtikel);
    if (artikel.length && artikel.every(a => hatMarke(a, name))) {
      const daten = { artikel, geprueft: artikel.length, unvollstaendig: false, markeGefunden: true };
      markeCache.set(name.toLowerCase(), { zeit: Date.now(), daten });
      return daten;
    }
  } catch (_) { /* alte Version kennt den Parameter nicht — unten weiter */ }

  // 2. Selbst filtern.
  const daten = await durchgangNachMarke(name);
  markeCache.set(name.toLowerCase(), { zeit: Date.now(), daten });
  return daten;
}

async function durchgangNachMarke(name) {
  const stil = await stilErmitteln();
  const listenPfad = artikelPfad(stil);
  const proSeite = 100;
  const treffer = [];
  let geprueft = 0;
  let unvollstaendig = false;

  for (let seite = 1; seite <= Math.ceil(MAX_DURCHGANG / proSeite); seite++) {
    const { eintraege, gesamt } = listeAus(await api(listenPfad, { params: { page: seite, pageSize: proSeite } }));
    if (!eintraege.length) break;
    const artikel = eintraege.map(normArtikel);

    // Tragen die Kurzfassungen keine Marken, müssen die Details her — sonst
    // fände man nie einen Demonstrator.
    const ohneMarken = artikel.every(a => !a.marken.length);
    const geprueftePosten = ohneMarken ? await detailsNachladen(artikel) : artikel;
    for (const a of geprueftePosten) if (a && hatMarke(a, name)) treffer.push(a);

    geprueft += eintraege.length;
    if (eintraege.length < proSeite || (gesamt && geprueft >= gesamt)) break;
    if (geprueft >= MAX_DURCHGANG) { unvollstaendig = true; break; }
  }
  treffer.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  return { artikel: treffer, geprueft, unvollstaendig, markeGefunden: true };
}

// --- Marke anlegen / sicherstellen ----------------------------------------
// Damit sich ein Demonstrator aus der Weboberfläche anlegen lässt, muss der
// Tag notfalls entstehen. Vorhandene Schreibweise gewinnt: gibt es „Demonstrator"
// schon, wird nicht „demonstrator" danebengelegt.
async function markeSicherstellen(name) {
  const wunsch = String(name || '').trim();
  if (!wunsch) throw new HomeboxError('Es fehlt der Name der Marke.', 400);

  const vorhanden = (await marken().catch(() => []))
    .find(m => String(m.name || '').trim().toLowerCase() === wunsch.toLowerCase());
  if (vorhanden) return vorhanden;

  const stil = await stilErmitteln();
  const pfad = stil === 'entities' ? '/api/v1/tags' : '/api/v1/labels';
  const angelegt = await api(pfad, { method: 'POST', body: { name: wunsch, description: '' } });
  if (!angelegt || !angelegt.id) throw new HomeboxError('Homebox hat keine ID für die neue Marke geliefert.', 502);
  markeCacheVerwerfen();
  return { id: angelegt.id, name: angelegt.name || wunsch };
}

// --- Lagerort anlegen -----------------------------------------------------
// Lagerorte werden bisher in Homebox gepflegt. Für den Alltag ist das ein
// Bruch: wer vor einem neuen Schrank steht, will ihn dort anlegen, wo er
// gerade arbeitet.
// FALLE, real aufgetreten (2026-09-08): Ein POST auf /v1/entities mit
// `isLocation: true` wurde ANGENOMMEN — aber das Feld ignoriert. Homebox legte
// einen ganz normalen Artikel an. Für den Nutzer sah das aus wie „nichts
// passiert": kein Fehler, und unter den Lagerorten stand nichts. In Wahrheit
// lag ein Artikel namens „Schrank 4" im Bestand.
//
// Lehre daraus, dieselbe wie beim Feld- und Tag-Filter: Ein Feld, das der
// Server nicht kennt, wird stillschweigend verworfen. Deshalb wird hier NICHT
// geglaubt, was der POST antwortet — es wird nachgesehen, ob der Ort wirklich
// als Lagerort existiert. Und was fälschlich als Artikel entstand, wird wieder
// entfernt, statt als Müll liegen zu bleiben.
async function ortAnlegen({ name, elternId, beschreibung }) {
  const bezeichnung = String(name || '').trim();
  if (!bezeichnung) throw new HomeboxError('Es fehlt die Bezeichnung.', 400);

  const stil = await stilErmitteln();
  const rumpf = { name: bezeichnung, description: beschreibung || '' };

  // Der klassische Endpunkt zuerst: den kennen auch die meisten neueren
  // Versionen noch, und er ist eindeutig. Die Entity-Varianten sind Vermutungen
  // über die verschmolzene API und stehen deshalb dahinter.
  const varianten = [
    { was: 'POST /v1/locations', pfad: '/api/v1/locations', body: { ...rumpf, parentId: elternId || undefined } },
    { was: 'POST /v1/entities (type=location)', pfad: '/api/v1/entities', body: { ...rumpf, type: 'location', parentId: elternId || undefined } },
    { was: 'POST /v1/entities (isLocation)', pfad: '/api/v1/entities', body: { ...rumpf, isLocation: true, parentId: elternId || undefined } },
  ];
  if (stil === 'items') varianten.length = 1;   // alte API hat nur den einen Weg

  const versucht = [];
  for (const v of varianten) {
    let angelegt = null;
    try {
      angelegt = await api(v.pfad, { method: 'POST', body: v.body });
    } catch (e) {
      versucht.push(`${v.was} → ${e.message}`);
      continue;
    }
    if (!angelegt || !angelegt.id) {
      versucht.push(`${v.was} → Antwort ohne ID`);
      continue;
    }

    // Nachsehen statt glauben.
    const treffer = (await orte().catch(() => [])).find(o => o.id === angelegt.id);
    if (treffer) {
      cacheVerwerfen();
      return treffer;
    }

    // Angelegt, aber kein Lagerort — also ein Artikel. Wieder wegräumen,
    // sonst sammelt sich im Bestand Müll an, den niemand zuordnen kann.
    versucht.push(`${v.was} → angenommen, aber kein Lagerort daraus geworden`);
    await artikelLoeschen(angelegt.id).catch(() => {});
  }

  throw new HomeboxError(
    'Homebox hat den Lagerort nicht angelegt. Versucht wurde: ' + versucht.join(' | ')
    + '. Bitte den Lagerort vorerst in Homebox selbst anlegen — und diese Meldung weitergeben.',
    502,
  );
}

// Nur für den Aufräumfall oben. Bewusst nicht exportiert: Artikel löscht diese
// App sonst nirgends, das gehört in Homebox.
async function artikelLoeschen(id) {
  const stil = await stilErmitteln();
  await api(artikelPfad(stil, id), { method: 'DELETE' });
}

// --- Hersteller-Vorschläge ------------------------------------------------
// Beim Anlegen soll man den Hersteller nicht jedes Mal neu tippen. Homebox
// kennt keine Liste der benutzten Hersteller — also einmal durch den Bestand
// und zusammenzählen. Wie die Nachbestell-Liste eine teure Abfrage, deshalb
// derselbe Merker.
async function hersteller() {
  if (herstellerCache && Date.now() - herstellerCache.zeit < NACHBESTELL_TTL_MS) {
    return herstellerCache.daten;
  }
  const stil = await stilErmitteln();
  const listenPfad = artikelPfad(stil);
  const proSeite = 100;
  const zaehler = new Map();
  let geprueft = 0;

  for (let seite = 1; seite <= Math.ceil(MAX_DURCHGANG / proSeite); seite++) {
    const { eintraege, gesamt } = listeAus(await api(listenPfad, { params: { page: seite, pageSize: proSeite } }));
    if (!eintraege.length) break;
    for (const roh of eintraege) {
      const h = String(roh.manufacturer || '').trim();
      if (!h) continue;
      // Nach Kleinschreibung zusammenfassen, aber die erste gesehene
      // Schreibweise anzeigen — „Festo" und „festo" sind derselbe Hersteller.
      const key = h.toLowerCase();
      const e = zaehler.get(key);
      if (e) e.anzahl += 1; else zaehler.set(key, { name: h, anzahl: 1 });
    }
    geprueft += eintraege.length;
    if (eintraege.length < proSeite || (gesamt && geprueft >= gesamt)) break;
    if (geprueft >= MAX_DURCHGANG) break;
  }

  const daten = [...zaehler.values()].sort((a, b) => b.anzahl - a.anzahl || a.name.localeCompare(b.name, 'de'));
  herstellerCache = { zeit: Date.now(), daten };
  return daten;
}

// --- Anhänge --------------------------------------------------------------
// Fotos und Datenblätter gehören an den Artikel in Homebox, nicht in unsere
// Datenbank: sonst hätte man zwei Orte, an denen Bilder liegen können.
//
// Der Upload ist multipart, geht also NICHT über den JSON-Weg `api()`.
async function anhangHochladen(id, { daten, dateiname, mimetype, typ = 'photo' }) {
  const stil = await stilErmitteln();
  const t = await tokenHolen();
  const form = new FormData();
  form.append('file', new Blob([daten], { type: mimetype || 'application/octet-stream' }), dateiname || 'foto.jpg');
  form.append('type', typ);
  form.append('name', dateiname || 'foto.jpg');

  let res;
  try {
    res = await fetch(`${cfg.url}${artikelPfad(stil, id)}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: t,
        Accept: 'application/json',
        // KEIN Content-Type setzen — fetch muss die multipart-Grenze selbst
        // eintragen, sonst kann der Server die Teile nicht trennen.
        ...(cfg.groupId ? { 'X-Tenant': cfg.groupId } : {}),
      },
      body: form,
    });
  } catch (e) {
    throw new HomeboxError(`Homebox nicht erreichbar: ${e.message}`, 502);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HomeboxError(`Anhang abgelehnt (Homebox ${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  cacheVerwerfen();
  return res.json().catch(() => ({ ok: true }));
}

async function health() {
  await stilErmitteln();
  // Den Namen der aktiven Sammlung mitgeben — bei mehreren Beständen ist das
  // die wichtigste Rückmeldung: arbeite ich gerade im richtigen?
  let aktiv = cfg.groupName || '';
  let mehrere = false;
  try {
    const liste = await sammlungen();
    mehrere = liste.length > 1;
    if (cfg.groupId) {
      const g = liste.find(x => x.id === cfg.groupId);
      if (g) aktiv = g.name;
    } else {
      // Ohne eigene Wahl greift die Standard-Sammlung des Kontos. Welche das
      // ist, steht am Nutzer — die Reihenfolge der Liste sagt es NICHT.
      const self = await api('/api/v1/users/self', { ohneSammlung: true }).catch(() => null);
      const std = self && (self.item || self).defaultGroupId;
      const g = std ? liste.find(x => x.id === std) : null;
      aktiv = g ? `${g.name} (Standard)` : 'Standard-Sammlung des Kontos';
    }
  } catch (_) { /* ältere Versionen ohne Sammlungen */ }
  return { ok: true, url: cfg.url, apiStil, sammlung: aktiv, mehrereSammlungen: mehrere };
}

module.exports = {
  HomeboxError,
  FELD_BARCODE, FELD_CODE, FELD_MINDEST,
  isConfigured, publicConfig, setConfig,
  sammlungen, health,
  suchen, holen, beiBarcode, beiCode, beiFeld,
  orte, ortHolen, marken,
  anlegen, aktualisieren, bestandAendern,
  nachbestellung, anhangHochladen, nachMarke,
  markeSicherstellen, ortAnlegen, hersteller,
  // für Tests
  _normArtikel: normArtikel,
  _normOrt: normOrt,
};
