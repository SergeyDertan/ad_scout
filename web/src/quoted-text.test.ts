import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitQuoted } from './quoted-text';

test('a plain reply keeps its whole body and quotes nothing', () => {
  const { body, quoted } = splitQuoted('150 EUR works for us.\n\nBest,\nAnna');
  assert.equal(body, '150 EUR works for us.\n\nBest,\nAnna');
  assert.equal(quoted, undefined);
});

test("Gmail's attribution line starts the quote", () => {
  const { body, quoted } = splitQuoted(
    [
      'Deal. Send the text.',
      '',
      'On Tue, 12 Mar 2026 at 10:02, Vlad <vlad@ours.com> wrote:',
      '> Would 120 EUR work?',
      '> Thanks',
    ].join('\n'),
  );
  assert.equal(body, 'Deal. Send the text.');
  assert.match(quoted!, /^On Tue/);
});

test('an attribution wrapped across lines is still found', () => {
  const { body, quoted } = splitQuoted(
    ['Yes.', '', 'On Tue, 12 Mar 2026 at 10:02,', 'Vlad <vlad@ours.com>', 'wrote:', '> hi'].join('\n'),
  );
  assert.equal(body, 'Yes.');
  assert.match(quoted!, /^On Tue, 12 Mar/);
});

test('a non-English attribution is recognised too', () => {
  const { body } = splitQuoted('Ок, 120.\n\nвт, 12 мар 2026 г. в 10:02, Vlad <v@x.com> пишет:\n> hi');
  assert.equal(body, 'Ок, 120.');
});

test("Outlook's quoted envelope starts the quote", () => {
  const { body, quoted } = splitQuoted(
    ['We can publish on Friday.', '', 'From: Vlad <vlad@ours.com>', 'Sent: 12 March 2026 10:02', 'To: admin@site.com', 'Subject: Guest post', '', 'Hi there'].join('\n'),
  );
  assert.equal(body, 'We can publish on Friday.');
  assert.match(quoted!, /^From: Vlad/);
});

test('a bare "From:" line a person typed is not a quote marker', () => {
  const { body, quoted } = splitQuoted('From: our editorial team, thanks for the offer.');
  assert.equal(body, 'From: our editorial team, thanks for the offer.');
  assert.equal(quoted, undefined);
});

test('a run of chevrons starts the quote, a single one does not', () => {
  const run = splitQuoted('Fine.\n\n> Would 120 work?\n> Thanks');
  assert.equal(run.body, 'Fine.');
  assert.match(run.quoted!, /^> Would 120/);

  const single = splitQuoted('> 150 is fine by me');
  assert.equal(single.body, '> 150 is fine by me');
  assert.equal(single.quoted, undefined);
});

test('an underscore rule and an "Original Message" bar both separate', () => {
  assert.equal(splitQuoted('Ok.\n\n________________\n\nold stuff').body, 'Ok.');
  assert.equal(splitQuoted('Ok.\n\n----- Original Message -----\nold stuff').body, 'Ok.');
});

test('a message that is nothing but a quote is shown whole', () => {
  const text = 'On Tue, 12 Mar 2026 at 10:02, Vlad wrote:\n> Would 120 EUR work?';
  const { body, quoted } = splitQuoted(text);
  assert.equal(body, text);
  assert.equal(quoted, undefined);
});

test('a signature between the reply and the quote stays with the reply', () => {
  const { body } = splitQuoted(
    ['120 works.', '', '--', 'Anna, site.com', '', 'On Tue, 12 Mar 2026 at 10:02, Vlad wrote:', '> hi'].join('\n'),
  );
  assert.equal(body, '120 works.\n\n--\nAnna, site.com');
});
