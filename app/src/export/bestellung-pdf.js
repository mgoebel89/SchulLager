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

    const w = SL.models.summen(b, SL.store.state.settings);
    const pflicht = SL.models.angebotspflicht(b, SL.store.state.settings);

    ctx.merkmale([
      ['Lieferant', b.lieferant || '—'],
      ['Bestelldatum', b.bestelltAm ? SL.ui.formatDatum(String(b.bestelltAm).slice(0, 10)) : 'noch nicht beauftragt'],
      ['Bestellnummer', b.belegnummer || '—'],
      ['Angelegt von', b.angelegtVon || ''],
      // Ohne diese Angabe wäre jede Zahl auf dem Blatt mehrdeutig — und die
      // Verwaltung prüft die Angebotspflicht am BRUTTO-Wert.
      ['Preisangaben', w.art === 'brutto' ? `brutto (inkl. ${SL.ui.formatZahl(w.satz, 0)} % MwSt.)` : `netto (zzgl. ${SL.ui.formatZahl(w.satz, 0)} % MwSt.)`],
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
        zeilen, [7, 39, 18, 10, 13, 13], { rechts: [3, 4, 5] });

      // Summe nur, wenn überhaupt Preise da sind. Eine Null wäre eine Aussage,
      // die niemand geprüft hat — Positionen ohne Preis werden benannt.
      const mitPreis = positionen.filter(p => p.preis != null);
      ctx.abstand(2);
      if (mitPreis.length) {
        ctx.text(`Summe: ${SL.ui.formatZahl(w.netto, 2)} € netto · ${SL.ui.formatZahl(w.brutto, 2)} € brutto`,
          { size: 11, stil: 'bold' });
        if (mitPreis.length < positionen.length) {
          ctx.text(`${positionen.length - mitPreis.length} Position(en) ohne Preis — in der Summe nicht enthalten.`,
            { size: 9, farbe: [150, 90, 30] });
        }
      } else {
        ctx.text('Für keine Position ist ein Preis hinterlegt.', { size: 9, farbe: [110, 110, 110] });
      }
    }

    // --- Angebote ---
    // Der eigentliche Zweck dieses Blatts oberhalb der Schwelle: der Nachweis,
    // dass verglichen wurde. Deshalb steht er auf der Bestellanforderung selbst
    // und nicht nur in der App.
    const angebote = b.angebote || [];
    if (pflicht.pflichtig || angebote.length) {
      ctx.abstand(3);
      ctx.ueberschrift('Angebote', 13);
      if (pflicht.pflichtig) {
        ctx.text(`Ab ${SL.ui.formatZahl(pflicht.schwelle, 2)} € brutto sind ${pflicht.noetig} Angebote einzureichen.`,
          { size: 9, farbe: [110, 110, 110] });
      }
      if (!angebote.length) {
        ctx.text('Es liegen keine Angebote vor.', { size: 10, farbe: [170, 90, 30] });
      } else {
        const satz = Number((SL.store.state.settings || {}).mwstSatz) || 0;
        const brutto = (a) => (a.betrag == null ? null
          : (a.preisArt === 'brutto' ? a.betrag : a.betrag * (1 + satz / 100)));
        ctx.tabelle(['Lieferant', 'Angebots-Nr.', 'Datum', 'Betrag brutto', 'Vergabe'],
          angebote.map(a => [
            a.lieferant || '',
            a.nummer || '',
            a.datum ? SL.ui.formatDatum(a.datum) : '',
            brutto(a) != null ? SL.ui.formatZahl(brutto(a), 2) + ' €' : '',
            a.gewaehlt ? 'beauftragt' : '',
          ]), [34, 18, 14, 18, 16], { rechts: [3] });
        if (!pflicht.erfuellt) {
          ctx.abstand(1);
          ctx.text(`Es fehlen noch ${pflicht.fehlend} Angebote.`, { size: 10, stil: 'bold', farbe: [170, 90, 30] });
        }
        if (b.vergabeBegruendung) {
          ctx.abstand(1);
          ctx.text('Begründung der Vergabe: ' + b.vergabeBegruendung, { size: 9.5 });
        }
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
