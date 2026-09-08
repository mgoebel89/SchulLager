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
      // Klassen/Gruppen für die Ausleihe (Phase 4). Frei pflegbar, weil sich
      // die Klassenbezeichnungen jedes Schuljahr ändern.
      klassen: [],
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
    return out;
  }

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

  SL.models = {
    ROLLEN, ROLLE_LABEL,
    defaultSettings, mergeSettingsDefaults,
    ortBaum, ortPfad,
  };
})();
