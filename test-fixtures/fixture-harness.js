// Shared by every fixture page: records submit attempts so tests can assert
// Filler never submitted a form (PLAYBOOK §0.10 step 5).
window.__submits = [];
document.addEventListener(
  'submit',
  (event) => {
    event.preventDefault();
    window.__submits.push({ form: event.target.id || null, at: Date.now() });
  },
  true,
);
