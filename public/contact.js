const form = document.getElementById('contact-form');
const button = document.getElementById('send-button');
const feedback = document.getElementById('feedback');
let sending = false;
button.disabled = false;

function showFeedback(state, message) {
  feedback.dataset.state = state;
  feedback.textContent = message;
  feedback.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !form.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(form));
  for (const key of ['name', 'email', 'message']) fields[key] = fields[key].trim();
  if (!fields.name || !fields.email || !fields.message) {
    showFeedback('error', 'Please fill in every field. Spaces alone do not count.');
    return;
  }
  sending = true;
  button.disabled = true;
  button.textContent = 'Sending…';
  form.setAttribute('aria-busy', 'true');
  feedback.removeAttribute('data-state');
  feedback.textContent = '';
  try {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });
    const result = await response.json();
    if (!response.ok) {
      showFeedback('error', result.error || 'We could not send your message. Please try again later.');
      return;
    }
    form.reset();
    showFeedback('success', result.message);
  } catch {
    showFeedback('error', 'The connection was interrupted. Your message may not have been sent. Please check your connection before trying again.');
  } finally {
    sending = false;
    button.disabled = false;
    button.textContent = 'Send message';
    form.removeAttribute('aria-busy');
  }
});
