(function () {
  'use strict';
  window.SL = window.SL || {};

  const ROLLEN = [
    { wert: 'admin', label: 'Administrator', hinweis: 'Darf alles, einschließlich Benutzer und Einrichtung.' },
    { wert: 'lehrkraft', label: 'Lehrkraft', hinweis: 'Darf buchen, ausleihen, anlegen und Etiketten drucken.' },
  ];
  const ROLLE_LABEL = Object.fromEntries(ROLLEN.map(r => [r.wert, r.label]));

  // Voreinstellungen. Sie liegen serverseitig im allgemeinen Einstellungs-Blob
  // (also NICHT bei den Zugangsdaten) und laufen im Backup mit.
  function defaultSettings() {
    return {
      schule: 'David-Roentgen-Schule Neuwied',
      // Kurzkennungen für QR-Etiketten: A-1 für Artikel, O-1 für Lagerorte.
      // Der Zähler wandert beim Vergeben hoch (Phase 3).
      kennung: { artikelNaechste: 1, ortNaechste: 1 },
      // Klassen/Gruppen für Ausleihe und Ausgabe. Frei pflegbar, weil sich die
      // Klassenbezeichnungen jedes Schuljahr ändern.
      klassen: [],
      // Homebox-Tag, an dem Schuldemonstratoren erkannt werden. Bewusst kein
      // eigenes Feld: Tags sind auch in Homebox' Oberfläche sichtbar und lassen
      // sich dort bequem an vorhandene Artikel vergeben.
      demonstratorMarke: 'Demonstrator',
      // Einzelne Netzgeräte (SPS-Boards ohne übergeordneten Demonstrator).
      // Eigener Tag, weil ein nacktes Board kein Demonstrator ist — aber
      // ebenfalls ausleihbar und mit eigenem Raum.
      netzgeraetMarke: 'Netzgerät',
      schemaVersion: 1,
    };
  }

  // Fehlende Zweige ergänzen, ohne Vorhandenes zu überschreiben. Wichtig nach
  // einem Update, das einen neuen Einstellungszweig einführt: sonst läuft eine
  // Ansicht in ein `undefined` und zeigt einen weißen Bildschirm.
  function mergeSettingsDefaults(s) {
    const d = defaultSettings();
    const out = { ...d, ...(s || {}) };
    out.kennung = { ...d.kennung, ...((s && s.kennung) || {}) };
    if (!Array.isArray(out.klassen)) out.klassen = [];
    // Ein leerer Markenname würde jeden Artikel zum Demonstrator machen —
    // dann lieber auf die Voreinstellung zurückfallen.
    if (!String(out.demonstratorMarke || '').trim()) out.demonstratorMarke = d.demonstratorMarke;
    if (!String(out.netzgeraetMarke || '').trim()) out.netzgeraetMarke = d.netzgeraetMarke;
    return out;
  }

  // Ist dieser Artikel ein Schuldemonstrator? Getragen wird das von einem
  // Homebox-Tag; welcher es ist, steht in den Einstellungen.
  //
  // ACHTUNG: Listenantworten von Homebox sind Kurzfassungen und tragen die
  // Marken nicht immer mit. Wer hier `false` bekommt, weiß deshalb nur
  // „nicht erkennbar" — nicht sicher „ist keiner". Für Entscheidungen mit
  // Folgen (Ausleihe anbieten) immer den DETAIL-Datensatz verwenden.
  function istDemonstrator(artikel, markeName) {
    const n = String(markeName || '').trim().toLowerCase();
    if (!n || !artikel) return false;
    return (artikel.marken || []).some(m => String(m.name || '').trim().toLowerCase() === n);
  }

  // Welche Sorte Gerät ist das? '' heißt Verbrauchsmaterial.
  //
  // Beide Geräte-Sorten sind ausleihbar und können Netzangaben tragen; sie
  // unterscheiden sich nur in der Einordnung. Ein SPS-Board ist kein
  // Demonstrator — aber es steht in einem Raum und wird verliehen wie einer.
  function geraeteArt(artikel, settings) {
    const s = settings || {};
    if (istDemonstrator(artikel, s.demonstratorMarke)) return 'demonstrator';
    if (istDemonstrator(artikel, s.netzgeraetMarke)) return 'netzgeraet';
    return '';
  }

  const GERAET_LABEL = { demonstrator: 'Demonstrator', netzgeraet: 'Netzgerät' };

  // Ausleihbar ist, was ein Gerät ist. Verbrauchsmaterial wird ausgegeben.
  function istGeraet(artikel, settings) { return !!geraeteArt(artikel, settings); }

  // Aus der flachen Ortsliste (jeder Eintrag kennt seine elternId) einen Baum
  // bauen. Homebox liefert die Verschachtelung als Bezug, nicht als Struktur.
  //
  // Zwei Fälle, die sonst Orte verschlucken: ein Ort, dessen Eltern nicht in
  // der Liste sind (z. B. weil sie zu einer anderen Sammlung gehören), und ein
  // Ringbezug. Beides landet hier bewusst auf der obersten Ebene, statt
  // unsichtbar zu werden.
  function ortBaum(orte) {
    const nachId = new Map((orte || []).map(o => [o.id, { ...o, kinder: [] }]));
    const wurzeln = [];
    for (const o of nachId.values()) {
      const eltern = o.elternId ? nachId.get(o.elternId) : null;
      if (eltern && eltern.id !== o.id) eltern.kinder.push(o);
      else wurzeln.push(o);
    }
    const sortieren = (liste) => {
      liste.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      for (const k of liste) sortieren(k.kinder);
      return liste;
    };
    return sortieren(wurzeln);
  }

  // Vollständiger Pfad eines Ortes („Raum 214 › Schrank 3 › Fach B").
  // Ohne ihn ist ein Fach namens „B" nicht wiederzufinden.
  function ortPfad(orte, id, trenner = ' › ') {
    const nachId = new Map((orte || []).map(o => [o.id, o]));
    const teile = [];
    let o = nachId.get(id);
    const gesehen = new Set();
    while (o && !gesehen.has(o.id)) {
      gesehen.add(o.id);
      teile.unshift(o.name);
      o = o.elternId ? nachId.get(o.elternId) : null;
    }
    return teile.join(trenner);
  }

  // --- Gescannte Zeichenketten deuten --------------------------------------
  // Aus der Kamera kommt eine nackte Zeichenkette. Was damit gemeint ist,
  // entscheidet sich hier — an EINER Stelle, damit Scanner, Suchfeld und
  // Handeingabe nicht auseinanderlaufen.
  //
  // Vier Sorten kommen im Schullager vor:
  //   artikel     eigenes QR-Etikett  → .../#/a/A-1042  oder  bloß "A-1042"
  //   ort         Etikett am Fach     → .../#/o/O-17    oder  bloß "O-17"
  //   homeboxId   von Homebox selbst gedrucktes Etikett (URL mit UUID)
  //   barcode     alles andere: Handelsware mit EAN/UPC
  const RE_ARTIKEL = /^A-\d+$/i;
  const RE_ORT = /^O-\d+$/i;
  const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function codeArt(text) {
    const t = String(text || '').trim();
    if (!t) return { art: 'leer', wert: '' };

    // Eigenes Etikett als vollständige Adresse. Der Host wird bewusst NICHT
    // geprüft: die Schule erreicht denselben Container mal über die IP, mal
    // über einen Namen — ein Hostvergleich würde eigene Etiketten verwerfen.
    const eigen = t.match(/#\/(a|o)\/([^/?#\s]+)/i);
    if (eigen) {
      return {
        art: eigen[1].toLowerCase() === 'a' ? 'artikel' : 'ort',
        wert: decodeURIComponent(eigen[2]).toUpperCase(),
      };
    }

    if (RE_ARTIKEL.test(t)) return { art: 'artikel', wert: t.toUpperCase() };
    if (RE_ORT.test(t)) return { art: 'ort', wert: t.toUpperCase() };

    // Von Homebox selbst gedruckte Etiketten tragen eine Adresse mit der
    // Artikel-UUID. Die lässt sich direkt aufschlagen — bequem für alles, was
    // schon vor dieser App etikettiert wurde.
    if (/^https?:\/\//i.test(t)) {
      const uuid = t.match(RE_UUID);
      if (uuid) return { art: 'homeboxId', wert: uuid[0] };
    }

    return { art: 'barcode', wert: t };
  }

  // --- Ausleihe -------------------------------------------------------------
  // Eine Ausleihe verändert den Bestand NICHT. Ein Demonstrator, der im
  // Unterricht steht, gehört weiterhin zum Inventar — er ist nur nicht im
  // Schrank. Verbrauchsmaterial wird stattdessen entnommen, und das senkt den
  // Bestand sehr wohl. Zwei Wege, zwei Bedeutungen.

  // Vorschlag fürs Rückgabedatum: zwei Wochen. Lang genug für eine
  // Unterrichtsreihe, kurz genug, dass ein vergessenes Gerät auffällt.
  const LEIHDAUER_TAGE = 14;

  function faelligVorschlag(heute = new Date()) {
    const d = new Date(heute.getTime());
    d.setDate(d.getDate() + LEIHDAUER_TAGE);
    return dateToIso(d);
  }

  // ISO-Datum aus den LOKALEN Komponenten bauen. `toISOString()` rechnet nach
  // UTC um und schiebt damit in unserer Zeitzone jeden Abend auf den Vortag —
  // eine Falle, die in den Schwesterprojekten schon zweimal zugeschlagen hat.
  function dateToIso(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const t = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${t}`;
  }

  function heuteIso() { return dateToIso(new Date()); }

  // Fristampel einer laufenden Ausleihe.
  function leihStatus(a, heute = heuteIso()) {
    if (a.zurueckAm) return { art: 'zurueck', label: 'zurückgegeben', klasse: 'ampel-ok' };
    if (!a.faelligAm) return { art: 'offen', label: 'ohne Frist', klasse: 'ampel-offen' };
    if (a.faelligAm < heute) {
      const tage = tageZwischen(a.faelligAm, heute);
      return { art: 'ueberfaellig', label: `${tage} ${tage === 1 ? 'Tag' : 'Tage'} überfällig`, klasse: 'ampel-faellig' };
    }
    if (a.faelligAm === heute) return { art: 'heute', label: 'heute fällig', klasse: 'ampel-bald' };
    const tage = tageZwischen(heute, a.faelligAm);
    return { art: 'laufend', label: `noch ${tage} ${tage === 1 ? 'Tag' : 'Tage'}`, klasse: 'ampel-ok' };
  }

  // Ganze Tage zwischen zwei ISO-Daten. Über Mitternacht (12 Uhr UTC) rechnen,
  // damit die Sommerzeitumstellung keinen halben Tag verschluckt.
  function tageZwischen(vonIso, bisIso) {
    const [jv, mv, tv] = String(vonIso).split('-').map(Number);
    const [jb, mb, tb] = String(bisIso).split('-').map(Number);
    const von = Date.UTC(jv, mv - 1, tv);
    const bis = Date.UTC(jb, mb - 1, tb);
    return Math.round((bis - von) / 86400000);
  }

  SL.models = {
    ROLLEN, ROLLE_LABEL,
    defaultSettings, mergeSettingsDefaults,
    ortBaum, ortPfad,
    codeArt,
    LEIHDAUER_TAGE, faelligVorschlag, dateToIso, heuteIso, leihStatus, tageZwischen,
    istDemonstrator, geraeteArt, istGeraet, GERAET_LABEL,
  };
})();
