import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';

const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60_000;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/contact.js', ['public/contact.js', 'text/javascript; charset=utf-8']]
]);

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);
}

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', () => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('Could not read the request.'), { status: 400 }));
    });
  });
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { name, email, message } = body;
  if ([name, email, message].some((value) => typeof value !== 'string')) return null;
  const fields = { name: name.trim(), email: email.trim(), message: message.trim() };
  if (!fields.name || fields.name.length > 100 || /[\r\n\x00-\x1f\x7f]/.test(fields.name)) return null;
  if (!validEmail(fields.email) || /[\x00-\x1f\x7f]/.test(fields.email)) return null;
  if (!fields.message || fields.message.length > 5000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(fields.message)) return null;
  return fields;
}

export function createContactServer({ sendMail, from, to, now = Date.now }) {
  if (typeof sendMail !== 'function' || !validEmail(from) || !validEmail(to)) {
    throw new Error('Configure a mail sender and valid from/to addresses.');
  }
  const attempts = new Map();
  const server = createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (assets.has(pathname)) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          json(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
          return;
        }
        const [file, type] = assets.get(pathname);
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : content);
        return;
      }
      if (pathname !== '/api/contact') {
        json(response, 404, { error: 'Not found.' });
        return;
      }
      if (request.method !== 'POST') {
        json(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        return;
      }

      // Use the socket address, never an untrusted forwarded header.
      const ip = request.socket.remoteAddress || 'unknown';
      const time = now();
      for (const [key, value] of attempts) {
        if (time >= value.expires) attempts.delete(key);
      }
      let bucket = attempts.get(ip);
      if (!bucket) {
        if (attempts.size >= 5000) {
          json(response, 503, { error: 'The contact form is busy. Please try again later.' });
          return;
        }
        bucket = { count: 0, expires: time + WINDOW_MS };
        attempts.set(ip, bucket);
      }
      if (bucket.count >= 5) {
        json(response, 429, { error: 'Too many attempts. Please wait a minute before trying again.' }, {
          'Retry-After': String(Math.max(1, Math.ceil((bucket.expires - time) / 1000)))
        });
        return;
      }
      bucket.count += 1;

      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        json(response, 415, { error: 'Send the form as JSON.' });
        return;
      }
      // JSON-only requests and no CORS prevent cross-origin browser form submissions.
      if (request.headers.origin) {
        let origin;
        try {
          origin = new URL(request.headers.origin);
        } catch {
          json(response, 403, { error: 'Submit the form from this website.' });
          return;
        }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) {
          json(response, 403, { error: 'Submit the form from this website.' });
          return;
        }
      }
      let body;
      try {
        body = JSON.parse(await readBody(request));
      } catch (error) {
        json(response, error.status || 400, { error: error.status ? error.message : 'Invalid JSON.' });
        return;
      }
      const fields = validate(body);
      if (!fields) {
        json(response, 400, { error: 'Enter a name (up to 100 characters), a valid email, and a message (up to 5,000 characters).' });
        return;
      }
      try {
        const result = await sendMail({
          from,
          to,
          replyTo: fields.email,
          subject: 'New shop contact message',
          text: `Name: ${fields.name}\nEmail: ${fields.email}\n\n${fields.message}`
        });
        if (!result?.accepted?.some((address) => address.toLowerCase() === to.toLowerCase())) {
          throw new Error('Owner recipient was not accepted.');
        }
      } catch {
        console.error('Contact email delivery failed. Check SMTP service and configuration.');
        json(response, 502, { error: 'We could not send your message. Please try again later.' });
        return;
      }
      json(response, 200, { message: 'Thank you! Your message has been sent.' });
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'Something went wrong. Please try again later.' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

function start() {
  const { SMTP_HOST, SMTP_FROM, CONTACT_TO, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !validEmail(SMTP_FROM) || !validEmail(CONTACT_TO)) {
    throw new Error('Set SMTP_HOST, SMTP_FROM and CONTACT_TO. Addresses must be plain email addresses.');
  }
  if (Boolean(SMTP_USER) !== Boolean(SMTP_PASSWORD)) {
    throw new Error('Set both SMTP_USER and SMTP_PASSWORD for authenticated SMTP.');
  }
  const secure = process.env.SMTP_SECURE === 'true';
  const smtpPort = Number(process.env.SMTP_PORT || (secure ? 465 : 587));
  const port = Number(process.env.PORT || 3000);
  if (![smtpPort, port].every((value) => Number.isInteger(value) && value > 0 && value <= 65535)) {
    throw new Error('SMTP_PORT and PORT must be valid TCP ports.');
  }
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: smtpPort,
    secure,
    requireTLS: !secure && process.env.SMTP_ALLOW_INSECURE !== 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  const server = createContactServer({
    sendMail: (mail) => transport.sendMail(mail),
    from: SMTP_FROM,
    to: CONTACT_TO
  });
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Homepage listening at http://${host}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
