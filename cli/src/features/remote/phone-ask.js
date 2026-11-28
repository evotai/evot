import { createAskState, getUIState, focusOption, askEditText, askGoTo, askSelect, askResponses, selectedAnswerText } from '../../ui/ask.js';

const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};

// Only the final answer or cancellation goes over the wire. A polling frame
// must not recreate an input under the user's cursor (particularly during IME).
export function questionPanel(panel, act) {
  let id = null, generation, state, composing = false;
  function button(text, click) {
    const el = node('button', text);
    el.type = 'button';
    el.onclick = () => { if (!panel.inert && !composing && panel.contains(el)) click(); };
    return el;
  }
  const submit = () => act({kind:'answer', id, generation, answers:askResponses(state).map(a => a.answer)});
  // The TUI routes Esc through run interruption. Selecting Cancel on the
  // review page instead resolves the pending question without stopping the run.
  const stop = () => { if (id && !panel.inert && !composing) act({kind:'interrupt-ask', id, generation}); };
  function choose(index) {
    const result = askSelect(focusOption(state, index));
    state = result.state;
    if (result.done) submit(); else paint(true);
  }
  function go(tab) { state = askGoTo(state, tab); paint(true); }
  function paint(focus) {
    panel.replaceChildren(); composing = false;
    const count = state.questions.length, tab = state.currentTab, review = state.onSubmitTab;
    if (count > 1) {
      const tabs = node('nav'); tabs.setAttribute('aria-label', 'Questions');
      [...state.questions.map((q,i) => `${selectedAnswerText(state,i) === null ? '☐' : '☒'} ${q.header}`), '✓ Submit'].forEach((label,i) => {
        const b = button(label, () => go(i));
        if (i === (review ? count : tab)) b.setAttribute('aria-current','step');
        tabs.append(b);
      });
      panel.append(tabs);
    }
    const q = state.questions[tab], heading = node('h2', review ? 'Review your answers' : q.question);
    heading.tabIndex = -1; panel.append(heading);
    const footer = node('div'); footer.className = 'ask-actions';
    if (review) {
      if (state.answers.some((_,i) => selectedAnswerText(state,i) === null)) panel.append(node('p','⚠ You have not answered all questions'));
      const list = node('dl');
      state.questions.forEach((item,i) => {
        const answer = selectedAnswerText(state,i);
        if (answer !== null) list.append(node('dt',item.question),node('dd',`→ ${answer}`));
      });
      panel.append(list); footer.append(button('Submit answers', submit), button('Cancel', () => act({kind:'cancel-ask', id, generation})));
    } else {
      const answer = state.answers[tab], ui = getUIState(state);
      q.options.forEach((option,i) => {
        const row = button(`${i+1}. ${option.label}${answer.selectedOption === i ? ' ✓' : ''}`, () => choose(i));
        row.className = 'ask-option';
        if (option.description) row.append(node('small',option.description));
        panel.append(row);
      });
      const input = node('textarea'), custom = q.options.length;
      input.placeholder = custom ? 'Type something.' : 'Type your answer.';
      input.setAttribute('aria-label', custom ? `Custom answer: ${q.question}` : q.question);
      input.rows = 1; input.maxLength = 8192; input.value = ui.otherText;
      input.autocomplete = 'off'; input.autocapitalize = 'none'; input.spellcheck = false;
      input.setAttribute('autocorrect','off'); input.setAttribute('writingsuggestions','false');
      const confirm = button(count === 1 ? 'Submit answer' : 'Next', () => choose(custom));
      const sync = () => { confirm.disabled = composing || !input.value.trim(); };
      input.oninput = () => { state = askEditText(state,input.value); sync(); };
      input.addEventListener('compositionstart', () => { composing = true; sync(); });
      input.addEventListener('compositionend', () => { composing = false; sync(); });
      input.onkeydown = e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || composing || e.keyCode === 229 || !matchMedia('(pointer: fine)').matches) return;
        e.preventDefault(); if (!e.repeat) confirm.click();
      };
      const label = node('label');
      if (custom) label.append(node('span',`${custom+1}. Other${answer.customText !== null ? ' ✓' : ''}`));
      label.append(input); panel.append(label); footer.append(confirm); sync();
    }
    panel.append(footer);
    panel.scrollTop = 0;
    if (focus) heading.focus({preventScroll:true});
  }
  function render(ask, turn, locked) {
    panel.inert = locked;
    if (id === (ask?.id ?? null) && (!id || generation === turn)) return;
    id = ask?.id ?? null; generation = turn; composing = false;
    panel.hidden = !id;
    if (!id) { state = null; panel.replaceChildren(); return; }
    state = createAskState(ask.questions); paint(false);
  }
  function keydown(e) {
    if (!id || panel.inert || composing || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const text = e.target.localName === 'textarea', page = state.onSubmitTab ? state.questions.length : state.currentTab;
    const rows = [...panel.querySelectorAll(state.onSubmitTab ? '.ask-actions button' : '.ask-option,textarea')];
    const i = rows.indexOf(e.target);
    let run;
    if (e.key === 'Escape') run = stop;
    else if (state.questions.length > 1 && ((!text && ['ArrowLeft','ArrowRight'].includes(e.key)) || e.key === 'Tab')) {
      const next = page + (e.shiftKey || e.key === 'ArrowLeft' ? -1 : 1);
      if (next >= 0 && next <= state.questions.length) run = () => go(next);
    } else if (!text && ['ArrowUp','ArrowDown','j','k'].includes(e.key)) {
      run = () => rows[Math.max(0,Math.min(rows.length-1,i + (e.key === 'k' || e.key === 'ArrowUp' ? -1 : 1)))]?.focus();
    } else if (!text && !state.onSubmitTab && /^[1-9]$/.test(e.key)) {
      const row = rows[Number(e.key)-1]; if (row) run = () => row.localName === 'textarea' ? row.focus() : row.click();
    } else if (e.key === 'Enter' && !text && e.target.localName !== 'button') {
      const row = rows[state.onSubmitTab ? 0 : state.focusIndex]; if (row) run = () => row.localName === 'textarea' ? row.focus() : row.click();
    }
    if (run) { e.preventDefault(); if (!e.repeat) run(); }
  }
  return { render, keydown, interrupt:stop };
}
