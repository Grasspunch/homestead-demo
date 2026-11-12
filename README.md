# homestead-demo

A small Node.js homepage with a contact form that emails the shop owner using SMTP. Requires Node.js 20 or newer.

## Run locally

```sh
npm install
```

Start a local SMTP test inbox such as Mailpit. With Docker:

```sh
docker run --rm -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit
```

In another terminal, start the application (POSIX shell):

```sh
SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_ALLOW_INSECURE=true \
SMTP_FROM=shop@example.test CONTACT_TO=owner@example.test npm start
```

Open http://127.0.0.1:3000, complete the name, email and message fields, and submit once. The success notice should appear and exactly one message should arrive in the test inbox at http://127.0.0.1:8025. SMTP acceptance is reported as success; final inbox delivery depends on the mail provider. Replying to the email addresses the visitor, not the shop's sender account.

## Tests

```sh
npm test
```

Tests start ephemeral HTTP and SMTP servers on loopback, with no external SMTP credentials or mail sent to real addresses. They cover one actual SMTP delivery, empty/whitespace fields, invalid email, header injection, length/type limits, malformed JSON, oversized bodies, foreign origins, delivery failure, recipient rejection, and the sixth attempt within a minute. No tests have been executed as part of generating this change; run them before merging.

## SMTP and deployment configuration

Set environment variables through the deployment platform; do not commit credentials.

| Variable | Purpose |
| --- | --- |
| `SMTP_HOST` | Required SMTP server hostname. |
| `SMTP_FROM` | Required plain email address authorized by the SMTP provider. |
| `CONTACT_TO` | Required owner's plain email address; visitors cannot override it. |
| `SMTP_PORT` | Defaults to 587, or 465 when `SMTP_SECURE=true`. |
| `SMTP_SECURE` | Set to `true` for implicit TLS, typically on port 465. Otherwise STARTTLS is required. |
| `SMTP_USER`, `SMTP_PASSWORD` | Set both when the SMTP service requires authentication. |
| `SMTP_ALLOW_INSECURE` | Set to `true` only for a local SMTP sandbox that does not support TLS. |
| `HOST`, `PORT` | Default to `127.0.0.1` and `3000`. Use `HOST=0.0.0.0` when required by the hosting platform. |

Use HTTPS in staging and production, and configure the provider's required sender verification, SPF and DKIM. Keep the original Host header when reverse proxying so same-origin requests can be checked. Do not enable insecure SMTP in production. Send a staging test and then a production test and verify receipt in the owner's inbox before considering deployment complete; no deployment infrastructure exists in this repository.

## Behavior and limits

The form preserves entered values on error, clears them on success, disables duplicate submissions while sending, and announces feedback to assistive technology. JavaScript is required. The server accepts only JSON, validates every field, uses a fixed sender and recipient, and sends plain text with the visitor's email as Reply-To. It does not store submissions or log message content or credentials.

Each socket IP may make five contact attempts per 60-second window, including invalid and failed attempts. The sixth receives HTTP 429 with Retry-After. This limiter is in memory, resets on restart, and is not shared across replicas. Forwarded IP headers are intentionally ignored: behind a reverse proxy, clients may share a limit. Before a multi-instance or high-traffic deployment, add a trusted-proxy-aware, shared edge rate limiter and appropriate spam controls. SMTP sends are not automatically retried; after a connection failure, delivery can be uncertain, so manually resubmitting may duplicate a message.
