import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  containsEmDash, countEmDashes, stripEmDashes, stripEmDashesDeep,
} from '../domain/typography.js';

test('an em dash between clauses becomes a comma', () => {
  assert.equal(
    stripEmDashes('A standard four-suit pack—Swords, Batons, Cups—receives a series.'),
    'A standard four-suit pack, Swords, Batons, Cups, receives a series.',
  );
  assert.equal(
    stripEmDashes('That stance — epistemic humility — is the through line.'),
    'That stance, epistemic humility, is the through line.',
  );
});

test('the ASCII double hyphen is treated the same', () => {
  assert.equal(stripEmDashes('the toy--sold as ancient'), 'the toy, sold as ancient');
});

test('a trailing dash is dropped rather than becoming a stray comma', () => {
  assert.equal(stripEmDashes('"I said—"'), '"I said"');
  assert.equal(stripEmDashes('He hesitated—'), 'He hesitated');
});

test('a leading dash is dropped', () => {
  assert.equal(stripEmDashes('— Compact chronology'), 'Compact chronology');
});

test('punctuation is not doubled up', () => {
  assert.equal(stripEmDashes('yes,—but no'), 'yes, but no');
  assert.equal(stripEmDashes('wait;—then go'), 'wait; then go');
});

test('numeric and date ranges survive', () => {
  // An unspaced en dash is a range, not punctuation.
  assert.equal(stripEmDashes('The History of the Occult Tarot, 1870–1970'),
    'The History of the Occult Tarot, 1870–1970');
  assert.equal(stripEmDashes('a 300–400 mm branch'), 'a 300–400 mm branch');
  assert.equal(stripEmDashes('the 18th–19th century'), 'the 18th–19th century');
});

test('a spaced en dash is punctuation and is rewritten', () => {
  assert.equal(stripEmDashes('the card – the toy – the oracle'),
    'the card, the toy, the oracle');
});

test('hyphenated words are untouched', () => {
  assert.equal(stripEmDashes('a four-suit trick-taking pack'), 'a four-suit trick-taking pack');
});

test('the rule reaches every string in a nested artifact', () => {
  const chapter = {
    number: 1,
    title: 'The Toy—and the Relic',
    blocks: [
      { type: 'paragraph', text: 'Tarot is a game—not a temple book.' },
      { type: 'dialogue', text: '"You saw it too—" she said.' },
    ],
    notes: ['check Dummett—1980'],
  };

  const clean = stripEmDashesDeep(chapter);
  assert.equal(countEmDashes(clean), 0, 'nothing survives anywhere in the tree');
  assert.equal(clean.title, 'The Toy, and the Relic');
  assert.equal(clean.blocks[0]!.text, 'Tarot is a game, not a temple book.');
  assert.equal(clean.blocks[1]!.text, '"You saw it too" she said.');
  assert.equal(clean.notes[0], 'check Dummett, 1980');
  assert.equal(clean.number, 1, 'non-strings pass through');
});

test('detection agrees with removal', () => {
  const dirty = 'a game—not a book';
  assert.ok(containsEmDash(dirty));
  assert.ok(!containsEmDash(stripEmDashes(dirty)));
  assert.equal(countEmDashes(stripEmDashes(dirty)), 0);
});
