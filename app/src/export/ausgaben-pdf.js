(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.export = SL.export || {};

  // Materialausgaben als PDF, nach Gruppen getrennt.
  //
  // Aufbau (so entschieden): eine Seite je Gruppe, innerhalb der Gruppe die
  // Artikel zusammengefasst, dazu die Einzelbuchungen und die Materialkosten
  // der Gruppe.
  //
  // Zu den Kosten: gerechnet wird mit dem Preis, der ZUM ZEITPUNKT DER AUSGABE
  // am Artikel stand und im Eintrag mitgeschrieben wurde. Den heutigen Preis
  // heranzuziehen wäre falsch — eine Abrechnung vom Mai darf sich nicht
  // ändern, weil im Oktober neu eingekauft wurde. Bei Altbuchungen ohne
  // Preisangabe wird das offen ausgewiesen statt stillschweigend mit 0 zu
  // rechnen.

  function bauen(ausgaben, { von, bis } = {}) {
    const ctx = SL.export.pdfBasis.neuesDokument();

    const zeitraum = (von || bis)
      ? `Zeitraum ${von ? SL.ui.formatDatum(von) : 'Anfang'} bis ${bis ? SL.ui.formatDatum(bis) : 'heute'}`
      : 'Gesamter Zeitraum';
    SL.export.pdfBasis.kopfzeile(ctx, 'Materialausgaben', zeitraum);

    if (!ausgaben.length) {
      ctx.text('In diesem Zeitraum wurde nichts ausgegeben.', { size: 11 });
      SL.export.pdfBasis.ausgeben(ctx, 'materialausgaben.pdf');
      return ctx;
    }

    // Nach Gruppe bündeln. Buchungen ohne Klasse gehören zusammen ans Ende —
    // sie verschwinden zu lassen wäre schlimmer, als sie unbenannt zu zeigen.
    const gruppen = new Map();
    for (const a of ausgaben) {
      const key = (a.klasse || '').trim() || '(ohne Gruppe)';
      if (!gruppen.has(key)) gruppen.set(key, []);
      gruppen.get(key).push(a);
    }
    const namen = [...gruppen.keys()].sort((a, b) => {
      if (a === '(ohne Gruppe)') return 1;
      if (b === '(ohne Gruppe)') return -1;
      return a.localeCompare(b, 'de');
    });

    let gesamtKosten = 0;
    let gesamtPositionen = 0;
    let erste = true;

    for (const name of namen) {
      // Eine Seite je Gruppe: das Blatt soll sich einzeln weitergeben lassen.
      if (!erste) { ctx.doc.addPage(); ctx.y = 18; }
      erste = false;

      const eintraege = gruppen.get(name);
      ctx.ueberschrift(name, 14);
      ctx.text(`${eintraege.length} ${eintraege.length === 1 ? 'Buchung' : 'Buchungen'}`, { size: 9, farbe: [110, 110, 110] });
      ctx.abstand(2);

      // Summen je Artikel
      const proArtikel = new Map();
      for (const a of eintraege) {
        const k = a.artikelId || a.artikelName;
        const e = proArtikel.get(k) || { name: a.artikelName || '(Artikel)', menge: 0, kosten: 0, ohnePreis: 0 };
        e.menge += Number(a.menge) || 0;
        if (a.preis != null && a.preis !== '') e.kosten += (Number(a.preis) || 0) * (Number(a.menge) || 0);
        else e.ohnePreis += Number(a.menge) || 0;
        proArtikel.set(k, e);
      }

      const summenZeilen = [...proArtikel.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'de'))
        .map(e => [
          e.name,
          String(e.menge),
          e.kosten ? euro(e.kosten) : (e.ohnePreis ? 'kein Preis hinterlegt' : '—'),
        ]);

      ctx.tabelle(['Artikel', 'Menge', 'Materialwert'], summenZeilen, [62, 14, 24], { rechts: [1, 2] });

      const kostenGruppe = [...proArtikel.values()].reduce((s, e) => s + e.kosten, 0);
      const ohnePreis = [...proArtikel.values()].reduce((s, e) => s + e.ohnePreis, 0);
      gesamtKosten += kostenGruppe;
      gesamtPositionen += eintraege.length;

      ctx.abstand(2);
      ctx.text(`Materialwert dieser Gruppe: ${euro(kostenGruppe)}`, { size: 11, stil: 'bold' });
      if (ohnePreis) {
        ctx.text(`Bei ${ohnePreis} Stück ist am Artikel kein Preis hinterlegt — sie fehlen in dieser Summe.`,
          { size: 8.5, farbe: [150, 90, 20] });
      }

      // Einzelbuchungen darunter: die Summe beantwortet „wie viel", die
      // Einzelzeilen beantworten „wann und wofür".
      ctx.abstand(3);
      ctx.ueberschrift('Einzelbuchungen', 11);
      const einzel = eintraege
        .slice()
        .sort((a, b) => String(a.ausgeliehenAm).localeCompare(String(b.ausgeliehenAm)))
        .map(a => [
          SL.ui.formatDatum(String(a.ausgeliehenAm).slice(0, 10)),
          a.artikelName || '(Artikel)',
          String(a.menge),
          a.notiz || '',
          a.benutzerName || '',
        ]);
      ctx.tabelle(['Datum', 'Artikel', 'Menge', 'Zweck', 'Gebucht von'], einzel, [14, 30, 9, 27, 20], { rechts: [2] });
    }

    // Gesamtsumme auf einer eigenen Seite: sonst hängt sie unter der letzten
    // Gruppe und sieht aus, als gehörte sie zu ihr.
    ctx.doc.addPage();
    ctx.y = 18;
    ctx.ueberschrift('Zusammenfassung', 14);
    ctx.merkmale([
      ['Gruppen', String(namen.length)],
      ['Buchungen', String(gesamtPositionen)],
      ['Zeitraum', zeitraum],
      ['Materialwert gesamt', euro(gesamtKosten)],
    ], 2);

    ctx.abstand(4);
    const je = [...gruppen.entries()].map(([name, eintraege]) => {
      const summe = eintraege.reduce((s, a) => s
        + ((a.preis != null && a.preis !== '') ? (Number(a.preis) || 0) * (Number(a.menge) || 0) : 0), 0);
      return [name, String(eintraege.length), euro(summe)];
    }).sort((a, b) => a[0].localeCompare(b[0], 'de'));
    ctx.tabelle(['Gruppe', 'Buchungen', 'Materialwert'], je, [50, 20, 30], { rechts: [1, 2] });

    SL.export.pdfBasis.ausgeben(ctx, dateiname(von, bis));
    return ctx;
  }

  function euro(betrag) {
    return Number(betrag || 0).toLocaleString('de-DE', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }) + ' €';
  }

  function dateiname(von, bis) {
    const teil = (von || bis) ? `-${von || 'anfang'}_bis_${bis || 'heute'}` : '';
    return `materialausgaben${teil}.pdf`;
  }

  SL.export.ausgabenPdf = { bauen };
})();
