(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.views = SL.views || {};

  const { el, karte, toast } = SL.ui;

  // Der Scan-Einstieg. Er tut selbst wenig: Kamera auf, gelesene Zeichenkette
  // deuten, an die richtige Stelle springen. Die Deutung steckt in
  // SL.models.codeArt, damit Scanner, Suchfeld und Handeingabe dieselbe
  // Vorstellung davon haben, was ein Code ist.

  function renderScannen(mount) {
    mount.appendChild(el('div', { class: 'toolbar' }, [el('h1', {}, 'Scannen')]));

    const bereit = SL.ui.scannerBereit();
    const inhalt = [];

    if (!bereit) {
      // Der häufigste Grund ist HTTP statt HTTPS — das gehört benannt, sonst
      // sucht man den Fehler am Handy statt an der Adresse.
      inhalt.push(el('p', { class: 'anmeldung-fehler' }, window.isSecureContext
        ? 'Dieses Gerät stellt keine Kamera bereit.'
        : 'Die Kamera arbeitet im Browser nur über HTTPS. Bitte die Adresse mit https:// aufrufen.'));
    }

    inhalt.push(el('p', { class: 'muted' },
      'Barcode einer Baukomponente oder QR-Etikett eines Geräts vor die Kamera halten. '
      + 'Der Artikel wird direkt geöffnet.'));

    inhalt.push(el('div', { class: 'btn-reihe' }, [
      bereit
        ? el('button', { class: 'btn btn-primary', type: 'button', onclick: () => scanStarten() }, '⌷ Kamera öffnen')
        : null,
      el('button', { class: 'btn', type: 'button', onclick: () => SL.ui.codeEintippen(codeAufloesen) }, '⌨ Code eintippen'),
    ]));

    mount.appendChild(karte(null, inhalt));

    mount.appendChild(karte('Was sich scannen lässt', el('dl', { class: 'daten' }, [
      zeile('Handelsbarcode', 'EAN, UPC, Code 128 — führt zum Artikel, wenn der Code in Homebox hinterlegt ist.'),
      zeile('Eigenes QR-Etikett', 'Öffnet Artikel (A-…) oder Lagerort (O-…) unmittelbar.'),
      zeile('Homebox-Etikett', 'Von Homebox selbst gedruckte Etiketten werden ebenfalls erkannt.'),
    ])));
  }

  function zeile(label, text) {
    return el('div', { class: 'daten-zeile' }, [el('dt', {}, label), el('dd', {}, text)]);
  }

  // Von überall aufrufbar (Knopf in der Artikelsuche, Menüpunkt, später die
  // Buchungsansichten).
  function scanStarten() {
    SL.ui.scannen(codeAufloesen);
  }

  async function codeAufloesen(text) {
    const { art, wert } = SL.models.codeArt(text);
    if (art === 'leer') return;

    try {
      if (art === 'homeboxId') {
        location.hash = `#/artikel?id=${encodeURIComponent(wert)}`;
        return;
      }
      if (art === 'artikel') {
        const a = await SL.api.lagerBeiCode(wert);
        location.hash = `#/artikel?id=${encodeURIComponent(a.id)}`;
        return;
      }
      if (art === 'ort') {
        const orte = await SL.store.orteLaden();
        const o = orte.find(x => String(x.code || '').toUpperCase() === wert);
        if (!o) { nichtGefunden(wert, 'Kein Lagerort mit dieser Kennung.'); return; }
        location.hash = `#/orte?id=${encodeURIComponent(o.id)}`;
        return;
      }
      // barcode
      const a = await SL.api.lagerBeiBarcode(wert);
      location.hash = `#/artikel?id=${encodeURIComponent(a.id)}`;
    } catch (e) {
      if (e && e.status === 404) {
        nichtGefunden(wert, art === 'barcode'
          ? 'Zu diesem Barcode ist kein Artikel hinterlegt.'
          : 'Zu dieser Kennung ist kein Artikel hinterlegt.');
        return;
      }
      toast((e && e.message) || 'Der Code konnte nicht nachgeschlagen werden.', 4000);
    }
  }

  // Ein unbekannter Code ist der Normalfall bei Neuware — deshalb kein
  // Fehlerton, sondern ein Angebot: nachsehen oder (ab Phase 2) neu anlegen.
  function nichtGefunden(code, text) {
    const m = SL.ui.modal('Nicht gefunden', el('div', {}, [
      el('p', {}, text),
      el('p', { class: 'muted' }, ['Gelesen: ', el('span', { class: 'lager-barcode' }, code)]),
      SL.store.darfBuchen()
        ? el('p', { class: 'muted' }, 'Das Anlegen neuer Artikel per Scan kommt in der nächsten Ausbaustufe.')
        : el('p', { class: 'muted' }, 'Zum Anlegen bitte anmelden.'),
    ]), {
      fuss: [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Schließen'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: () => { m.close(); location.hash = `#/artikel?q=${encodeURIComponent(code)}`; },
        }, 'Danach suchen'),
      ],
    });
  }

  SL.views.renderScannen = renderScannen;
  SL.views.scanStarten = scanStarten;
  SL.views.codeAufloesen = codeAufloesen;
})();
