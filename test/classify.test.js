const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEvents } = require('../src/parse');
const { classifyEvent } = require('../src/classify');

const classifyFixture = (name) => {
  const ics = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const [event] = parseEvents(ics);
  return classifyEvent(event).type;
};

test('classifies flight invites', () => {
  assert.equal(classifyFixture('flight.ics'), 'flight');
});

test('classifies train invites', () => {
  assert.equal(classifyFixture('train.ics'), 'train');
});

test('classifies hotel invites', () => {
  assert.equal(classifyFixture('hotel.ics'), 'hotel');
});

test('falls back to a generic reservation for anything else', () => {
  assert.equal(classifyFixture('generic.ics'), 'reservation');
});
