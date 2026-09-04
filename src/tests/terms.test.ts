import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyCorrections, applyCorrectionsDeep, countOccurrences, deriveCorrections,
} from '../domain/terms.js';

test('a spelling question yields the correction its answer implies', () => {
  const found = deriveCorrections(
    'Confirm the ship’s name spelling: Mapado or Manado.',
    'Mapado',
  );
  assert.deepEqual(found, [{ wrong: 'Manado', right: 'Mapado' }]);
});

test('a prose answer establishes no spelling', () => {
  assert.deepEqual(
    deriveCorrections(
      'How pagan do the rituals go for a family audience?',
      'Family friendly, so the captain is protected by the universe rather than by rites.',
    ),
    [],
  );
});

test('an answer not present in the question establishes nothing', () => {
  assert.deepEqual(deriveCorrections('Name the ship: Mapado or Manado.', 'Seabird'), []);
});

test('sentence-opening words are not mistaken for alternatives', () => {
  const found = deriveCorrections('Should the ship be Mapado or Manado?', 'Mapado');
  assert.deepEqual(found.map((c) => c.wrong), ['Manado']);
});

test('corrections respect word boundaries', () => {
  const corrections = [{ wrong: 'Manado', right: 'Mapado' }];
  assert.equal(
    applyCorrections('The Manado sailed. Manado’s crew cheered.', corrections),
    'The Mapado sailed. Mapado’s crew cheered.',
  );
  // A longer word merely containing the term is left alone.
  assert.equal(applyCorrections('Manadoan waters', corrections), 'Manadoan waters');
});

test('corrections reach every string in a nested artifact', () => {
  const map = {
    entities: [
      { name: 'Manado (Enchanted Longship)', aliases: ['Manado'], description: 'A longship.' },
      { name: 'Dark Firebeard', aliases: [], description: 'Captain of the Manado.' },
    ],
    timeline: [{ label: 'Launch', when: 'Spring', summary: 'The Manado leaves harbour.' }],
  };

  const fixed = applyCorrectionsDeep(map, [{ wrong: 'Manado', right: 'Mapado' }]);
  assert.equal(countOccurrences(fixed, 'Manado'), 0, 'nothing survives anywhere');
  assert.equal(countOccurrences(fixed, 'Mapado'), 4);
  assert.equal(fixed.entities[0]!.name, 'Mapado (Enchanted Longship)');
});

test('an empty correction list is a no-op', () => {
  const value = { a: 'Manado' };
  assert.equal(applyCorrectionsDeep(value, []), value, 'the same object is returned');
});
