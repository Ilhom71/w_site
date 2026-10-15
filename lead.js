// Sends a form submission to our server (/api/lead), which forwards it to Telegram.
// Resolves true on success, false on any failure.
window.sendLead = async function (type, fields) {
  try {
    const r = await fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, fields, page: location.pathname })
    });
    return r.ok;
  } catch (e) {
    return false;
  }
};
