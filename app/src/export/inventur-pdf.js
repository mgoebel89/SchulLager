(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.export = SL.export || {};

  // Inventurprotokoll.
  //
  // Zweck ist der Nachweis: wer hat wann was gezählt, und was wich ab. Die
  // Abweichungen stehen deshalb VORN — sie sind der Grund, warum jemand das
  // Blatt später wieder in die Hand nimmt. Die vollständige Zählliste folgt
  // dahinter, nach Lagerort gruppiert, so wie gezählt wurde.
  function bauen(lauf) {
    const ctx = SL.export.pdfBasis.neuesDokument();
    const positionen = Object.values(lauf.positionen || {});
    const gezaehlt = positionen.filter(p => p.ist != null);
    const abweichungen = gezaehlt.filter(p => p.ist !== p.soll);

    SL.export.pdfBasis.kopfzeile(ctx, 'Inventurprotokoll', lauf.titel);

    ctx.merkmale([
      ['Umfang', lauf.ortName || 'gesamter Bestand'],
      ['Begonnen', `${SL.ui.formatDatum(String(lauf.gestartetAm).slice(0, 10))} durch ${lauf.gestartetVon}`],
      ['Abgeschlossen', lauf.abgeschlossenAm
        ? `${SL.ui.formatDatum(String(lauf.abgeschlossenAm).slice(0, 10))} durch ${lauf.abgeschlossenVon}`
        : 'noch nicht abgeschlossen'],
      ['Gezählte Positionen', String(gezaehlt.length)],
      ['Abweichungen', String(abweichungen.length)],
      ['Bestände übernommen', lauf.uebernommenAm
        ? `${SL.ui.formatDatum(String(lauf.uebernommenAm).slice(0, 10))} durch ${lauf.uebernommenVon}`
        : 'nein'],
    ], 2);
    ctx.abstand(3);

    // --- Abweichungen ---
    ctx.ueberschrift('Abweichungen', 13);
    if (!abweichungen.length) {
      ctx.text('Keine. Alle gezählten Positionen stimmen mit dem verzeichneten Bestand überein.', { size: 10 });
    } else {
      ctx.text('Minus bedeutet: es ist weniger vorhanden als verzeichnet.', { size: 9, farbe: [110, 110, 110] });
      ctx.abstand(1);
      const zeilen = abweichungen
        .slice()
        .sort((a, b) => (a.ist - a.soll) - (b.ist - b.soll))
        .map(p => [
          p.artikelName || '(Artikel)',
          p.ortName || '',
          String(p.soll),
          String(p.ist),
          (p.ist - p.soll > 0 ? '+' : '') + String(p.ist - p.soll),
        ]);
      ctx.tabelle(['Artikel', 'Lagerort', 'Verzeichnet', 'Gezählt', 'Differenz'], zeilen, [34, 26, 13, 13, 14], { rechts: [2, 3, 4] });
    }

    // --- Vollständige Zählliste, nach Lagerort ---
    ctx.doc.addPage();
    ctx.y = 18;
    ctx.ueberschrift('Zählliste', 13);

    if (!gezaehlt.length) {
      ctx.text('Es wurde noch nichts gezählt.', { size: 10 });
      SL.export.pdfBasis.ausgeben(ctx, dateiname(lauf));
      return ctx;
    }

    const nachOrt = new Map();
    for (const p of gezaehlt) {
      const key = p.ortName || '(ohne Lagerort)';
      if (!nachOrt.has(key)) nachOrt.set(key, []);
      nachOrt.get(key).push(p);
    }
    const orte = [...nachOrt.keys()].sort((a, b) => a.localeCompare(b, 'de'));

    for (const ort of orte) {
      const teil = nachOrt.get(ort).sort((a, b) => String(a.artikelName).localeCompare(String(b.artikelName), 'de'));
      ctx.abstand(2);
      ctx.ueberschrift(ort, 11);
      ctx.tabelle(
        ['Artikel', 'Verzeichnet', 'Gezählt', 'Gezählt am', 'Durch'],
        teil.map(p => [
          p.artikelName || '(Artikel)',
          String(p.soll),
          String(p.ist),
          SL.ui.formatDatum(String(p.gezaehltAm).slice(0, 10)),
          p.gezaehltVon || '',
        ]),
        [34, 13, 13, 15, 25],
        { rechts: [1, 2] },
      );
    }

    // Unterschriftszeile: ein Inventurprotokoll wird abgeheftet, und dann will
    // jemand wissen, wer dafür geradesteht.
    ctx.abstand(8);
    ctx.platz(24);
    ctx.doc.setDrawColor(150);
    ctx.doc.line(ctx.links, ctx.y + 10, ctx.links + 60, ctx.y + 10);
    ctx.doc.line(ctx.rechts - 60, ctx.y + 10, ctx.rechts, ctx.y + 10);
    ctx.doc.setFontSize(8.5);
    ctx.doc.setTextColor(110, 110, 110);
    ctx.doc.text('Datum, Unterschrift Zählende', ctx.links, ctx.y + 14);
    ctx.doc.text('Datum, Unterschrift Leitung', ctx.rechts, ctx.y + 14, { align: 'right' });

    SL.export.pdfBasis.ausgeben(ctx, dateiname(lauf));
    return ctx;
  }

  function dateiname(lauf) {
    const t = String(lauf.titel || 'inventur').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${t || 'inventur'}-${String(lauf.gestartetAm).slice(0, 10)}.pdf`;
  }

  SL.export.inventurPdf = { bauen };
})();
