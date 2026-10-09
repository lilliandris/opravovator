const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');

const DIR = path.join(__dirname, '..', 'public', 'fonts');
const LIST = [
  { id: 'bebas', label: 'Bebas Neue', file: 'BebasNeue-Regular.ttf' },
  { id: 'lato', label: 'Lato', file: 'Lato-Regular.ttf' },
  { id: 'lato-bold', label: 'Lato Bold', file: 'Lato-Bold.ttf' },
  { id: 'ptserif', label: 'PT Serif', file: 'PT_Serif-Web-Regular.ttf' },
  { id: 'patrick', label: 'Patrick Hand', file: 'PatrickHand-Regular.ttf' },
  { id: 'kalam', label: 'Kalam', file: 'Kalam-Regular.ttf' },
  { id: 'caveat', label: 'Caveat Brush', file: 'CaveatBrush-Regular.ttf' },
  { id: 'mono', label: 'IBM Plex Mono', file: 'IBMPlexMono-Regular.ttf' },
];

const FONTS = LIST.map(f => {
  const bytes = fs.readFileSync(path.join(DIR, f.file));
  const fk = fontkit.create(bytes);
  return { ...f, family: 'pdf-' + f.id, ascent: fk.ascent / fk.unitsPerEm, bytes };
});
const byId = Object.fromEntries(FONTS.map(f => [f.id, f]));

module.exports = {
  FONTS,
  get: id => byId[id] || byId.bebas,
  publicList: () => FONTS.map(({ id, label, file, family, ascent }) => ({ id, label, file, family, ascent })),
};
