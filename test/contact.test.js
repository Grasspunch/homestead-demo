import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { createContactServer } from '../server.js';

const from = 'shop@example.test';
const to = 'owner@example.test';
const valid = { name: 'Alex', email: 'alex@example.test', message: 'Is the shop open tomorrow?' };

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function app(t, options = {}) {
  const sent = [];
  const server = createContactServer({
    from,
    to,
    sendMail: async (mail) => {
      sent.push(mail);
      return { accepted: [to] };
    },
    ...options
  });
  const port = await listen(server);
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    sent,
    url,
    post: (body, headers = {}) => fetch(`${url}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  };
}

test('a valid submission delivers exactly one message to the SMTP test inbox', async (t) => {
  const inbox = [];
  const smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', callback);
      stream.on('end', () => {
        inbox.push({ envelope: session.envelope, raw: Buffer.concat(chunks).toString('utf8') });
        callback();
      });
    }
  });
  const port = await listen(smtp);
  t.after(() => new Promise((resolve) => smtp.close(resolve)));
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true });
  t.after(() => transport.close());
  const client = await app(t, { sendMail: (mail) => transport.sendMail(mail) });
  const response = await client.post({ ...valid, to: 'attacker@example.test' });
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /sent/);
  assert.equal(inbox.length, 1);
  assert.deepEqual(inbox[0].envelope.rcptTo.map((recipient) => recipient.address), [to]);
  assert.equal(inbox[0].envelope.mailFrom.address, from);
  assert.match(inbox[0].raw, /Reply-To: alex@example\.test/);
  assert.match(inbox[0].raw, /Name: Alex/);
  assert.match(inbox[0].raw, /Is the shop open tomorrow\?/);
});

test('each required field rejects empty and whitespace input without sending', async (t) => {
  for (const field of ['name', 'email', 'message']) {
    for (const value of ['', '   ']) {
      await t.test(`${field}: ${JSON.stringify(value)}`, async (t) => {
        const client = await app(t);
        assert.equal((await client.post({ ...valid, [field]: value })).status, 400);
        assert.equal(client.sent.length, 0);
      });
    }
  }
});

test('reject bad email, header injection, incorrect types and oversized fields', async (t) => {
  const cases = [
    { ...valid, email: 'not-an-email' },
    { ...valid, email: 'alex@example.test\r\nBcc: other@example.test' },
    { ...valid, name: 'Alex\r\nBcc: other@example.test' },
    { ...valid, name: 'a'.repeat(101) },
    { ...valid, message: 'a'.repeat(5001) },
    { ...valid, email: ['alex@example.test'] },
    { name: valid.name, email: valid.email },
    null,
    []
  ];
  for (const [index, body] of cases.entries()) {
    await t.test(`invalid payload ${index + 1}`, async (t) => {
      const client = await app(t);
      assert.equal((await client.post(body)).status, 400);
      assert.equal(client.sent.length, 0);
    });
  }
});

test('reject malformed JSON, oversized requests, wrong content type and foreign origins', async (t) => {
  const client = await app(t);
  assert.equal((await client.post('{')).status, 400);
  assert.equal((await client.post('x'.repeat(17 * 1024))).status, 413);
  assert.equal((await client.post(valid, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await client.post(valid, { Origin: 'https://other.example' })).status, 403);
  assert.equal(client.sent.length, 0);
});

test('block the sixth attempt in a minute and allow a send after expiry', async (t) => {
  let time = 1000;
  const client = await app(t, { now: () => time });
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await client.post(valid)).status, 200);
  }
  const blocked = await client.post(valid, { 'X-Forwarded-For': '203.0.113.1' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(client.sent.length, 5);
  time += 60_000;
  assert.equal((await client.post(valid)).status, 200);
  assert.equal(client.sent.length, 6);
});

test('invalid attempts also count toward the send limit', async (t) => {
  const client = await app(t);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await client.post({ ...valid, message: '' })).status, 400);
  }
  assert.equal((await client.post(valid)).status, 429);
  assert.equal(client.sent.length, 0);
});

test('SMTP failure and recipient rejection return a safe error without retries', async (t) => {
  for (const rejectRecipient of [false, true]) {
    await t.test(rejectRecipient ? 'recipient rejected' : 'SMTP unavailable', async (t) => {
      let calls = 0;
      const client = await app(t, {
        sendMail: async () => {
          calls += 1;
          if (rejectRecipient) return { accepted: [] };
          throw new Error('Sensitive SMTP diagnostic');
        }
      });
      const response = await client.post(valid);
      assert.equal(response.status, 502);
      assert.doesNotMatch(JSON.stringify(await response.json()), /Sensitive/);
      assert.equal(calls, 1);
    });
  }
});

test('serve the homepage and script, and reject unsupported routes and methods', async (t) => {
  const client = await app(t);
  const homepage = await fetch(client.url);
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  for (const id of ['name', 'email', 'message', 'feedback']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /data-state="success"/);
  assert.match(html, /data-state="error"/);
  assert.equal((await fetch(`${client.url}/contact.js`)).status, 200);
  assert.equal((await fetch(`${client.url}/api/contact`)).status, 405);
  assert.equal((await fetch(`${client.url}/missing`)).status, 404);
});
