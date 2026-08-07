import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { resolveLinkedDoc, unwrapTrackedUrl } from './linked-docs';

const SHEET_ID = '1ff3b6fz6BhMwprwrRL-3hyy6sSLM020bUh7vL4yWk5k';

test('a bare Google Sheet link becomes a CSV export of the linked tab', () => {
  const doc = resolveLinkedDoc(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=68544074`);
  assert.equal(doc?.kind, 'Google Sheet');
  assert.equal(doc?.url, `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=68544074`);
});

// The regression this file exists for: 54 stored replies linked their price list
// through a bulk-mail click tracker, so the sheet was never downloaded, nothing
// was flagged, and the reply was extracted from its body alone.
test('an AWS SES tracker-wrapped sheet still resolves, tab and all', () => {
  const wrapped =
    'https://nmx57hns.r.us-east-1.awstrack.me/L0/https:%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2F' +
    `${SHEET_ID}%2Fedit%23gid=68544074/1/0100019fa2bd46ae-6214d5b5-4b00-4cbe-8f67-46ac6e5806f8-000000/8Yzd7hpBLo9ZIn2iHwVY2MAoj9U=473`;
  const doc = resolveLinkedDoc(wrapped);
  assert.equal(doc?.kind, 'Google Sheet');
  assert.equal(doc?.url, `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=68544074`);
});

test('a safelinks-style ?url= wrapper resolves', () => {
  const wrapped =
    'https://nam12.safelinks.protection.outlook.com/?url=' +
    encodeURIComponent(`https://docs.google.com/document/d/${SHEET_ID}/edit`) +
    '&data=05%7C01';
  const doc = resolveLinkedDoc(wrapped);
  assert.equal(doc?.kind, 'Google Doc');
  assert.equal(doc?.url, `https://docs.google.com/document/d/${SHEET_ID}/export?format=txt`);
});

test('a wrapped PDF resolves to the PDF itself, not the tracker', () => {
  const wrapped = 'https://click.example.com/L0/https:%2F%2Fpublisher.com%2Frates%2Fmedia-kit.pdf/1/abc';
  const doc = resolveLinkedDoc(wrapped);
  assert.equal(doc?.mimeType, 'application/pdf');
  assert.ok(doc?.url.startsWith('https://publisher.com/rates/media-kit.pdf'));
});

test('an ordinary page is still left to WebFetch', () => {
  assert.equal(resolveLinkedDoc('https://publisher.com/advertise'), undefined);
  assert.equal(resolveLinkedDoc('not a url'), undefined);
});

test('unwrapping stops at trackers that hide the destination', () => {
  // SendGrid encodes the target opaquely — nothing to unwrap, so it must be
  // returned untouched rather than mangled into a wrong URL.
  const sendgrid = 'https://u123.ct.sendgrid.net/ls/click?upn=abc123DEF456';
  assert.equal(unwrapTrackedUrl(sendgrid), sendgrid);
  assert.equal(resolveLinkedDoc(sendgrid), undefined);
});

test('a sheet id with percent-encoded underscores still resolves', () => {
  const doc = resolveLinkedDoc(
    'https://docs.google.com/spreadsheets/d/1oB%5FJNcCxlAefQ57alF6SjEYoFCLObkuKPiia%5FbfeF8c/edit?gid=0#gid=0',
  );
  assert.equal(doc?.kind, 'Google Sheet');
  assert.equal(
    doc?.url,
    'https://docs.google.com/spreadsheets/d/1oB_JNcCxlAefQ57alF6SjEYoFCLObkuKPiia_bfeF8c/export?format=csv&gid=0',
  );
});
