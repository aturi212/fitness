// Tests del cálculo de comidas (bloque <nutri-calc> de index.html).
// node --test tests/nutri_calc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = /\/\/ <nutri-calc>[^\n]*\n([\s\S]*?)\/\/ <\/nutri-calc>/.exec(html);
assert.ok(m, 'no encuentro el bloque <nutri-calc> en index.html');
const C = new Function(`${m[1]}; return { ncCantidadInicial, ncGramos, ncFactor, ncTotal, ncPor100, ncCoherente };`)();

const ref = (kcal, p, c, g, f = 0) => ({ kcal, protein_g: p, carbs_g: c, fat_g: g, fiber_g: f });

test('20 g de un producto de 400 kcal/100 g = 80 kcal', () => {
  const it = { basis: 'per_100g', ref: ref(400, 10, 50, 18, 4) };
  const t = C.ncTotal(it, { mode: 'g', value: 20 });
  assert.deepEqual(t, { kcal: 80, protein_g: 2, carbs_g: 10, fat_g: 3.6, fiber_g: 0.8 });
});

test('1 unidad de 12 g (galleta) sobre la referencia por 100 g', () => {
  const it = { basis: 'per_100g', unit_g: 12, ref: ref(450, 7, 70, 15) };
  assert.equal(C.ncGramos(it, { mode: 'unit', value: 1 }), 12);
  assert.equal(C.ncTotal(it, { mode: 'unit', value: 1 }).kcal, 54);
});

test('50 % de un envase de 250 g', () => {
  const it = { basis: 'per_100g', package_g: 250, ref: ref(200, 8, 20, 9) };
  const t = C.ncTotal(it, { mode: 'pct', value: 50 });
  assert.equal(t.kcal, 250);
  assert.equal(t.protein_g, 10);
});

test('redondeos: kcal enteras, macros a un decimal', () => {
  const it = { basis: 'per_100g', ref: ref(123, 7.3, 11.11, 3.33) };
  const t = C.ncTotal(it, { mode: 'g', value: 33 });
  assert.equal(t.kcal, 41);          // 40,59
  assert.equal(t.protein_g, 2.4);    // 2,409
  assert.equal(t.carbs_g, 3.7);      // 3,666
  assert.equal(t.fat_g, 1.1);        // 1,099
});

test('ml con densidad 1', () => {
  const it = { basis: 'per_100g', ref: ref(46, 3.2, 4.7, 1.6) };
  assert.equal(C.ncTotal(it, { mode: 'ml', value: 200 }).kcal, 92);
});

test('por unidad: unidades y gramos con peso por unidad', () => {
  const it = { basis: 'per_unit', unit_g: 30, ref: ref(120, 3, 20, 3) };
  assert.equal(C.ncTotal(it, { mode: 'unit', value: 2 }).kcal, 240);
  assert.equal(C.ncTotal(it, { mode: 'g', value: 45 }).kcal, 180);
  const sinPeso = { basis: 'per_unit', ref: ref(120, 3, 20, 3) };
  assert.equal(C.ncTotal(sinPeso, { mode: 'g', value: 45 }), null);
});

test('total dado por el usuario: se respeta y escala con media ración', () => {
  const it = { basis: 'total', ref: ref(450, 30, 40, 18) };
  assert.equal(C.ncTotal(it, { mode: 'unit', value: 1 }).kcal, 450);
  assert.equal(C.ncTotal(it, { mode: 'unit', value: 0.5 }).kcal, 225);
  assert.equal(C.ncTotal(it, { mode: 'pct', value: 50 }).protein_g, 15);
});

test('sin cantidad no hay total (la tarjeta la pide)', () => {
  const it = { basis: 'per_100g', ref: ref(400, 10, 50, 18), amount: { grams: null, ml: null, units: null, percent: null } };
  const q = C.ncCantidadInicial(it);
  assert.deepEqual(q, { mode: 'g', value: null });
  assert.equal(C.ncTotal(it, q), null);
  // % sin peso del envase: tampoco
  assert.equal(C.ncTotal({ basis: 'per_100g', ref: it.ref }, { mode: 'pct', value: 50 }), null);
});

test('cantidad inicial desde lo que entendió la IA', () => {
  assert.deepEqual(C.ncCantidadInicial({ basis: 'per_100g', amount: { grams: 20 } }), { mode: 'g', value: 20 });
  assert.deepEqual(C.ncCantidadInicial({ basis: 'per_100g', amount: { percent: 50 } }), { mode: 'pct', value: 50 });
  assert.deepEqual(C.ncCantidadInicial({ basis: 'total', amount: {} }), { mode: 'unit', value: 1 });
});

test('por 100 g para la despensa', () => {
  const p = C.ncPor100({ basis: 'per_unit', unit_g: 12, ref: ref(54, 0.84, 8.4, 1.8) });
  assert.equal(Math.round(p.kcal), 450);
  assert.equal(C.ncPor100({ basis: 'total', ref: ref(1, 1, 1, 1) }), null);
});

test('coherencia: el Emmental mal apuntado no cuadra; la cerveza no se juzga', () => {
  assert.equal(C.ncCoherente(ref(113, 4.2, 0.3, 4), 'Queso Emmental').ok, false);   // 54 por macros
  assert.equal(C.ncCoherente(ref(110, 8.4, 0.1, 8.7), 'Queso Emmental').ok, true);
  assert.equal(C.ncCoherente(ref(138, 1.2, 3.3, 0), 'Cerveza 33 cl').ok, true);
  assert.equal(C.ncCoherente(ref(10, 0.5, 1, 0.2), 'Lechuga').ok, true);           // poco: margen de 30
});
