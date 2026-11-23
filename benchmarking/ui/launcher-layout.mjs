// Reuse the live form's values and change events; the signed HTML and launch
// payloads remain owned by the existing launcher.
export function setupLauncherLayout(elements, catalogControls) {
  const form = elements['launch-form'];
  const options = form.querySelector('.run-options');
  const fields = options.querySelector('.options-fields');
  const actions = form.querySelector('.launch-actions');
  const labels = Object.fromEntries(['provider', 'model', 'effort', 'observation-mode', 'coding-mode', 'speed', 'world']
    .map(key => [key, elements[key].closest('label')]));
  for (const [key, label] of Object.entries(labels)) label.classList.add('launch-field', `launch-field-${key}`);
  labels.provider.querySelector('span').textContent = 'Agent';
  labels['coding-mode'].querySelector('span').textContent = 'Coding tools';
  labels['observation-mode'].querySelector('span').textContent = 'View';
  elements['observation-mode'].querySelector('[value="ascii"]').textContent = 'ASCII';
  elements['observation-mode'].querySelector('[value="vision"]').textContent = 'Vision';
  const coding = elements['coding-mode'], selectedCoding = coding.value;
  for (const [value, name] of [['off', 'Off'], ['any', 'On'], ['python', 'Python Only']]) {
    const option = coding.querySelector(`[value="${value}"]`);
    option.textContent = name;
    coding.append(option);
  }
  coding.value = selectedCoding;

  fields.prepend(labels.world);
  options.querySelector('summary > span').textContent = 'Options';
  options.append(elements['launch-note'], catalogControls, elements['runtime-details'],
    elements['vision-preview'], document.getElementById('agent-prompts'));
  form.replaceChildren(labels.provider, labels.model, labels.effort,
    labels['observation-mode'], labels['coding-mode'], labels.speed, options, actions);
  document.getElementById('launch-pair')?.remove();
  form.closest('.launch-panel').classList.add('compact-launch');

  const pickers = ['effort', 'observation-mode', 'coding-mode', 'speed'].map(key => {
    const select = elements[key], label = labels[key];
    const field = document.createElement('div');
    field.className = label.className;
    field.id = label.id;
    if (field.id && elements[field.id] === label) elements[field.id] = field;
    const heading = label.querySelector('span');
    field.append(heading, select);
    select.hidden = true;
    const group = document.createElement('div');
    group.className = 'launch-segments';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', heading.textContent);
    field.append(group); label.replaceWith(field);
    const buttons = new Map();
    group.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || select.value === button.dataset.value) return;
      select.value = button.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return () => {
      const wanted = new Set([...select.options].map(option => option.value));
      for (const [value, button] of buttons) if (!wanted.has(value)) { button.remove(); buttons.delete(value); }
      [...select.options].forEach((option, index) => {
        let button = buttons.get(option.value);
        if (!button) {
          button = document.createElement('button'); button.type = 'button';
          button.dataset.value = option.value; buttons.set(option.value, button);
          if (key === 'coding-mode') {
            const title = document.createElement('span'), note = document.createElement('small');
            note.id = `coding-${option.value}-note`;
            button.append(title, note);
            button.setAttribute('aria-describedby', note.id);
          }
        }
        if (key === 'coding-mode') {
          button.firstElementChild.textContent = option.textContent;
          button.lastElementChild.textContent = option.value === 'python' ? 'Legacy'
            : option.value === 'any' ? (option.disabled
              ? elements['observation-mode'].value === 'vision' ? 'ASCII only' : 'Unavailable'
              : 'Any language') : '';
          button.setAttribute('aria-label', option.textContent);
          button.title = option.title;
        } else {
          button.textContent = key === 'effort' && option.value === 'default' ? 'Default'
            : key === 'effort' && option.value === 'enabled' ? 'Enabled' : option.textContent;
        }
        button.disabled = select.disabled || option.disabled;
        button.setAttribute('aria-pressed', String(select.value === option.value));
        if (group.children[index] !== button) group.insertBefore(button, group.children[index] || null);
      });
      group.setAttribute('aria-busy', String(!select.options.length));
    };
  });
  return { update() { pickers.forEach(update => update()); } };
}
