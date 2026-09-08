// Deterministic, localized email drafter (no LLM). Renders a broad, agency-style
// pitch that does not name any advertised site or single topic — it asks for the
// publisher's guest-post rate card (regular / grey niches). Pure.

import type { Account, OutreachLanguage, PitchProfile, Target } from '../domain/types';

export interface DraftedEmail {
  subject: string;
  body: string;
}

interface OutreachCopy {
  subject: string;
  greeting: (name: string) => string;
  intro: (senderName: string) => string;
  inquiry: string;
  questions: readonly string[];
  thanks: string;
  signoff: (senderName: string) => string;
}

const COPY: Record<OutreachLanguage, OutreachCopy> = {
  en: {
    subject: 'Interest in publishing a sponsored post on your website',
    greeting: (name) => `Hello, ${name},`,
    intro: (senderName) =>
      `My name is ${senderName}, and I'm an advertising manager who helps brands ` +
      'get featured through sponsored posts on quality websites like yours.',
    inquiry:
      "I'd like to know whether you accept paid publications — and if so, could you please " +
      'share your guest-post rates for:',
    questions: [
      'A regular guest post / sponsored article',
      'Gray / sensitive niches — please specify casino and VPN separately if their rates differ',
    ],
    thanks: 'Thank you in advance for your time and response!',
    signoff: (senderName) => `Best regards,\n${senderName}`,
  },
  es: {
    subject: 'Interés en publicar un artículo patrocinado en su sitio web',
    greeting: (name) => `Hola, ${name}:`,
    intro: (senderName) =>
      `Me llamo ${senderName} y soy responsable de publicidad. Ayudo a distintas marcas a darse ` +
      'a conocer mediante artículos patrocinados en sitios web de calidad como el suyo.',
    inquiry:
      'Me gustaría saber si aceptan publicaciones patrocinadas. En caso afirmativo, ¿podría compartir sus tarifas para:',
    questions: [
      'Un guest post o artículo patrocinado convencional',
      'Nichos grises o sensibles; indique por separado las tarifas para casino y VPN si son diferentes',
    ],
    thanks: 'Muchas gracias de antemano por su tiempo y su respuesta.',
    signoff: (senderName) => `Un cordial saludo,\n${senderName}`,
  },
  pt: {
    subject: 'Interesse em publicar um artigo patrocinado no seu site',
    greeting: (name) => `Olá, ${name},`,
    intro: (senderName) =>
      `O meu nome é ${senderName} e sou gestor de publicidade. Ajudo marcas a ganhar visibilidade ` +
      'através de artigos patrocinados em sites de qualidade como o seu.',
    inquiry:
      'Gostaria de saber se aceitam publicações patrocinadas. Em caso afirmativo, poderia partilhar as suas tarifas para:',
    questions: [
      'Um guest post ou artigo patrocinado convencional',
      'Nichos cinzentos ou sensíveis — indique separadamente as tarifas para casino e VPN, caso sejam diferentes',
    ],
    thanks: 'Agradeço, desde já, o seu tempo e a sua resposta.',
    signoff: (senderName) => `Com os melhores cumprimentos,\n${senderName}`,
  },
};

/** Domain-ish display name from a website URL (fallback greeting). */
export function siteName(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

export function draftEmail(profile: PitchProfile, account: Account, target: Target): DraftedEmail {
  const language = profile.language ?? 'en';
  const copy = COPY[language];
  const greeting = target.contactName?.trim() || siteName(target.websiteUrl);
  // SUBJECT_TEMPLATE is the legacy English-only global override. A translated
  // batch uses its localized subject so an English environment value cannot leak.
  const subject = language === 'en' ? profile.subjectTemplate?.trim() || copy.subject : copy.subject;

  const sig = account.signature?.trim() || copy.signoff(account.senderName);
  const hook = target.notes?.trim() ? `\n${target.notes.trim()}\n` : '';
  const questions = copy.questions.map((question) => `  - ${question}`).join('\n');

  const body = [
    copy.greeting(greeting),
    '',
    copy.intro(account.senderName),
    '',
    `${copy.inquiry}\n\n${questions}`,
    hook,
    copy.thanks,
    '',
    sig,
  ].join('\n');

  return { subject, body };
}
