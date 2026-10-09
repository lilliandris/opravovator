const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const AdmZip = require('adm-zip');
(async () => {
  const zip = new AdmZip();
  const root = '4. In mari usque in aeternum 5b';
  const people = [['9','vladimir-lukac','1201',0],['Kva','timo-valky','1202',90],['8','kristina-dzobova','1203',0],['Ter','zuzana-petho','1204',0]];
  for (const [r, n, id, rot] of people) {
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const p = doc.addPage([595, 842]);
      if (rot) p.setRotation(degrees(rot));
      for (let y = 0; y < 842; y += 100) p.drawText('y=' + y + ' ' + n + ' str ' + (i+1), { x: 20, y: 842 - y - 12, size: 12, font: f });
      p.drawRectangle({ x: 100, y: 842 - 300, width: 200, height: 100, borderColor: rgb(0,0,1), borderWidth: 1 });
    }
    const dir = `${root}/${r}-${n}-${id}/`;
    zip.addFile(dir + n + '.pdf', Buffer.from(await doc.save()));
    if (n !== 'timo-valky') zip.addFile(dir + 'body.txt', Buffer.from(''));
  }
  zip.writeZip(process.argv[2] || '/tmp/test.zip');
  console.log('ok');
})();
