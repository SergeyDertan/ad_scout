// Zero-dependency unit tests for the Gmail (app password) credential wiring.
// These import the provider MODULE (safe: nodemailer/imapflow are loaded lazily
// *inside* methods via dynamic import, so nothing external is touched here) and
// exercise the pure `credsFor` resolver — the heart of "use a personal Gmail
// with an app password". The live SMTP/IMAP paths are proven separately.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Account } from '../../domain/types';
import { credsFor } from './smtp-imap.provider';

function account(credentialRef: string): Account {
  return {
    id: 'a1',
    email: 'outreach@gmail.com',
    providerType: 'gmail-api',
    credentialRef,
    senderName: 'Vlad',
    status: 'active',
    createdAt: '2026-06-01T00:00:00Z',
    maxDailyLimit: 40,
  };
}

test('credsFor: Gmail defaults resolve to Gmail SMTP/IMAP with the app password', () => {
  const env = {
    GMAIL_OUTREACH_USER: 'outreach@gmail.com',
    GMAIL_OUTREACH_PASS: 'abcd efgh ijkl mnop', // a Gmail app password
  } as NodeJS.ProcessEnv;

  const creds = credsFor(account('GMAIL_OUTREACH'), env);
  assert.equal(creds.user, 'outreach@gmail.com');
  assert.equal(creds.pass, 'abcd efgh ijkl mnop');
  assert.equal(creds.smtpHost, 'smtp.gmail.com');
  assert.equal(creds.smtpPort, 465); // implicit TLS (secure)
  assert.equal(creds.imapHost, 'imap.gmail.com');
  assert.equal(creds.imapPort, 993);
});

test('credsFor: throws a helpful error when the app password env vars are missing', () => {
  assert.throws(
    () => credsFor(account('GMAIL_OUTREACH'), {} as NodeJS.ProcessEnv),
    /Missing GMAIL_OUTREACH_USER \/ GMAIL_OUTREACH_PASS/,
  );
});

test('credsFor: a non-Gmail host overrides SMTP/IMAP hosts and ports', () => {
  const env = {
    WORK_USER: 'me@work.example',
    WORK_PASS: 'secret',
    WORK_HOST: 'mail.work.example',
    WORK_SMTP_PORT: '587',
    WORK_IMAP_PORT: '143',
  } as NodeJS.ProcessEnv;

  const creds = credsFor(account('WORK'), env);
  assert.equal(creds.smtpHost, 'mail.work.example');
  assert.equal(creds.imapHost, 'mail.work.example');
  assert.equal(creds.smtpPort, 587);
  assert.equal(creds.imapPort, 143);
});
