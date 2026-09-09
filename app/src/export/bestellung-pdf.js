(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.export = SL.export || {};

  // Bestellanforderung — das Blatt für die Schulverwaltung.
  //
  // Bewusst ein freies Formular und kein nachgebauter Vordruck (so mit
  // Matthias entschieden): es geht um die saubere Aufstellung, nicht um ein
  // amtliches Muster. Sollte die Schule später einen Vordruck verlangen, wird
  // er hier nachgebaut wie das VG-Formular der Gemeindeverwaltung.
  //
  // Gedruckt wird der BESTELLTE Stand, nicht der gelieferte: das Blatt ist die
  // Anforderung, nicht der Nachweis. Was schon geliefert wurde, steht in der
  // App — und wäre auf einer Bestellung nur verwirrend.
  function bauen(b) {
    const ctx = SL.export.pdfBasis.neuesDokument();
    const positionen = b.positionen || [];

    SL.export.pdfBasis.kopfzeile(ctx, 'Bestellanforderung', b.lieferant || '');

    ctx.merkmale([
      ['Lieferant', b.lieferant || '—'],
      ['Bestelldatum', SL.ui.formatDatum(String(b.bestelltAm || '').slice(0, 10))],
      ['Bestellnummer', b.belegnummer || '—'],
      ['Angelegt von', b.angelegtVon || ''],
    ], 2);
    ctx.abstand(3);

    ctx.ueberschrift('Positionen', 13);
    if (!positionen.length) {
      ctx.text('Keine Positionen erfasst.', { size: 10 });
    } else {
      const zeilen = positionen.map((p, i) => [
        String(i + 1),
        p.artikelName || '(ohne Bezeichnung)',
        p.bestellnummer || '',
        String(p.menge),
        p.preis != null ? SL.ui.formatZahl(p.preis, 2) + ' €' : '',
        p.preis != null ? SL.ui.formatZahl(p.preis * p.menge, 2) + ' €' : '',
      ]);
      ctx.tabelle(['Pos.', 'Bezeichnung', 'Bestell-Nr.', 'Menge', 'Einzelpreis', 'Gesamt'],
        zeilen, [7, 39, 18, 10, 13, 13]);

      // Summe nur, wenn überhaupt Preise da sind. Eine Null wäre eine Aussage,
      // die niemand geprüft hat — Positionen ohne Preis werden benannt.
      const mitPreis = positionen.filter(p => p.preis != null);
      const summe = mitPreis.reduce((s, p) => s + p.preis * p.menge, 0);
      ctx.abstand(2);
      if (mitPreis.length) {
        ctx.text(`Summe: ${SL.ui.formatZahl(summe, 2)} €`, { size: 11, stil: 'bold' });
        if (mitPreis.length < positionen.length) {
          ctx.text(`${positionen.length - mitPreis.length} Position(en) ohne Preis — in der Summe nicht enthalten.`,
            { size: 9, farbe: [150, 90, 30] });
        }
      } else {
        ctx.text('Für keine Position ist ein Preis hinterlegt.', { size: 9, farbe: [110, 110, 110] });
      }
    }

    if (b.notiz) {
      ctx.abstand(3);
      ctx.ueberschrift('Bemerkung', 12);
      ctx.text(b.notiz, { size: 10 });
    }

    // Unterschriftszeilen wie im Inventurprotokoll — das Blatt geht aus der
    // Hand und braucht eine Stelle, an der jemand unterschreibt.
    ctx.abstand(8);
    ctx.platz(24);
    ctx.doc.setDrawColor(150);
    ctx.doc.line(ctx.links, ctx.y + 10, ctx.links + 60, ctx.y + 10);
    ctx.doc.line(ctx.rechts - 60, ctx.y + 10, ctx.rechts, ctx.y + 10);
    ctx.doc.setFontSize(8.5);
    ctx.doc.setTextColor(110, 110, 110);
    ctx.doc.text('Datum, Unterschrift Antragsteller', ctx.links, ctx.y + 14);
    ctx.doc.text('Datum, Unterschrift Schulleitung', ctx.rechts, ctx.y + 14, { align: 'right' });

    SL.export.pdfBasis.ausgeben(ctx, dateiname(b));
    return ctx;
  }

  function dateiname(b) {
    const l = String(b.lieferant || 'bestellung').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `bestellung-${l || 'ohne-lieferant'}-${String(b.bestelltAm || '').slice(0, 10)}.pdf`;
  }

  SL.export.bestellungPdf = bauen;
})();
