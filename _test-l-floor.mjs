import { colorDistance, whiteLightnessFail } from './lib/color-sanity.js';
const cases = [
  ['#d9c7b9', 'white',  'marble — Joey case'],
  ['#f0f0f0', 'white',  'real white'],
  ['#e8e8e8', 'white',  'slightly dim white'],
  ['#d0d0d0', 'white',  'grey-ish white (dim)'],
  ['#f0e6d2', 'cream',  'cream — passes scope'],
  ['#f5f5dc', 'ivory',  'ivory — passes scope'],
  ['#937f7a', 'white',  'marble (original logs)'],
];
console.log('hex      color    dE      Lfail   verdict   note');
for (const [hex, color, note] of cases) {
  const dE = colorDistance(hex, color);
  const lFail = whiteLightnessFail(hex, color);
  const dEfail = dE !== null && dE > 25;
  const drop = dEfail || lFail;
  console.log(`${hex}  ${color.padEnd(7)} ${(dE === null ? '-' : dE.toFixed(1)).padStart(5)}   ${lFail ? 'YES' : 'no '}    ${drop ? 'DROP' : 'keep'}     ${note}`);
}
