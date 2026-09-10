(function () {
  'use strict';
  window.SL = window.SL || {};
  SL.export = SL.export || {};

  // Gemeinsame Bausteine für alle PDFs der App. Aus der ImkereiApp übernommen.
  //
  // jsPDF liegt als eine vendored Datei in vendor/ — der Container hat kein
  // Internet und soll auch keins brauchen. Zugriff über window.jspdf.jsPDF.
  //
  // FALLE beim Testen: jsPDF legt seine Methoden (text, addPage, …) als EIGENE
  // Eigenschaften der Instanz an — nicht am Prototyp und nicht unter jsPDF.API.
  // Wer die Ausgabe mitschneiden will, muss `neuesDokument` umhüllen.

  const MM = { links: 15, rechts: 15, oben: 18, unten: 15 };

  function jsPDF() {
    const ns = window.jspdf || window.jsPDF;
    const ctor = (ns && ns.jsPDF) || window.jsPDF;
    if (!ctor) throw new Error('jsPDF nicht geladen (vendor/jspdf.inline.js fehlt?).');
    return ctor;
  }

  // Ein Dokument mit Cursor: `y` wandert nach unten, `seitenumbruch` sorgt für
  // neue Seiten. Alle Bauer arbeiten damit, statt Koordinaten zu rechnen.
  function neuesDokument(opts = {}) {
    const Ctor = jsPDF();
    const doc = new Ctor({ orientation: opts.quer ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const breite = doc.internal.pageSize.getWidth();
    const hoehe = doc.internal.pageSize.getHeight();

    const ctx = {
      doc,
      breite, hoehe,
      links: MM.links,
      rechts: breite - MM.rechts,
      nutzbreite: breite - MM.links - MM.rechts,
      y: MM.oben,

      // Reicht der Platz noch? Sonst neue Seite beginnen.
      platz(mm) {
        if (this.y + mm > hoehe - MM.unten) {
          doc.addPage();
          this.y = MM.oben;
          if (opts.kopfWiederholen) opts.kopfWiederholen(this);
          return true;
        }
        return false;
      },

      abstand(mm) { this.y += mm; },

      text(txt, opt = {}) {
        const size = opt.size || 10;
        const stil = opt.stil || 'normal';
        doc.setFont('helvetica', stil);
        doc.setFontSize(size);
        if (opt.farbe) doc.setTextColor(...opt.farbe); else doc.setTextColor(20, 20, 20);
        const zeilenHoehe = size * 0.42 + 1.2;
        const maxBreite = opt.breite || this.nutzbreite;
        const zeilen = doc.splitTextToSize(String(txt ?? ''), maxBreite);
        for (const z of zeilen) {
          this.platz(zeilenHoehe + 1);
          const x = opt.x !== undefined ? opt.x : this.links;
          doc.text(z, opt.zentriert ? this.breite / 2 : x, this.y, opt.zentriert ? { align: 'center' } : undefined);
          this.y += zeilenHoehe;
        }
        return this;
      },

      ueberschrift(txt, size = 13) {
        this.platz(size * 0.5 + 6);
        this.abstand(2);
        this.text(txt, { size, stil: 'bold' });
        this.abstand(1);
        return this;
      },

      trennlinie(opt = {}) {
        this.platz(4);
        doc.setDrawColor(opt.hell ? 210 : 150);
        doc.setLineWidth(0.2);
        doc.line(this.links, this.y, this.rechts, this.y);
        this.y += 3;
        return this;
      },

      // Zweispaltige Merkmalliste („Label: Wert"), wie sie auf Stockkarten
      // üblich ist. Bricht bei Bedarf auf die nächste Seite um.
      merkmale(paare, spalten = 2) {
        const gueltig = paare.filter(p => p && p[1] !== null && p[1] !== undefined && p[1] !== '');
        if (!gueltig.length) return this;
        const spaltenBreite = this.nutzbreite / spalten;
        let i = 0;
        while (i < gueltig.length) {
          this.platz(6);
          const zeilenY = this.y;
          for (let s = 0; s < spalten && i < gueltig.length; s++, i++) {
            const [label, wert] = gueltig[i];
            const x = this.links + s * spaltenBreite;
            doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
            doc.setTextColor(90, 90, 90);
            doc.text(String(label) + ':', x, zeilenY);
            const labelBreite = doc.getTextWidth(String(label) + ': ');
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(20, 20, 20);
            const rest = doc.splitTextToSize(String(wert), spaltenBreite - labelBreite - 3);
            doc.text(rest[0] || '', x + labelBreite, zeilenY);
          }
          this.y = zeilenY + 5;
        }
        return this;
      },

      // Schlichte Tabelle mit Kopfzeile; Spaltenbreiten in Prozent.
      //
      // GEOMETRIE (2026-09-10 korrigiert, nachdem die Linien auf der
      // Bestellanforderung sichtbar zur falschen Zeile gehörten):
      // `this.y` ist die OBERKANTE der Zeile, nicht die Schriftlinie. Die
      // Schriftlinie liegt PAD + Versalhöhe darunter, die Trennlinie genau auf
      // der Unterkante. Dadurch hat jede Zeile oben und unten gleich viel Luft
      // und die Linie steht mittig zwischen zwei Zeilen. Vorher wurde sie nach
      // dem Vorschub bei `y - 1,5` gezogen — also 1,5 mm über der FOLGENDEN
      // Schriftlinie und rund 5 mm unter der eigenen.
      //
      // `opt.rechts` nennt die Spalten (Index), die rechtsbündig stehen: Menge,
      // Preise, Beträge. Untereinander lesbare Zahlen sind der ganze Zweck.
      tabelle(kopf, zeilen, breitenProzent, opt = {}) {
        const b = breitenProzent.map(p => this.nutzbreite * p / 100);
        const size = opt.size || 8.5;
        const PAD = 1.6;                 // Luft über und unter dem Text
        const ZA = size * 0.42 + 0.3;    // Abstand mehrzeiliger Zellen
        const VERSAL = size * 0.25;      // Versalhöhe in mm (mm = pt * 0.3528)
        const rechtsSpalten = new Set(opt.rechts || []);
        // Linke Kante jeder Spalte, einmal gerechnet statt in jeder Zeile.
        const kanten = [];
        b.reduce((x, breite) => { kanten.push(x); return x + breite; }, this.links);

        // Setzt eine Zelle an ihrer Kante ab — links- oder rechtsbündig.
        const zelle = (txt, i, y) => {
          if (rechtsSpalten.has(i)) doc.text(txt, kanten[i] + b[i] - 1, y, { align: 'right' });
          else doc.text(txt, kanten[i] + 1, y);
        };

        const zeilenHoehe = (n) => PAD * 2 + VERSAL + (n - 1) * ZA;

        const kopfZeichnen = () => {
          const hoehe = zeilenHoehe(1);
          this.platz(hoehe + 2);
          doc.setFillColor(238, 242, 247);
          doc.rect(this.links, this.y, this.nutzbreite, hoehe, 'F');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(size);
          doc.setTextColor(36, 65, 104);
          const basis = this.y + PAD + VERSAL;
          kopf.forEach((h, i) => zelle(String(h), i, basis));
          this.y += hoehe;
        };
        kopfZeichnen();

        doc.setFont('helvetica', 'normal'); doc.setFontSize(size);
        for (const zeile of zeilen) {
          // Höchste Zelle bestimmt die Zeilenhöhe — sonst überlappt langer Text.
          const teile = zeile.map((z, i) => doc.splitTextToSize(String(z ?? ''), b[i] - 2));
          const hoehe = zeilenHoehe(Math.max(...teile.map(t => t.length), 1));
          if (this.platz(hoehe)) { kopfZeichnen(); doc.setFont('helvetica', 'normal'); doc.setFontSize(size); }
          doc.setTextColor(20, 20, 20);
          const basis = this.y + PAD + VERSAL;
          teile.forEach((t, i) => t.forEach((zz, k) => zelle(zz, i, basis + k * ZA)));
          this.y += hoehe;
          doc.setDrawColor(225);
          doc.line(this.links, this.y, this.rechts, this.y);
        }
        // Die Tabelle endet mit ihrer Schlusslinie — ohne diesen Nachlauf säße
        // die nächste Zeile (typisch: „Summe: …") auf der Linie.
        this.y += 2;
        return this;
      },
    };

    return ctx;
  }

  // Kopfzeile: links Titel/Untertitel, rechts die Schule aus den Einstellungen.
  function kopfzeile(ctx, titel, untertitel) {
    const schule = (SL.store.state.settings && SL.store.state.settings.schule) || '';
    ctx.doc.setFont('helvetica', 'bold');
    ctx.doc.setFontSize(16);
    ctx.doc.setTextColor(44, 82, 130);
    ctx.doc.text(String(titel), ctx.links, ctx.y);

    ctx.doc.setFont('helvetica', 'normal');
    ctx.doc.setFontSize(9);
    ctx.doc.setTextColor(110, 110, 110);
    if (schule) ctx.doc.text(String(schule), ctx.rechts, ctx.y - 4, { align: 'right' });

    ctx.y += 6;
    if (untertitel) {
      ctx.doc.setFontSize(10);
      ctx.doc.setTextColor(80, 80, 80);
      ctx.doc.text(String(untertitel), ctx.links, ctx.y);
      ctx.y += 5;
    }
    ctx.trennlinie();
    ctx.abstand(2);
  }

  // Seitenzahlen erst am Schluss, wenn die Gesamtzahl feststeht.
  function fusszeilen(ctx) {
    const gesamt = ctx.doc.internal.getNumberOfPages();
    for (let i = 1; i <= gesamt; i++) {
      ctx.doc.setPage(i);
      ctx.doc.setFont('helvetica', 'normal');
      ctx.doc.setFontSize(8);
      ctx.doc.setTextColor(140, 140, 140);
      ctx.doc.text(`Seite ${i} von ${gesamt}`, ctx.breite / 2, ctx.hoehe - 8, { align: 'center' });
      ctx.doc.text(`erstellt am ${SL.ui.formatDatum(SL.models.heuteIso())}`, ctx.rechts, ctx.hoehe - 8, { align: 'right' });
    }
  }

  // Öffnet das PDF in einem neuen Tab; klappt das nicht (Popup-Blocker am
  // Handy), fällt es auf einen Download zurück.
  function ausgeben(ctx, dateiname) {
    fusszeilen(ctx);
    const blob = ctx.doc.output('blob');
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      SL.ui.downloadFile(dateiname, blob, 'application/pdf');
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  SL.export.pdfBasis = { neuesDokument, kopfzeile, fusszeilen, ausgeben };
})();
