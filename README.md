# homestead-demo

A dependency-free Node.js homepage with a contact form. Requires Node.js 18 or newer and a Resend account for email delivery.

## Run locally

1. In Resend, verify a sending domain and create an API key with email-sending permission.
2. Set these environment variables in your shell or hosting platform (never commit credentials):
   - `RESEND_API_KEY`: your Resend API key.
   - `CONTACT_FROM`: a sender address on your verified domain.
   - `CONTACT_TO`: the shop owner's address; use your test inbox for testing.
   - `PORT`: optional, defaults to `3000`.
3. Run `node server.js` from the repository root.
4. Open http://localhost:3000 and submit your name, email and message.

The server sends a single email-provider request per submission, with the visitor's address as Reply-To. A success message means Resend accepted the email; check the test inbox (including spam) and Resend delivery logs to confirm delivery. Missing configuration returns a visible error without sending anything.

## Manual checks

- Submit valid values and confirm one email reaches the test inbox with the submitted details and correct Reply-To.
- Try empty fields or an invalid email; browser validation should block submission.
- Remove `RESEND_API_KEY` and restart; submission should show an error and retain the entered values.
- While sending, the button is disabled to prevent repeated clicks. Successful submission clears the form.

Before public deployment, configure HTTPS and request rate limiting at your hosting proxy to prevent email abuse. Network failures can leave delivery uncertain; the app does not automatically retry submissions.
