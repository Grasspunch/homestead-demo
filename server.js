const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const homepage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const { RESEND_API_KEY, CONTACT_FROM, CONTACT_TO } = process.env;

function json(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ message }));
}

async function contact(req, res) {
  if (!RESEND_API_KEY || !CONTACT_FROM || !CONTACT_TO) {
    return json(res, 503, 'Email is not configured yet. Please try again later.');
  }
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return json(res, 415, 'Please send the form as JSON.');
  }

  let data;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) {
        json(res, 413, 'Your message is too long.');
        return;
      }
      chunks.push(chunk);
    }
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return json(res, 400, 'Please check your form and try again.');
  }

  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  const email = typeof data?.email === 'string' ? data.email.trim() : '';
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  if (!name || name.length > 100 || !message || message.length > 5000 ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 400, 'Enter a name, a valid email address and a message.');
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: CONTACT_FROM,
        to: [CONTACT_TO],
        reply_to: email,
        subject: 'New homepage contact message',
        text: `Name: ${name}\nEmail: ${email}\n\n${message}`
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.error('Email provider rejected contact submission:', response.status);
      return json(res, 502, 'We could not send your message. Please try again later.');
    }
    return json(res, 200, 'Thank you! Your message has been sent to the shop owner.');
  } catch {
    return json(res, 502, 'We could not confirm delivery. Please try again later.');
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(homepage);
  }
  if (pathname === '/contact' && req.method === 'POST') {
    return contact(req, res);
  }
  json(res, 404, 'Not found.');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Homepage listening on port ${process.env.PORT || 3000}`);
});
