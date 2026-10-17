// Mexican addresses. Offline, no mocks, no network.
//
// Every street name here is invented. `Siempre Viva` is a cartoon address and
// `Calle Falsa 123` is the Spanish-language joke address; neither is anybody's.

import { describe, expect, it } from 'vitest';

import { addressDetector } from './address.js';
import { SYNTHETIC_ADDRESS_FULL, SYNTHETIC_ADDRESS_STREET_ONLY } from './fixtures.js';

const find = (text: string): string[] => addressDetector.find(text).map((s) => s.text);

describe('addressDetector — finds', () => {
  it('a street with a number', () => {
    expect(find(`Vivo en ${SYNTHETIC_ADDRESS_STREET_ONLY}.`)).toEqual([SYNTHETIC_ADDRESS_STREET_ONLY]);
  });

  it.each([
    ['Avenida, abbreviated', 'Av. Siempre Viva 742'],
    ['Avenida, spelled out', 'Avenida Siempre Viva 742'],
    ['Boulevard', 'Blvd. Las Torres 1500'],
    ['Calzada', 'Calzada del Hueso 45'],
    ['Privada', 'Privada de los Alamos 8'],
    ['Callejón', 'Callejón del Beso 12'],
    ['Prolongación', 'Prolongación Reforma 1000'],
    ['a numeric street name', 'Calle 5 de Mayo 123'],
    ['an explicit No.', 'Calle Falsa No. 123'],
    ['a hash number', 'Calle Falsa #123'],
    ['sin número', 'Calle Falsa s/n'],
    ['a kilometre marker', 'Carretera Federal Km 45'],
  ])('%s', (_label, address) => {
    expect(find(`Domicilio: ${address}.`)).toEqual([address]);
  });

  it('a postal code on its own', () => {
    expect(find('Mándalo al C.P. 06700 por favor.')).toEqual(['C.P. 06700']);
    expect(find('CP 44100')).toEqual(['CP 44100']);
    expect(find('Código Postal 06700')).toEqual(['Código Postal 06700']);
  });

  it('a whole address as ONE span, not five', () => {
    // The merge is the reason a scrubbed sentence still reads: five adjacent
    // `[DIRECCION]` tokens in a row would be worse prose than the address.
    expect(find(`Vivo en ${SYNTHETIC_ADDRESS_FULL}, Ciudad de México.`)).toEqual([SYNTHETIC_ADDRESS_FULL]);
  });

  it('an address with an interior number and a delegación', () => {
    const address = 'Av. Siempre Viva 742, Int. 3, Col. Los Pinos, Alcaldía Coyoacán, C.P. 04000';
    expect(find(`Dirección: ${address}.`)).toEqual([address]);
  });

  it.each([
    ['Alcaldía', 'Calle Falsa 123, Alcaldía Coyoacán'],
    ['Delegación', 'Calle Falsa 123, Delegación Benito Juárez'],
    ['Deleg. abbreviated', 'Calle Falsa 123, Deleg. Iztapalapa'],
    ['Mpio. abbreviated', 'Calle Falsa 123, Mpio. Tlalpan'],
  ])('extends an anchored span across an administrative-area reference (%s)', (_label, address) => {
    // ⚠ The SPELLED-OUT second-level-division word is absent from the
    // vocabulary by lint decision — see `ADMIN_AREA_TYPE` in `address.ts`.
    // These four forms are what remains, and they cover Mexico City plus the
    // abbreviation. A span still anchors on the street either way; only its
    // tail is shorter.
    expect(find(`Domicilio: ${address}.`)).toEqual([address]);
  });

  it('two separate addresses in one string', () => {
    const text = 'La oficina está en Calle Falsa 123 pero la bodega está en Av. Reforma 222.';
    expect(find(text)).toEqual(['Calle Falsa 123', 'Av. Reforma 222']);
  });
});

describe('addressDetector — the documented recall gaps', () => {
  it('does NOT find a colonia standing alone', () => {
    // Gap 1. A settlement name identifies a neighbourhood, not a person, and
    // redacting every `Colonia X` would turn a history document into
    // `[DIRECCION]` soup. Pinned so it is a decision, not a surprise.
    expect(find('Creció en la Col. Los Pinos y estudió ahí.')).toEqual([]);
  });

  it('does NOT find a street with no number', () => {
    // Gap 2. The number is the only thing separating an address from a place
    // name.
    expect(find('Caminamos por Avenida Insurgentes toda la tarde.')).toEqual([]);
  });

  it('does NOT find a rural address with no street type and no number', () => {
    // Gap 3, and the one that matters most for the fleet's users. This is the
    // NER adapter's job, not the rules layer's.
    expect(find('Vive en la comunidad de Santa María, cerca del río.')).toEqual([]);
  });
});

describe('addressDetector — does not fire on ordinary prose', () => {
  it('leaves a date alone', () => {
    expect(find('La sesión fue el 5 de mayo de 2024.')).toEqual([]);
  });

  it('leaves a lowercase street word with no name and no number alone', () => {
    // 🔴 The regression this guards: allowing ZERO name words between the
    // street type and the number made `se reunieron en la calle 5 de mayo`
    // match `calle 5`, redacting a date out of running prose. The name is
    // required for exactly this reason.
    expect(find('Se reunieron en la calle 5 de mayo por la tarde.')).toEqual([]);
    expect(find('La calle estaba vacía.')).toEqual([]);
  });

  it('leaves a lowercase "cp" followed by digits alone', () => {
    // The abbreviated postal-code form is uppercase-only; lowercase `cp 12345`
    // is a plausible accident (a chapter, a part number).
    expect(find('Ver cp 12345 del manual.')).toEqual([]);
  });

  it('does not run a colonia name off into the following sentence', () => {
    // `NAME_TAIL` forces a segment to end on a capitalised or numeric word, so
    // the trailing connectors `y el` cannot be absorbed.
    const text = 'Calle Falsa 123, Col. Centro y el edificio estaba cerrado.';
    expect(find(text)).toEqual(['Calle Falsa 123, Col. Centro']);
  });
});

describe('addressDetector — mechanics', () => {
  it('reports offsets that match the text it claims', () => {
    const text = `Domicilio: ${SYNTHETIC_ADDRESS_FULL}.`;
    const spans = addressDetector.find(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('address');
    expect(span.detector).toBe('rules:address');
    expect(text.slice(span.start, span.end)).toBe(span.text);
  });

  it('is not stateful across calls', () => {
    const text = `Domicilio: ${SYNTHETIC_ADDRESS_FULL}`;
    expect(addressDetector.find(text)).toHaveLength(1);
    expect(addressDetector.find(text)).toHaveLength(1);
  });
});
