/* Chat UI aligned with deepseek-harness conversation nodes:
 * session sidebar, assistant-step blocks (thinking/text/tools), turn tails,
 * and a workspace chip that only binds a directory for new sessions.
 */
import { streamChat } from "./chat-transport.js";
import { requestSteering, isQueuedCommand } from "./chat-control.js";
import { ChatState } from "./chat-state.js";
import { ChatStreamState } from "./chat-stream-state.js";
import { loginDeniedMessage } from "./login-errors.js";
import { esc, getJson, postJson, relTime, skeletonHtml, tierLabel, toast } from "./app.js";

const $ = (id) => document.getElementById(id);
const chat = $("chat");
const conversation = $("conversation");
const input = $("input");
const sendBtn = $("sendBtn");
const modelSelect = $("modelSelect");
const thinkingSelect = $("thinkingSelect");
const modelMenu = $("modelMenu");
const thinkingMenu = $("thinkingMenu");
const commandBtn = $("commandBtn");
const commandMenu = $("commandMenu");

let currentSessionId = null;
const runtime = new ChatState();
let directory = null;
let followOutput = true;
let scrollFrame = 0;
let workspace = { cwd: "", label: "Choose workspace", locked: false };
let currentModel = { provider: "", model: "" };
let currentThinking = "";
let thinkingDisabled = true;
let signedIn = false;

const sendIcon = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.31 1c.36.07.67.22.95.45.23.18.47.43.72.68l4.73 4.72-1.42 1.42L9 3.98V15H7V3.98L2.71 8.27 1.29 6.85l4.73-4.72c.25-.25.49-.5.72-.68.24-.2.55-.39.95-.45.21-.04.42-.03.62 0Z" fill="currentColor"/></svg>';
const stopIcon = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor"/></svg>';

function selectedModel() {
  return currentModel.provider && currentModel.model
    ? { provider: currentModel.provider, model: currentModel.model }
    : null;
}

function closeSeatMenus() {
  closeSeatMenu(modelSelect, modelMenu);
  closeSeatMenu(thinkingSelect, thinkingMenu);
}

function closeSeatMenu(trigger, menu) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

function openSeatMenu(trigger, menu) {
  if (trigger.disabled) return;
  closeCommandMenu();
  closeSeatMenus();
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  menu.querySelector("[aria-checked=\"true\"], button")?.focus();
}

function toggleSeatMenu(trigger, menu) {
  if (menu.hidden) openSeatMenu(trigger, menu);
  else closeSeatMenu(trigger, menu);
}

function onSeatMenuKeydown(event, trigger, menu) {
  const items = [...menu.querySelectorAll("button")];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSeatMenu(trigger, menu);
    trigger.focus();
  }
}

function thinkingLabel(level) {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : "Thinking";
}

function updatePrimary() {
  if (runtime.streaming) {
    sendBtn.innerHTML = stopIcon;
    sendBtn.setAttribute("aria-label", runtime.stopping ? "Stopping" : "Stop generating");
    sendBtn.title = runtime.stopping ? "Stopping" : "Stop generating";
    sendBtn.classList.add("stop");
    sendBtn.disabled = runtime.stopping;
    return;
  }
  sendBtn.innerHTML = sendIcon;
  sendBtn.setAttribute("aria-label", "Send message");
  sendBtn.title = "Send message";
  sendBtn.classList.remove("stop");
  sendBtn.disabled = !input.value.trim() || !selectedModel();
}

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 240) + "px";
  updatePrimary();
}

function modelEntry(provider, model) {
  if (!directory) return null;
  const group = directory.providers.find((item) => item.name === provider);
  return group?.models.find((item) => item.id === model) || null;
}

/**
 * Paint the thinking chip for the currently selected model.
 *
 * Preselection order: an explicit level the caller pins (the agent's live
 * selection on load), else the model's catalog default (`max` for
 * glm-5.3-flash), else medium when offered, else the first tier. Switching
 * models calls this without an explicit level, so a server-owned default
 * survives the switch instead of collapsing to the lowest tier.
 */
function renderThinking(preferred) {
  const selection = selectedModel();
  const entry = selection && modelEntry(selection.provider, selection.model);
  const levels = entry?.thinking_levels || [];
  const picker = $("thinkingPicker");
  if (!levels.length) {
    currentThinking = "";
    thinkingDisabled = true;
    thinkingSelect.disabled = true;
    $("thinkingLabel").textContent = "No thinking";
    thinkingMenu.innerHTML = "";
    closeSeatMenu(thinkingSelect, thinkingMenu);
    if (picker) picker.hidden = true;
    return;
  }
  const candidate = preferred ?? entry?.default_thinking_level;
  const wanted = levels.includes(candidate)
    ? candidate
    : levels.includes("medium")
      ? "medium"
      : levels[0];
  currentThinking = wanted;
  thinkingDisabled = false;
  thinkingSelect.disabled = runtime.streaming;
  $("thinkingLabel").textContent = thinkingLabel(wanted);
  if (picker) picker.hidden = false;
  thinkingMenu.innerHTML = levels.map((level) =>
    '<button type="button" role="option" data-thinking="' + esc(level) + '"' +
    (level === wanted ? ' aria-checked="true"' : "") + '>' +
    '<span class="seat-option-copy">' + esc(thinkingLabel(level)) + "</span>" +
    (level === wanted ? '<span class="seat-check" aria-hidden="true">\u2713</span>' : "") +
    "</button>").join("");
  thinkingMenu.querySelectorAll("[data-thinking]").forEach((button) => {
    button.addEventListener("click", () => chooseThinking(button.dataset.thinking));
  });
}

function chooseThinking(level) {
  currentThinking = level;
  $("thinkingLabel").textContent = thinkingLabel(level);
  closeSeatMenu(thinkingSelect, thinkingMenu);
  renderThinking(level);
}

function chooseModel(provider, model) {
  currentModel = { provider, model };
  $("modelLabel").textContent = model;
  closeSeatMenu(modelSelect, modelMenu);
  paintModelMenu();
  renderThinking();
  updatePrimary();
}

function modelGroups() {
  const groups = [];
  const groupKey = new Map();
  for (const provider of directory?.providers || []) {
    if (!provider.models?.length) continue;
    const key = provider.cloud ? "tier:" + tierLabel(provider.tier) : "name:" + provider.name;
    let group = groupKey.get(key);
    if (!group) {
      group = {
        label: provider.cloud ? tierLabel(provider.tier) : provider.name,
        cloud: Boolean(provider.cloud),
        items: [],
      };
      groupKey.set(key, group);
      groups.push(group);
    }
    for (const model of provider.models) {
      group.items.push({
        provider: provider.name,
        model: model.id,
        sort: model.sort_order || 0,
      });
    }
  }
  // A cloud tier merges every protocol provider, so its members rank
  // globally by the catalog sort_order instead of provider concatenation.
  // Array#sort is stable, so equal ranks keep the server's own order.
  for (const group of groups) {
    if (group.cloud) group.items.sort((a, b) => b.sort - a.sort);
  }
  return groups;
}

function paintModelMenu() {
  const groups = modelGroups();
  modelMenu.innerHTML = groups.map((group) =>
    '<div class="seat-group" role="group" aria-label="' + esc(group.label) + '">' +
    '<div class="seat-group-title">' + esc(group.label) + "</div>" +
    group.items.map((item) => {
      const selected = item.provider === currentModel.provider && item.model === currentModel.model;
      return '<button type="button" role="option" data-provider="' + esc(item.provider) +
        '" data-model="' + esc(item.model) + '"' +
        (selected ? ' aria-checked="true"' : "") + '>' +
        '<span class="seat-option-copy">' + esc(item.model) + "</span>" +
        (selected ? '<span class="seat-check" aria-hidden="true">\u2713</span>' : "") +
        "</button>";
    }).join("") +
    "</div>").join("");
  modelMenu.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", () => chooseModel(button.dataset.provider, button.dataset.model));
  });
  modelSelect.disabled = runtime.streaming || !groups.length;
}

async function loadOptions() {
  try {
    directory = await getJson("/api/chat/options");
    currentModel = {
      provider: directory.current?.provider || "",
      model: directory.current?.model || "",
    };
    if (!currentModel.provider || !currentModel.model) {
      const first = modelGroups()[0]?.items[0];
      if (first) currentModel = { provider: first.provider, model: first.model };
    }
    $("modelLabel").textContent = currentModel.model || "No models configured";
    paintModelMenu();
    renderThinking(directory.current?.thinking_level);
    autoResize();
  } catch (error) {
    currentModel = { provider: "", model: "" };
    $("modelLabel").textContent = "Models unavailable";
    modelSelect.disabled = true;
    modelMenu.innerHTML = "";
    toast(String(error.message || error), "err");
  }
}

function sessionLabel(session) {
  return session.custom_title || session.title || session.user_prompts?.[0] || "Untitled session";
}

function workspaceName(cwd) {
  if (!cwd) return "Choose workspace";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || cwd;
}

function setWorkspace(cwd, { locked = false } = {}) {
  workspace = { cwd: cwd || "", label: workspaceName(cwd), locked };
  const label = $("workspaceLabel");
  const chip = $("workspaceChip");
  if (label) label.textContent = workspace.label || "Choose workspace";
  if (chip) {
    chip.hidden = false;
    chip.disabled = locked;
    chip.title = workspace.cwd || "Choose a directory for this new chat";
  }
}

function setSession(id, meta = {}, { locked } = {}) {
  currentSessionId = id || null;
  const session = sessions.find((item) => item.session_id === id);
  const cwd = meta.cwd || session?.cwd || "";
  $("sessionTitle").textContent = meta.custom_title || meta.title || (session ? sessionLabel(session) : id ? "Session " + id.slice(0, 8) : "New chat");
  $("sessionMeta").textContent = cwd || (id ? id : "Start a new session");
  const trace = $("traceLink");
  trace.hidden = !id;
  if (id) {
    trace.href = "/sessions/" + encodeURIComponent(id) + "/trace";
    // A trace is a deep-dive surface; the conversation stays open here.
    trace.target = "_blank";
    trace.rel = "noopener";
  }
  const cwdLocked = locked ?? Boolean(id && cwd);
  setWorkspace(cwd || workspace.cwd, { locked: cwdLocked });
  renderRecent();
}

/** Sidebar paging: lightweight rows, one server page at a time. */
const RECENT_PAGE = 30;
let sessions = window.evotRail?.cachedSessions() || [];
let sessionsDone = false;
let sessionsLoading = false;
let sessionsQueuedReset = false;
let recentMoreEl = null;
let searchIndex = null;
let searchIndexLoading = false;

function showRecentMore() {
  const root = $("recentSessions");
  if (!recentMoreEl) {
    recentMoreEl = document.createElement("div");
    recentMoreEl.className = "recent-more";
    recentMoreEl.setAttribute("aria-hidden", "true");
    recentMoreEl.innerHTML = '<span class="sk sk-inline"></span>';
  }
  root.appendChild(recentMoreEl);
}

function hideRecentMore() {
  recentMoreEl?.remove();
}

function buildRecentRow(session) {
  const row = document.createElement("div");
  row.className = "recent-item" + (session.session_id === currentSessionId ? " active" : "");
  row.innerHTML =
    '<button type="button" class="recent-open" data-session="' + esc(session.session_id) + '">' +
    '<span class="recent-title">' + esc(sessionLabel(session)) + "</span>" +
    '<span class="recent-time">' + esc(relTime(session.updated_at)) + "</span></button>" +
    '<button type="button" class="recent-delete" data-recent-delete="' + esc(session.session_id) +
    '" aria-label="Delete session" title="Delete session">\u2715</button>';
  row.querySelector(".recent-open").addEventListener("click", () => resumeSession(session.session_id));
  row.querySelector(".recent-delete").addEventListener("click", (event) => {
    event.stopPropagation();
    deleteSessionFlow(event.currentTarget);
  });
  return row;
}

/** Fetch one page. `reset` re-reads page one (after sends and deletes). */
async function loadRecentPage({ reset = false } = {}) {
  if (sessionsLoading) {
    if (reset) sessionsQueuedReset = true;
    return;
  }
  if (!reset && sessionsDone) return;
  sessionsLoading = true;
  if (reset) sessionsDone = false;
  const offset = reset ? 0 : sessions.length;
  if (!reset) showRecentMore();
  try {
    const result = await getJson(
      "/api/sessions?limit=" + RECENT_PAGE + "&offset=" + offset,
    );
    const rows = Array.isArray(result?.items) ? result.items : [];
    sessionsDone = rows.length < RECENT_PAGE;
    if (reset) {
      sessions = rows;
      window.evotRail?.rememberSessions(rows);
    } else {
      const known = new Set(sessions.map((session) => session.session_id));
      for (const row of rows) {
        if (!known.has(row.session_id)) sessions.push(row);
      }
    }
    renderRecent();
  } catch {
    // Offline or erroring: keep whatever rows are already on screen.
  } finally {
    hideRecentMore();
    sessionsLoading = false;
    if (sessionsQueuedReset) {
      sessionsQueuedReset = false;
      void loadRecentPage({ reset: true });
    } else {
      maybeAutoFillRecent(); // lock dropped; short pages can ask for more
    }
  }
}

/** A viewport taller than page one would never fire the scroll listener. */
function maybeAutoFillRecent() {
  const root = $("recentSessions");
  if (!sessionsDone && !sessionsLoading && root.scrollHeight <= root.clientHeight + 1) {
    void loadRecentPage();
  }
}

function loadNextRecentPage() {
  void loadRecentPage();
}

/** Full-text index for search; loaded on first open, never for the list. */
async function ensureSearchIndex(force = false) {
  if (searchIndexLoading || (searchIndex && !force)) return;
  searchIndexLoading = true;
  try {
    const result = await getJson("/api/sessions?full=true");
    searchIndex = Array.isArray(result?.items) ? result.items : [];
    if ($("searchOverlay").classList.contains("open")) {
      searchActive = 0;
      renderSearch($("searchInput").value);
    }
  } catch {
    // Search just stays empty; the sidebar keeps working.
  } finally {
    searchIndexLoading = false;
  }
}

/** Keyed row reconcile: refetches reorder in place instead of wiping the list. */
const recentRows = new Map(); // session_id → { el, stamp }

function recentRowStamp(session) {
  return sessionLabel(session) + "\u0001" + relTime(session.updated_at);
}

function renderRecent() {
  const root = $("recentSessions");
  if (sessionsLoading && !sessions.length) {
    root.innerHTML = skeletonHtml(6);
    root.setAttribute("aria-busy", "true");
    return;
  }
  root.removeAttribute("aria-busy");
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    if (!session.session_id) continue;
    let entry = recentRows.get(session.session_id);
    if (!entry || entry.stamp !== recentRowStamp(session)) {
      entry?.el.remove();
      entry = { el: buildRecentRow(session), stamp: recentRowStamp(session) };
      recentRows.set(session.session_id, entry);
    }
    entry.el.classList.toggle("active", session.session_id === currentSessionId);
    fragment.appendChild(entry.el);
  }
  for (const [id, entry] of recentRows) {
    if (!sessions.some((session) => session.session_id === id)) {
      entry.el.remove();
      recentRows.delete(id);
    }
  }
  hideRecentMore();
  root.replaceChildren(fragment);
  if (!sessions.length) {
    root.innerHTML = '<div class="sidebar-empty">No conversations yet</div>';
  }
}

/**
 * Two-step destructive confirm. The first click arms the button (it turns
 * red and explains itself); a second click inside the window commits, and
 * clicking anywhere else, or waiting, disarms it.
 */
function armDestructive(button, commit) {
  if (button.classList.contains("armed")) {
    teardownArmed(button);
    commit();
    return;
  }
  button._restoreLabel = button.textContent;
  button._restoreTitle = button.title;
  button.classList.add("armed");
  button.textContent = "Delete?";
  button.title = "Click again to delete";
  const disarm = (event) => {
    if (event && event.target === button) return;
    teardownArmed(button);
  };
  button._disarm = disarm;
  document.addEventListener("pointerdown", disarm, true);
  button._armTimer = setTimeout(disarm, 3000);
}

function teardownArmed(button) {
  if (!button.classList.contains("armed")) return;
  button.classList.remove("armed");
  button.textContent = button._restoreLabel;
  button.title = button._restoreTitle;
  document.removeEventListener("pointerdown", button._disarm, true);
  clearTimeout(button._armTimer);
}

function deleteSessionFlow(button) {
  const id = button.dataset.recentDelete || button.dataset.searchDelete;
  armDestructive(button, () => void deleteSession(id));
}

async function deleteSession(id) {
  if (runtime.streaming && id === currentSessionId) {
    toast("Stop the running turn before deleting this session", "err");
    return;
  }
  try {
    const result = await postJson("/api/sessions/delete", { ids: [id] });
    if ((result.failed || []).length) {
      toast("Could not delete the session", "err");
      return;
    }
    sessions = sessions.filter((session) => session.session_id !== id);
    window.evotRail?.rememberSessions(sessions);
    if (Array.isArray(searchIndex)) {
      searchIndex = searchIndex.filter((session) => session.session_id !== id);
    }
    if (id === currentSessionId) returnToWelcome();
    renderRecent();
    if ($("searchOverlay").classList.contains("open")) renderSearch($("searchInput").value, true);
    toast("Session deleted");
  } catch (error) {
    toast(String(error.message || error), "err");
  }
}

/** Back to the empty hero: nothing selected, workspace unlocked again. */
function returnToWelcome() {
  hideTurnStatus();
  runtime.invalidateNavigation();
  setStats(null);
  setSession(null);
  closeContextPanel();
  conversation.classList.add("hero");
  chat.innerHTML = welcomeHtml();
  bindWelcome();
  jumpToBottom();
}

function welcomeHtml() {
  return '<div class="welcome" id="welcome"><div class="welcome-mark" aria-hidden="true">◆</div>' +
    '<h1>What can I help you build?</h1><p>Ask about this project, make a change, or continue a saved session.</p>' +
    '<button class="workspace-chip" id="workspaceChip" type="button" aria-haspopup="dialog">' +
    '<span class="workspace-folder" aria-hidden="true">⌂</span><span id="workspaceLabel">' +
    esc(workspace.label || "Choose workspace") + "</span></button>" +
    '<div class="suggestions">' +
    '<button type="button" data-prompt="Explain this codebase and its architecture">Explain this codebase</button>' +
    '<button type="button" data-prompt="Find the most important bugs to fix next">Find important bugs</button>' +
    '<button type="button" data-prompt="Run the relevant tests and summarize the result">Run relevant tests</button>' +
    "</div></div>";
}

function bindWelcome() {
  wireSuggestions();
  const chip = $("workspaceChip");
  const label = $("workspaceLabel");
  if (label) label.textContent = workspace.label || "Choose workspace";
  if (chip) {
    chip.disabled = workspace.locked;
    chip.title = workspace.cwd || "Choose a directory for this new chat";
    chip.addEventListener("click", openWorkspace);
  }
}

function newChat() {
  if (runtime.streaming) return;
  closeCommandMenu();
  closeWorkspace();
  // No draft session is created here: the session is born with the first
  // message, so every New — a cwd switch included — lands on the welcome
  // hero instead of a blank transcript.
  returnToWelcome();
  input.focus();
}

function escapeHtml(text) {
  return esc(String(text ?? ""));
}

/** Anchors are limited to web and mail schemes; anything else stays literal. */
function safeHref(href) {
  return /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(href);
}

/**
 * Inline spans over already-escaped text. Code spans are lifted out first so
 * their contents cannot pick up emphasis or link syntax.
 */
function renderInline(text) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (whole, label, href) => (safeHref(href)
      ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + (label || href) + "</a>"
      : whole),
  );
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => "<code>" + codes[Number(index)] + "</code>");
}

/** Fenced code with a language tag and its own copy button. */
function codeBlockHtml(code, lang) {
  return '<div class="code-block">' +
    '<div class="code-head"><span class="code-lang">' + escapeHtml(lang || "text") + "</span>" +
    '<button class="code-copy" type="button" data-copy-code aria-label="Copy code">⧉</button></div>' +
    "<pre><code>" + escapeHtml(code) + "</code></pre></div>";
}

/**
 * Block-level markdown: fenced code, ATX headings, quotes, rules, ordered and
 * bulleted lists, tables, and paragraphs. Streaming text arrives mid-token, so
 * an unterminated fence still renders as code rather than leaking its source.
 */
function renderMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push("<p>" + renderInline(paragraph.join("\n")).replace(/\n/g, "<br>") + "</p>");
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    out.push("<" + tag + ">" + list.items.map((item) => "<li>" + renderInline(item) + "</li>").join("") + "</" + tag + ">");
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*```+\s*(\S+)?\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i += 1;
      // An unclosed fence runs to the end: mid-stream text is still code.
      for (; i < lines.length && !/^\s*```+\s*$/.test(lines[i]); i += 1) body.push(lines[i]);
      out.push(codeBlockHtml(body.join("\n"), fence[1]));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + 1);
      out.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      out.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    // A pipe row followed by a delimiter row starts a table.
    if (line.includes("|") && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[i + 1] || "")) {
      flush();
      const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
      const head = cells(line);
      const rows = [];
      i += 2;
      for (; i < lines.length && lines[i].includes("|"); i += 1) rows.push(cells(lines[i]));
      i -= 1;
      out.push('<div class="table-wrap"><table><thead><tr>' +
        head.map((cell) => "<th>" + renderInline(cell) + "</th>").join("") +
        "</tr></thead><tbody>" +
        rows.map((row) => "<tr>" + row.map((cell) => "<td>" + renderInline(cell) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>");
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();
  return out.join("");
}

// ---------------------------------------------------------------------------
// Tool row model: variant, title, one-line summary, expandable IN/OUT
// ---------------------------------------------------------------------------

/** Engine tool names are lowercase, so this table keys on the wire name. */
const TOOL_VARIANTS = {
  bash: "bash",
  read: "read",
  web_fetch: "read",
  grep: "search",
  glob: "search",
  write: "write",
  edit: "edit",
};

const VARIANT_TITLES = {
  search: "Search",
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  others: "Tool call",
};

const VARIANT_ICONS = {
  search: "⌕",
  read: "▤",
  bash: ">_",
  write: "✎",
  edit: "✎",
  others: "◇",
};

/** Summary key preference per variant, mirroring the harness row model. */
const SUMMARY_KEYS = {
  bash: ["description", "command"],
  read: ["path", "file_path", "url"],
  search: ["query", "pattern", "patterns", "url"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  others: [],
};

const FILE_PATH_VARIANTS = new Set(["read", "write", "edit"]);

function classifyTool(name) {
  return TOOL_VARIANTS[name] || "others";
}

/** Display paths relative to the session workspace root. */
function relativizeToCwd(text) {
  const root = (workspace.cwd || "").replace(/[/\\]+$/, "");
  if (!root) return text;
  if (text.startsWith(root + "/") || text.startsWith(root + "\\")) {
    return text.slice(root.length + 1);
  }
  return text;
}

function pickString(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value)) {
      const joined = value.filter((v) => typeof v === "string" && v !== "");
      if (joined.length) return joined.join(", ");
    }
  }
  return undefined;
}

/** Tool args arrive either parsed or as a streaming JSON fragment. */
function toolArgs(data) {
  if (data.input && typeof data.input === "object") return data.input;
  const raw = data.delta || "";
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function deriveSummary(variant, data) {
  const args = toolArgs(data);
  if (!args) return firstLine(data.delta || "");
  const picked = pickString(args, SUMMARY_KEYS[variant] || []);
  if (picked !== undefined) return firstLine(picked);
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value !== "") return firstLine(value);
  }
  return "";
}

function deriveFilePath(variant, data) {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined;
  const args = toolArgs(data);
  if (!args) return undefined;
  const picked = pickString(args, ["path", "file_path"]);
  return picked === undefined ? undefined : firstLine(picked);
}

/** Args JSON for the expanded IN section; single-file tools show no body. */
function deriveBody(variant, data) {
  if (FILE_PATH_VARIANTS.has(variant)) return null;
  const args = toolArgs(data);
  if (args) return JSON.stringify(args, null, 2);
  return data.delta || null;
}

function toolRowModel(data) {
  const name = data.name || "";
  const variant = classifyTool(name);
  const state = data.is_error
    ? "error"
    : data.status === "done"
      ? "ok"
      : data.status === "error"
        ? "error"
        : "running";
  const base = relativizeToCwd(deriveSummary(variant, data));
  // `others` keeps the static title, so the real tool name rides the summary.
  const summary = variant === "others" && name
    ? (base ? name + " · " + base : name)
    : base;
  const output = data.content || null;
  return {
    variant,
    title: VARIANT_TITLES[variant],
    summary,
    filePath: deriveFilePath(variant, data),
    body: deriveBody(variant, data),
    output,
    // A failed row's collapsed summary is the failure's first line.
    errorSummary: state === "error" && output ? firstLine(output) : null,
    state,
  };
}

function isNearBottom() { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 96; }
function scheduleScroll(force = false) {
  if (force) followOutput = true;
  if (!followOutput || scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (followOutput) chat.scrollTop = chat.scrollHeight;
  });
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return (Math.round(seconds * 10) / 10) + "s";
  const whole = Math.round(seconds);
  return Math.floor(whole / 60) + "m" + (whole % 60) + "s";
}

/** Whole-second elapsed label for the running turn and the Ran-for tail. */
function formatRunDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? minutes + "m" + String(seconds).padStart(2, "0") + "s" : seconds + "s";
}

/** Sub-turn latency: one decimal under ten seconds, whole seconds beyond. */
function formatLatencySeconds(ms) {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 10 ? String(Math.round(seconds * 10) / 10) : String(Math.round(seconds));
}

/** Decode throughput: whole tokens from ten up, one decimal below. */
function formatTokensPerSecond(tps) {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return "";
  const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return scaled(n / 1000) + "K";
  return scaled(n / 1_000_000) + "M";
}

/** Same calendar day → HH:mm; earlier → M/D HH:mm, other years → Y/M/D HH:mm. */
function formatClock(time) {
  if (!Number.isFinite(time) || time <= 0) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const at = new Date(time);
  const now = new Date();
  const clock = pad(at.getHours()) + ":" + pad(at.getMinutes());
  if (at.toDateString() === now.toDateString()) return clock;
  const date = at.getFullYear() === now.getFullYear()
    ? (at.getMonth() + 1) + "/" + at.getDate()
    : at.getFullYear() + "/" + (at.getMonth() + 1) + "/" + at.getDate();
  return date + " " + clock;
}

function latestLine(text) {
  const visible = String(text || "").trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

function firstLine(text) {
  const visible = String(text || "");
  const newline = visible.indexOf("\n");
  return newline === -1 ? visible : visible.slice(0, newline);
}

/**
 * Append flow content, keeping the running-turn status as the last row.
 * Every row goes through here so the status never gets stranded mid-flow.
 */
function appendFlow(el) {
  const status = $("turnStatus");
  if (status) chat.insertBefore(el, status);
  else chat.appendChild(el);
}

function createAssistant() {
  const node = document.createElement("div");
  node.className = "message message-assistant";
  node.innerHTML = '<div class="step"></div><div class="turn-tail" hidden></div>';
  appendFlow(node);
  return {
    root: node,
    step: node.querySelector(".step"),
    tail: node.querySelector(".turn-tail"),
    blocks: new Map(),
    tools: new Map(),
    /** Per-call tool facts: the result event carries no args, so they merge. */
    toolFacts: new Map(),
    aborted: false,
    /** Turn facts merge from several nodes (settled blocks, call tail, run tail). */
    tailFacts: {},
  };
}

function blockEl(assistant, index, kind) {
  const key = kind + ":" + index;
  let el = assistant.blocks.get(key);
  if (el) return el;
  el = document.createElement("div");
  el.dataset.block = key;
  if (kind === "thinking") {
    el.className = "thinking-block";
    // Collapsed by default like the harness Think row: the summary line
    // carries the reasoning tail while it streams.
    el.innerHTML =
      '<button class="think-row" type="button" aria-expanded="false">' +
      '<span class="think-chevron" aria-hidden="true">▸</span>' +
      '<span class="think-label">Think</span>' +
      '<span class="think-sep" aria-hidden="true"></span>' +
      '<span class="think-summary"></span>' +
      "</button>" +
      '<div class="think-body" hidden></div>';
    const row = el.querySelector(".think-row");
    row.addEventListener("click", () => {
      const body = el.querySelector(".think-body");
      const open = body.hidden;
      body.hidden = !open;
      row.setAttribute("aria-expanded", String(open));
      el.querySelector(".think-chevron").textContent = open ? "▾" : "▸";
    });
  } else if (kind === "tool") {
    el.className = "tool-call";
  } else {
    el.className = "text-content";
  }
  assistant.step.appendChild(el);
  assistant.blocks.set(key, el);
  return el;
}

function paintThinking(el, text, running) {
  el.classList.toggle("running", running);
  const summary = el.querySelector(".think-summary");
  summary.textContent = running ? latestLine(text) : firstLine(text);
  // Keep the streaming tail in view inside the one-line summary.
  if (running) summary.scrollLeft = summary.scrollWidth;
  el.querySelector(".think-body").textContent = text;
}

/**
 * One-line tool summary with an expandable IN/OUT body.
 *
 * Tool nodes arrive repeatedly for the same call (args stream, then the
 * result), and the result event carries no args. Facts are merged per call id
 * so the IN section survives, and the reader's expand state is preserved.
 */
function paintTool(el, data, assistant) {
  const id = data.id || "";
  if (id) {
    el.id = "tool-" + id;
    assistant.tools.set(id, el);
  }
  // Merge onto what this call already reported instead of replacing it.
  const key = id || el.dataset.block || "";
  const previous = assistant.toolFacts.get(key) || {};
  const merged = {
    ...previous,
    ...data,
    name: data.name || previous.name,
    input: data.input ?? previous.input,
    delta: data.delta ?? previous.delta,
    content: data.content ?? previous.content,
  };
  assistant.toolFacts.set(key, merged);
  const model = toolRowModel(merged);
  const expandable = model.body !== null || model.output !== null;
  // Repaints must not collapse a row the reader opened.
  const wasOpen = el.dataset.open === "true";
  el.dataset.state = model.state;
  el.dataset.variant = model.variant;

  const summaryText = model.errorSummary ?? model.summary;
  const leading = model.state === "error" || model.state === "stopped"
    ? '<span class="tool-dot" data-state="' + model.state + '" aria-hidden="true"></span>'
    : '<span class="tool-icon" aria-hidden="true">' + escapeHtml(VARIANT_ICONS[model.variant]) + "</span>";

  el.innerHTML =
    '<div class="tool-row"' + (expandable ? ' role="button" tabindex="0"' : "") + ">" +
    '<span class="tool-chevron" aria-hidden="true">' + (expandable ? (wasOpen ? "▾" : "▸") : "") + "</span>" +
    leading +
    '<span class="tool-title">' + escapeHtml(model.title) + "</span>" +
    (summaryText
      ? '<span class="tool-sep" aria-hidden="true"></span>' +
        '<span class="tool-summary' + (model.errorSummary ? " error" : "") + '">' +
        escapeHtml(summaryText) + "</span>"
      : "") +
    "</div>" +
    (expandable
      ? '<div class="tool-body"' + (wasOpen ? "" : " hidden") + ">" +
        (model.body !== null
          ? '<div class="io-section"><span class="io-label">IN</span>' +
            '<pre class="io-text">' + escapeHtml(model.body) + "</pre></div>"
          : "") +
        (model.output !== null
          ? '<div class="io-section"><span class="io-label">OUT</span>' +
            '<pre class="io-text' + (model.state === "error" ? " error" : "") + '">' +
            escapeHtml(model.output) + "</pre></div>"
          : "") +
        "</div>"
      : "");

  if (!expandable) {
    delete el.dataset.open;
    return;
  }
  const row = el.querySelector(".tool-row");
  const body = el.querySelector(".tool-body");
  const toggle = () => {
    const open = body.hidden;
    body.hidden = !open;
    el.dataset.open = String(open);
    el.querySelector(".tool-chevron").textContent = open ? "▾" : "▸";
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
}

function paintText(el, text) {
  el.innerHTML = renderMarkdown(text);
  // Streaming repaints replace the subtree, so the copy handlers are rebound
  // here rather than delegated from a node that survives.
  el.querySelectorAll("[data-copy-code]").forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
      void navigator.clipboard.writeText(code).then(() => {
        button.textContent = "✓";
        button.classList.add("copied");
        setTimeout(() => {
          button.textContent = "⧉";
          button.classList.remove("copied");
        }, 1000);
      }, () => {});
    });
  });
}

function applyBlocks(assistant, blocks, { streaming: live = false } = {}) {
  (blocks || []).forEach((block, index) => {
    const kind = block.kind === "thinking" ? "thinking" : block.kind === "tool_call" ? "tool" : "text";
    const el = blockEl(assistant, block.id || index, kind);
    if (kind === "thinking") paintThinking(el, block.text || "", live && index === blocks.length - 1);
    else if (kind === "tool") paintTool(el, block, assistant);
    else paintText(el, block.text || "");
  });
}

// ---------------------------------------------------------------------------
// Session readings: stats line + context ring
// ---------------------------------------------------------------------------

/** Whole-session readings. Live runs fold into this; resume loads it whole. */
let stats = {};

function setStats(next) {
  stats = next ? { ...next } : {};
  renderStats();
}

/** Merge one completed call into the session readings. */
function foldStats(node) {
  const usage = node.usage || {};
  const metrics = node.metrics || {};
  stats.steps = (stats.steps || 0) + 1;
  const total = stats.usage || {};
  stats.usage = {
    input: (total.input || 0) + (usage.input || 0),
    output: (total.output || 0) + (usage.output || 0),
    cache_read: (total.cache_read || 0) + (usage.cache_read || 0),
    cache_write: (total.cache_write || 0) + (usage.cache_write || 0),
  };
  if (metrics.duration_ms) stats.llm_ms = (stats.llm_ms || 0) + metrics.duration_ms;
  if (metrics.ttft_ms) {
    stats.ttft_ms = (stats.ttft_ms || 0) + metrics.ttft_ms;
    stats.ttft_steps = (stats.ttft_steps || 0) + 1;
  }
  if (metrics.tokens_per_second && usage.output) {
    stats.decode_ms = (stats.decode_ms || 0) + (usage.output / metrics.tokens_per_second) * 1000;
    stats.decode_tokens = (stats.decode_tokens || 0) + usage.output;
  }
  if (node.turn !== undefined) stats.turns = Math.max(stats.turns || 0, node.turn);
  // The tail reports occupancy but not the system/tool split (only the
  // pre-request estimate knows it), so keep the last known breakdown.
  if (node.context) {
    const previous = stats.context || {};
    stats.context = {
      ...node.context,
      system: node.context.system ?? previous.system,
      tools: node.context.tools ?? previous.tools,
      messages: node.context.messages ?? previous.messages,
    };
  }
  renderStats();
}

/** Prompt-side billing buckets are disjoint, so they sum. */
function billedInput(usage) {
  return (usage.input || 0) + (usage.cache_read || 0) + (usage.cache_write || 0);
}

/** Pipe-separated groups; a group with no data drops out whole. */
function renderStats() {
  const line = $("statsLine");
  if (!line) return;
  const groups = [];
  if (stats.steps) {
    const turns = Math.max(stats.turns || 0, 1);
    groups.push(turns + (turns === 1 ? " turn" : " turns") + " · " + stats.steps +
      (stats.steps === 1 ? " step" : " steps"));
    const durations = [];
    if (stats.llm_ms) durations.push("LLM " + formatDuration(stats.llm_ms));
    if (stats.tool_ms) durations.push("Tools " + formatDuration(stats.tool_ms));
    if (durations.length) groups.push(durations.join(" · "));
    const speeds = [];
    if (stats.ttft_steps) {
      speeds.push("TTFT avg " + formatLatencySeconds(stats.ttft_ms / stats.ttft_steps) + "s");
    }
    if (stats.decode_ms) {
      speeds.push(formatTokensPerSecond(stats.decode_tokens / (stats.decode_ms / 1000)) + " tok/s");
    }
    if (speeds.length) groups.push(speeds.join(" · "));
  }
  const usage = stats.usage || {};
  if (billedInput(usage) > 0 || usage.output > 0) {
    const missed = (usage.input || 0) + (usage.cache_write || 0);
    if (billedInput(usage) > 0) {
      const hit = missed === 0 ? 100 : Math.round(((usage.cache_read || 0) / billedInput(usage)) * 100);
      groups.push(hit + "% cache hit");
    }
    groups.push(formatTokens(billedInput(usage)) + " in · " + formatTokens(usage.output || 0) + " out");
  }
  line.hidden = groups.length === 0;
  line.textContent = groups.join("  |  ");
  line.title = groups.join("  |  ");
  renderContextMeter();
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 5.5;

/** Occupancy ring beside Send, with a click-open breakdown panel. */
function renderContextMeter() {
  const meter = $("contextMeter");
  const fill = $("contextFill");
  const panel = $("contextPanel");
  if (!meter || !fill || !panel) return;
  const context = stats.context;
  if (!context || !context.window) {
    meter.hidden = true;
    panel.hidden = true;
    $("contextTrigger")?.setAttribute("aria-expanded", "false");
    return;
  }
  const percent = Math.min(100, context.percent ?? 0);
  meter.hidden = false;
  fill.setAttribute(
    "stroke-dasharray",
    (RING_CIRCUMFERENCE * percent) / 100 + " " + RING_CIRCUMFERENCE,
  );
  const label = percent + "% of context used";
  const trigger = $("contextTrigger");
  if (trigger) {
    trigger.setAttribute("aria-label", label);
    trigger.title = label;
  }
  const rows = [
    ["System prompt", context.system, "system"],
    ["Tools", context.tools, "tools"],
    ["Messages", context.messages, "messages"],
  ].filter(([, value]) => Number.isFinite(value));
  // The bar's overall length stays the exact reading; the breakdown only
  // proportions its parts. A zero-width part is dropped rather than drawn.
  const breakdownTotal = rows.reduce((sum, [, value]) => sum + value, 0);
  const segments = (breakdownTotal > 0
    ? rows.map(([, value, key]) => [key, (percent * value) / breakdownTotal])
    : [["total", percent]]
  ).filter(([, width]) => width > 0);
  panel.innerHTML =
    '<div class="context-head"><span class="context-percent">' + percent + "%</span>" +
    "<span>of context used</span>" +
    '<span class="context-figures">~' + formatTokens(context.used) + " / " +
    formatTokens(context.window) + "</span></div>" +
    '<div class="context-bar">' + segments.map(([key, width]) =>
      '<div class="context-segment" data-part="' + key + '" style="width:' + width + '%"></div>').join("") +
    "</div>" +
    (rows.length
      ? '<dl class="context-rows">' + rows.map(([name, value, key]) =>
        '<div><dt><span class="context-swatch" data-part="' + key + '" aria-hidden="true"></span>' +
        escapeHtml(name) + "</dt><dd>~" + formatTokens(value) + "</dd></div>").join("") + "</dl>"
      : "");
}

// ---------------------------------------------------------------------------
// Turn status: one signal for the whole running turn
// ---------------------------------------------------------------------------

let turnStatusTimer = 0;

/** Turn-level activity row; the clock only appears once a turn runs long. */
function showTurnStatus() {
  hideTurnStatus();
  const el = document.createElement("div");
  el.className = "turn-status";
  el.id = "turnStatus";
  el.setAttribute("role", "status");
  el.innerHTML = '<span class="turn-status-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
    "<span>Working…</span><span class=\"turn-status-clock\" hidden></span>";
  chat.appendChild(el);
  const startedAt = Date.now();
  const clock = el.querySelector(".turn-status-clock");
  turnStatusTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 15_000) return;
    clock.hidden = false;
    clock.textContent = formatRunDuration(elapsed);
  }, 1000);
  scheduleScroll(true);
}

function hideTurnStatus() {
  if (turnStatusTimer) clearInterval(turnStatusTimer);
  turnStatusTimer = 0;
  $("turnStatus")?.remove();
}

/** Copy button with the harness check-swap; shared by user and assistant rows. */
function copyButton(getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "msg-action";
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy");
  button.textContent = "⧉";
  let busy = false;
  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    void navigator.clipboard.writeText(getText()).then(
      () => {
        button.textContent = "✓";
        button.classList.add("copied");
        button.title = "Copied";
        button.setAttribute("aria-label", "Copied");
        setTimeout(() => {
          button.textContent = "⧉";
          button.classList.remove("copied");
          button.title = "Copy";
          button.setAttribute("aria-label", "Copy");
          busy = false;
        }, 1000);
      },
      () => { busy = false; },
    );
  });
  return button;
}

/** Assistant text of the settled blocks — what copy writes. */
function assistantText(blocks) {
  return (blocks || [])
    .filter((block) => block.kind === "text")
    .map((block) => block.text || "")
    .join("\n\n")
    .trim();
}

/**
 * Turn footer: clock, run duration, TTFT, throughput, then copy.
 * Facts arrive across several nodes, so each call merges into `tailFacts`
 * instead of replacing it.
 */
function applyTail(assistant, node) {
  const facts = assistant.tailFacts;
  const usage = node.usage || {};
  const metrics = node.metrics || {};
  if (node.time) facts.time = node.time;
  if (usage.output !== undefined || usage.input !== undefined) facts.usage = usage;
  if (metrics.duration_ms) facts.runMs = metrics.duration_ms;
  if (metrics.ttft_ms) facts.ttftMs = metrics.ttft_ms;
  if (metrics.tokens_per_second) facts.tokensPerSecond = metrics.tokens_per_second;
  if (node.stop_reason) facts.stopReason = node.stop_reason;
  if (node.blocks) facts.text = assistantText(node.blocks);

  const readings = [];
  const clock = formatClock(facts.time);
  if (clock) readings.push(clock);
  if (facts.stopReason === "aborted") readings.push("Stopped");
  if (facts.runMs) readings.push("Ran for " + formatRunDuration(facts.runMs));
  if (facts.ttftMs) readings.push("TTFT " + formatLatencySeconds(facts.ttftMs) + "s");
  if (facts.tokensPerSecond) {
    readings.push(formatTokensPerSecond(facts.tokensPerSecond) + " tok/s");
  }

  assistant.tail.hidden = false;
  assistant.tail.className = "turn-tail" + (facts.stopReason === "aborted" ? " stopped" : "");
  assistant.tail.innerHTML = "";
  assistant.tail.append(copyButton(() => facts.text || ""));
  if (readings.length) {
    const meta = document.createElement("span");
    meta.className = "tail-meta";
    meta.textContent = readings.join(" · ");
    assistant.tail.append(meta);
  }
}

function appendUser(text, time) {
  const node = document.createElement("div");
  node.className = "message message-user";
  const stack = document.createElement("div");
  stack.className = "user-stack";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const clock = formatClock(time);
  if (clock) {
    const stamp = document.createElement("span");
    stamp.className = "tail-meta";
    stamp.textContent = clock;
    actions.append(stamp);
  }
  actions.append(copyButton(() => text));
  stack.append(bubble, actions);
  node.append(stack);
  appendFlow(node);
}

/**
 * Optimistic bubble for a message queued onto the running turn. It carries no
 * clock (nothing durable has been written yet) and is replaced by the real
 * user node once the run admits it.
 *
 * @returns the element, so the caller can drop it if the queue request fails.
 */
function appendPendingSteering(text) {
  const node = document.createElement("div");
  node.className = "message message-user";
  node.dataset.pendingSteering = "true";
  const stack = document.createElement("div");
  stack.className = "user-stack";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const label = document.createElement("span");
  label.className = "tail-meta";
  label.textContent = "Queued";
  actions.append(label, copyButton(() => text));
  stack.append(bubble, actions);
  node.append(stack);
  appendFlow(node);
  scheduleScroll(true);
  return node;
}

/**
 * Mark every still-queued bubble as never delivered.
 *
 * Called when the run ends: the queue is per-run, so a message that was not
 * injected by then never reached the model.
 */
function abandonPendingSteering() {
  for (const node of chat.querySelectorAll('[data-pending-steering="true"]')) {
    node.dataset.pendingSteering = "abandoned";
    const label = node.querySelector(".msg-actions .tail-meta");
    if (label) label.textContent = "Not delivered";
  }
}

/**
 * Drop the pending marker from every queued bubble.
 *
 * The engine has no per-message admission event, so an injected-message count
 * is the signal that the queue drained into the conversation. Queued bubbles
 * have no durable clock of their own, so the label is simply removed.
 */
function settleAllPendingSteering() {
  for (const node of chat.querySelectorAll('[data-pending-steering="true"]')) {
    delete node.dataset.pendingSteering;
    node.querySelector(".msg-actions .tail-meta")?.remove();
  }
}

/**
 * Promote the optimistic bubble for `text` into a settled user message.
 *
 * @returns true when a pending bubble owned this text, so the caller does not
 * append a duplicate.
 */
function settlePendingSteering(text, time) {
  for (const node of chat.querySelectorAll('[data-pending-steering="true"]')) {
    if (node.querySelector(".bubble")?.textContent !== text) continue;
    delete node.dataset.pendingSteering;
    const actions = node.querySelector(".msg-actions");
    const label = actions?.querySelector(".tail-meta");
    const clock = formatClock(time);
    if (label) {
      if (clock) label.textContent = clock;
      else label.remove();
    }
    return true;
  }
  return false;
}

/** Compaction marker: collapsed by default, expandable when a summary exists. */
function appendCompact(node) {
  const el = document.createElement("div");
  el.className = "compact-card";
  const before = node.tokens_before || 0;
  const after = node.tokens_after || 0;
  const reading = before && after
    ? formatTokens(before) + " → " + formatTokens(after) + " tokens"
    : "Older turns were summarized.";
  const summary = node.summary || "";
  el.innerHTML =
    '<button class="compact-row" type="button"' + (summary ? ' aria-expanded="false"' : " disabled") + ">" +
    '<span class="compact-chevron" aria-hidden="true">' + (summary ? "▸" : "·") + "</span>" +
    '<span class="compact-label">Context compacted</span>' +
    '<span class="compact-sep" aria-hidden="true"></span>' +
    '<span class="compact-summary">' + escapeHtml(reading) + "</span>" +
    "</button>" +
    (summary ? '<div class="compact-body" hidden></div>' : "");
  if (summary) {
    const body = el.querySelector(".compact-body");
    body.textContent = summary;
    const row = el.querySelector(".compact-row");
    row.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      row.setAttribute("aria-expanded", String(open));
      el.querySelector(".compact-chevron").textContent = open ? "▾" : "▸";
    });
  }
  appendFlow(el);
}

/** Retry row with a live countdown while the delay is still running. */
function appendRetry(node) {
  const el = document.createElement("div");
  el.className = "retry-row";
  const attempt = node.attempt
    ? " (" + node.attempt + "/" + (node.max_retries ?? "∞") + ")"
    : "";
  const label = node.status === "waiting" ? "Waiting" : "Retrying";
  const text = document.createElement("span");
  text.setAttribute("role", "status");
  el.append(text);
  const deadline = Date.now() + (node.delay_ms || 0);
  const paint = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    text.textContent = label + attempt +
      (left > 0 ? " in " + left + "s" : "…") +
      (node.error ? " · " + node.error : "");
    return left;
  };
  if (paint() > 0) {
    const timer = setInterval(() => {
      if (paint() === 0 || !el.isConnected) clearInterval(timer);
    }, 250);
  }
  appendFlow(el);
}

/** Output-token cap is a turn outcome, not a failure. */
function appendMaxTokens() {
  const el = document.createElement("div");
  el.className = "notice-row warning";
  el.setAttribute("role", "status");
  el.innerHTML = "<strong>Reached the output limit</strong>" +
    "<span>The reply stopped at the model's max output tokens.</span>";
  appendFlow(el);
}

function appendError(text) {
  const el = document.createElement("div");
  el.className = "error-banner";
  el.textContent = text;
  appendFlow(el);
}

function renderTranscript(nodes) {
  conversation.classList.remove("hero");
  chat.innerHTML = "";
  let assistant = null;
  for (const node of nodes || []) {
    if (node.type === "user") {
      assistant = null;
      appendUser(node.text || "", node.time);
    } else if (node.type === "assistant") {
      assistant = createAssistant();
      applyBlocks(assistant, node.blocks);
      applyTail(assistant, node);
      if (node.error) appendError(node.error);
    } else if (node.type === "tool") {
      if (!assistant) assistant = createAssistant();
      const el = blockEl(assistant, node.id || assistant.tools.size, "tool");
      paintTool(el, node, assistant);
    } else if (node.type === "compact") {
      assistant = null;
      appendCompact(node);
    } else if (node.type === "retry") {
      appendRetry(node);
    } else if (node.type === "max_tokens") {
      appendMaxTokens();
    } else if (node.type === "error") {
      appendError(node.text || "Unknown error");
    }
  }
  scheduleScroll(true);
}

async function resumeSession(id) {
  const navigation = runtime.beginNavigation();
  if (navigation === null) return;
  closeSearch();
  try {
    const detail = await getJson("/api/sessions/" + encodeURIComponent(id));
    if (!runtime.ownsNavigation(navigation)) return;
    setSession(detail.session?.session_id || id, detail.session || {});
    if (!detail.nodes?.length) {
      conversation.classList.remove("hero");
      chat.innerHTML = '<div class="resume-note"><strong>Empty session</strong><span>Send a message to continue.</span></div>';
    } else {
      renderTranscript(detail.nodes);
    }
    // Stats are folded server-side because replay drops the Stats items.
    setStats(detail.stats || null);
  } catch (error) {
    if (!runtime.ownsNavigation(navigation)) return;
    toast(String(error.message || error), "err");
  }
  if (runtime.ownsNavigation(navigation)) input.focus();
}

function streamState() {
  return {
    assistant: null,
    content: new ChatStreamState(),
    renderFrame: 0,
  };
}

function flushStream(state) {
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  state.renderFrame = 0;
  if (!state.assistant) return;
  for (const [key, buffer] of state.content.buffers) {
    const [kind, index] = key.split(":");
    const el = blockEl(state.assistant, index, kind);
    if (kind === "thinking") paintThinking(el, buffer, true);
    else paintText(el, buffer);
  }
  scheduleScroll();
}

function scheduleFlush(state) {
  if (!state.renderFrame) {
    state.renderFrame = requestAnimationFrame(() => flushStream(state));
  }
}

function consumeNode(state, node) {
  if (node.type === "session") {
    runtime.bind(node.session_id);
    setSession(node.session_id, node);
    return;
  }
  if (node.type === "user") {
    // A queued message already has an optimistic bubble; the durable node
    // replaces it rather than adding a second copy of the same text.
    if (!settlePendingSteering(node.text || "", node.time)) {
      appendUser(node.text || "", node.time);
    }
    return;
  }
  if (node.type === "context") {
    // Pre-request estimate: the only place the system/tool split is known.
    stats.context = node.context;
    renderContextMeter();
    // Injected messages entered the conversation with this call, so any
    // queued bubble is now durable. The first call's injection is the initial
    // prompt, which has no pending bubble, so this is a no-op there.
    if (node.injected_count) settleAllPendingSteering();
    return;
  }
  if (node.type === "compact") {
    flushStream(state);
    appendCompact(node);
    state.assistant = null;
    state.content.resetAssistant();
    return;
  }
  if (node.type === "retry") {
    appendRetry(node);
    return;
  }
  if (node.type === "max_tokens") {
    appendMaxTokens();
    return;
  }
  if (node.type === "error") {
    appendError(node.text || node.error || "Unknown error");
    return;
  }
  if (!state.assistant) state.assistant = createAssistant();
  const assistant = state.assistant;
  if (node.type === "assistant" && node.status === "delta") {
    if (state.content.delta(node)) scheduleFlush(state);
    return;
  }
  if (node.type === "assistant" && (node.status === "settled" || node.status === "interrupted")) {
    flushStream(state);
    applyBlocks(assistant, node.blocks);
    // The settled node has no clock of its own on the live path; the turn
    // footer reads the arrival time so it matches the resumed transcript.
    applyTail(assistant, { ...node, time: node.time ?? Date.now() });
    state.content.settle(node);
    return;
  }
  if (node.type === "assistant" && (node.status === "tail" || node.status === "run")) {
    flushStream(state);
    if (state.content.acceptTail(node)) applyTail(assistant, node);
    // Every completed call reports occupancy and its own timings; fold them
    // into the session readings the composer shows.
    if (node.status === "tail") foldStats(node);
    return;
  }
  if (node.type === "tool") {
    flushStream(state);
    const el = blockEl(assistant, node.id || assistant.tools.size, "tool");
    paintTool(el, node, assistant);
    if (node.status === "done" || node.status === "error") {
      stats.tool_ms = (stats.tool_ms || 0) + (node.metrics?.duration_ms || 0);
      renderStats();
    }
    scheduleScroll();
  }
}

async function stopRun() {
  if (!runtime.streaming || runtime.stopping) return;
  const run = runtime.requestStop();
  if (!run) return;
  updatePrimary();
  const sessionId = runtime.sessionId || currentSessionId;
  if (!sessionId) {
    run.controller.abort();
    return;
  }
  try {
    await postJson("/api/chat/abort", { session_id: sessionId }, { keepalive: true });
  } catch {
    run.controller.abort();
  }
}

/** Queue onto the running turn; false when no run was active. */
async function steerRun(text) {
  const sessionId = runtime.sessionId || currentSessionId;
  if (!sessionId) return false;
  const generation = runtime.generation;
  const bubble = appendPendingSteering(text);
  const result = await requestSteering(postJson, sessionId, text);
  if (result.status === "inactive") {
    if (!runtime.canRestoreSubmission(generation, input.value)) {
      const label = bubble.querySelector(".msg-actions .tail-meta");
      if (label) label.textContent = "Not delivered · copy to retry";
      bubble.dataset.pendingSteering = "abandoned";
      return true;
    }
    // The server explicitly confirmed that the run was no longer active.
    bubble.remove();
    return false;
  }
  if (result.status === "uncertain") {
    // Preserve the text and copy action. A lost HTTP response does not prove
    // that the engine rejected it, so neither drop the draft nor auto-resend.
    const label = bubble.querySelector(".msg-actions .tail-meta");
    if (label && bubble.dataset.pendingSteering) label.textContent = "Delivery unconfirmed · copy to retry";
    toast(result.error, "err");
  }
  return true;
}

/** Submit: steer into the running turn, or start a new one. */
async function submitMessage() {
  const text = input.value.trim();
  if (!text) return;
  if (runtime.streaming) {
    if (isQueuedCommand(text)) {
      toast("Commands don't queue while a response is running. Stop it or wait for the turn to finish.", "err");
      return;
    }
    input.value = "";
    autoResize();
    // A run that ended mid-request falls back to a normal turn with the same
    // text rather than dropping it.
    if (!(await steerRun(text))) {
      input.value = text;
      autoResize();
      await sendMessage();
    }
    return;
  }
  await sendMessage();
}

async function sendMessage() {
  const text = input.value.trim();
  const selection = selectedModel();
  const thinkingLevel = thinkingDisabled ? null : currentThinking;
  if (!text || runtime.streaming || !selection) return;

  closeCommandMenu();
  closeSeatMenus();
  conversation.classList.remove("hero");
  $("welcome")?.remove();
  $(".resume-note")?.remove();
  appendUser(text, Date.now());
  input.value = "";
  const run = runtime.begin(currentSessionId);
  if (!run) return;
  modelSelect.disabled = true;
  thinkingSelect.disabled = true;
  autoResize();
  updatePrimary();

  const state = streamState();
  // One turn-level signal instead of a per-step placeholder: the assistant
  // row is created lazily by the first node that has something to show.
  showTurnStatus();

  const controller = run.controller;
  try {
    const payload = {
      message: text,
      session_id: currentSessionId,
      provider: selection.provider,
      model: selection.model,
      thinking_level: thinkingLevel,
    };
    if (!currentSessionId && workspace.cwd) payload.cwd = workspace.cwd;
    await streamChat(payload, {
      signal: controller.signal,
      onNode: (node) => { if (runtime.owns(run)) consumeNode(state, node); },
    });
    flushStream(state);
  } catch (error) {
    flushStream(state);
    hideTurnStatus();
    if (controller.signal.aborted && run.stopping) {
      // A dropped stream after Stop still owes the reader a settled footer.
      if (state.assistant) applyTail(state.assistant, { stop_reason: "aborted" });
    } else {
      appendError(String(error.message || error));
    }
  } finally {
    if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
    hideTurnStatus();
    // Anything still queued when the run ends was never admitted. Say so
    // rather than leaving it reading "Queued" forever; the copy action keeps
    // the text recoverable.
    abandonPendingSteering();
    runtime.finish(run);
    modelSelect.disabled = !selectedModel();
    renderThinking(currentThinking);
    autoResize();
    updatePrimary();
    input.focus({ preventScroll: true });
    await loadRecentPage({ reset: true });
    // Freshen search lazily: dropping the index makes the next ⌘K refetch
    // instead of re-parsing every transcript right after a run ends.
    searchIndex = null;
  }
}

function openCommandMenu() {
  closeSeatMenus();
  commandMenu.hidden = false;
  commandBtn.setAttribute("aria-expanded", "true");
  commandMenu.querySelector("button")?.focus();
}
function closeCommandMenu({ restoreFocus = false } = {}) {
  if (commandMenu.hidden) return;
  commandMenu.hidden = true;
  commandBtn.setAttribute("aria-expanded", "false");
  if (restoreFocus) input.focus({ preventScroll: true });
}
function toggleCommandMenu() {
  if (commandMenu.hidden) openCommandMenu();
  else closeCommandMenu({ restoreFocus: true });
}
function chooseCommand(command) {
  input.value = command || "";
  closeCommandMenu({ restoreFocus: true });
  input.setSelectionRange(input.value.length, input.value.length);
  autoResize();
}

// ---------------------------------------------------------------------------
// Session search: full-text over titles, paths, and transcript snippets
// ---------------------------------------------------------------------------

/** Current keyboard cursor within the rendered result rows. */
let searchActive = 0;

/**
 * Escape `text` and wrap the first occurrence of every token in <mark>.
 * Slicing happens on the raw string so escaping cannot shift offsets.
 */
function highlightTokens(text, tokens) {
  const raw = String(text || "");
  if (!tokens.length || !raw) return escapeHtml(raw);
  let first = raw.length;
  let token = "";
  for (const candidate of tokens) {
    const at = raw.toLowerCase().indexOf(candidate);
    if (at !== -1 && at < first) {
      first = at;
      token = candidate;
    }
  }
  if (first >= raw.length) return escapeHtml(raw);
  return escapeHtml(raw.slice(0, first)) +
    "<mark>" + escapeHtml(raw.slice(first, first + token.length)) + "</mark>" +
    escapeHtml(raw.slice(first + token.length));
}

/** Snippet around the first token hit, so the match is always in view. */
function snippetAround(text, tokens) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  let first = -1;
  let token = "";
  for (const candidate of tokens) {
    const at = raw.toLowerCase().indexOf(candidate);
    if (at !== -1 && (first === -1 || at < first)) {
      first = at;
      token = candidate;
    }
  }
  if (first === -1) return escapeHtml(raw.slice(0, 140)) + (raw.length > 140 ? "\u2026" : "");
  const window = 90;
  const start = Math.max(0, first - window / 2);
  const end = Math.min(raw.length, start + window + token.length);
  const body = highlightTokens(raw.slice(start, end), tokens);
  return (start > 0 ? "\u2026" : "") + body + (end < raw.length ? "\u2026" : "");
}

function openSearch() {
  closeCommandMenu();
  closeSeatMenus();
  closeWorkspace();
  closeAuthMenu();
  $("searchOverlay").classList.add("open");
  $("searchOverlay").setAttribute("aria-hidden", "false");
  $("searchInput").value = "";
  searchActive = 0;
  renderSearch("");
  void ensureSearchIndex();
  $("searchInput").focus();
}
function closeSearch() {
  $("searchOverlay").classList.remove("open");
  $("searchOverlay").setAttribute("aria-hidden", "true");
}

/**
 * Render full-text results. Every token must match somewhere (AND); title
 * matches outrank content-only matches; each row carries the serving path,
 * age, a match snippet, and the same armed delete as the sidebar.
 */
function renderSearch(query, keepCursor = false) {
  const root = $("searchResults");
  if (!Array.isArray(searchIndex)) {
    root.innerHTML = skeletonHtml(5);
    return;
  }
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = tokens.length
    ? searchIndex.filter((session) => {
        const haystack = (sessionLabel(session) + "\n" + (session.search_text || "")).toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
    : searchIndex.slice(0, 30);
  // Title hits first, then freshest; content-only matches follow.
  matches.sort((left, right) => {
    const score = (session) => {
      const title = sessionLabel(session).toLowerCase();
      return tokens.some((token) => title.includes(token)) ? 0 : 1;
    };
    return score(left) - score(right);
  });
  if (!keepCursor) searchActive = 0;
  searchActive = Math.min(searchActive, Math.max(0, matches.length - 1));

  if (!searchIndex.length) {
    root.innerHTML = '<div class="search-empty">No conversations yet</div>';
    return;
  }
  if (!matches.length) {
    root.innerHTML = '<div class="search-empty">Nothing matches \u201c' + escapeHtml(query.trim()) + '\u201d</div>';
    return;
  }
  const rows = matches.slice(0, 30).map((session, index) => {
    const id = esc(session.session_id);
    const snippetSource = (session.search_text || "").replace(sessionLabel(session), "");
    return '<div class="search-result' + (index === searchActive ? " active" : "") + '" data-result-index="' + index + '">' +
      '<button type="button" class="search-open" data-search-session="' + id + '">' +
      '<strong>' + highlightTokens(sessionLabel(session), tokens) + "</strong>" +
      '<span class="search-meta">' +
      '<span class="search-path">' + escapeHtml(session.cwd || "") + "</span>" +
      '<span class="search-age">' + esc(relTime(session.updated_at)) + "</span></span>" +
      '<span class="search-snippet">' + snippetAround(snippetSource, tokens) + "</span>" +
      "</button>" +
      '<button type="button" class="search-delete" data-search-delete="' + id +
      '" aria-label="Delete session" title="Delete session">\u2715</button>' +
      "</div>";
  }).join("");
  root.innerHTML = '<div class="search-count">' + matches.length +
    (matches.length === 1 ? " session" : " sessions") + "</div>" + rows;
  root.querySelectorAll("[data-search-session]").forEach((button) => {
    button.addEventListener("click", () => resumeSession(button.dataset.searchSession));
  });
  root.querySelectorAll("[data-search-delete]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSessionFlow(button);
    });
  });
}

/** Arrow-key cursor + Enter to open, matching command-menu conventions. */
function onSearchKeydown(event) {
  if (event.key === "Escape") {
    closeSearch();
    return;
  }
  const rows = [...$("searchResults").querySelectorAll(".search-result")];
  if (!rows.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    searchActive = (searchActive + step + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle("active", index === searchActive));
    rows[searchActive].scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    const row = rows[searchActive];
    row?.querySelector("[data-search-session]")?.click();
  }
}

/** Sidebar account row + notices + device login. */
let authMenu = null;
let loginTimer = 0;

async function refreshAuthBox() {
  const box = $("authBox");
  if (!box) return;
  try {
    const session = await getJson("/api/auth/session");
    signedIn = Boolean(session.logged_in);
    window.evotRail?.rememberAccount(session.logged_in ? { email: session.email || session.name || "Account" } : {});
    if (!signedIn && !selectedModel()) {
      // An empty picker becomes the login affordance.
      $("modelLabel").textContent = "Log in to load models";
      modelSelect.disabled = runtime.streaming;
    }
    box.innerHTML = session.logged_in
      ? '<button type="button" class="auth-row" id="authUser" title="Account">' +
        '<span class="ws-icon" aria-hidden="true">◉</span>' +
        '<span class="auth-email">' + esc(session.email || session.name || "Account") + "</span></button>"
      : '<button type="button" class="auth-row" id="loginBtn">' +
        '<span class="ws-icon" aria-hidden="true">→</span><span>Log in</span></button>';
    $("loginBtn")?.addEventListener("click", openLogin);
    $("authUser")?.addEventListener("click", openLoginMenuSignedIn);
  } catch {
    box.innerHTML = "";
  }
}

/**
 * Notices: a live ticker above the composer, mirroring the TUI ad slot —
 * title and body rendered as markdown on one flattened line, polled while
 * visible, scrolling when the line overflows.
 */
const NOTICE_POLL_MS = 20_000;
let lastNoticesHtml = null;

/**
 * Rendered markdown flattened to one ticker line: block rows, list items and
 * table cells become `·`-separated text. Structural tags drop, but inline
 * styling (strong, em, del, code) and links survive, so common markdown —
 * bold, italic, links like [EFF](https://eff.org) — reads as styled content.
 */
function flattenNoticeHtml(html) {
  const sep = '<span class="notice-sep" aria-hidden="true">·</span>';
  const flat = html
    .replace(/<div class="code-head">[\s\S]*?<\/div>/g, "")
    .replace(/<button[^>]*>[\s\S]*?<\/button>/g, "")
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|div|th|td|tr|table|thead|tbody|ul|ol)>|<(br|hr)\s*\/?>/g, "\u0001")
    .replace(/<\/?(:?p|h[1-6]|ul|ol|li|blockquote|pre|div|table|thead|tbody|tr|th|td)\b[^>]*>/g, "")
    .replace(/\u0001+/g, sep);
  return flat.endsWith(sep) ? flat.slice(0, -sep.length) : flat;
}

async function refreshNotices() {
  const slot = $("noticeSlot");
  if (!slot) return;
  let items;
  try {
    const result = await getJson("/api/notices");
    items = Array.isArray(result?.items) ? result.items : [];
  } catch {
    return; // keep whatever is already on screen
  }
  const chunks = items
    .map((notice) => {
      // TUI sourceMarkdown semantics: title and body render together, the
      // blank line between them flattening into the `·` separator.
      const title = String(notice.title || "").trim();
      const body = String(notice.body || "").trim();
      const source = title && body ? title + "\n\n" + body : title || body;
      if (!source) return "";
      const kind = notice.kind === "ad" ? " ad" : "";
      return '<span class="notice-chunk' + kind + '">' +
        flattenNoticeHtml(renderMarkdown(source)) + "</span>";
    })
    .filter(Boolean);
  const content = chunks.join("");
  const html = content
    ? '<div class="notice-banner"><div class="notice-track">' +
      '<span class="notice-copy">' + content + "</span></div></div>"
    : "";
  // Unchanged payload: keep the marquee mid-stride instead of restarting it.
  if (html === lastNoticesHtml) return;
  lastNoticesHtml = html;
  slot.innerHTML = html;
  const banner = slot.firstElementChild;
  const copy = banner?.querySelector(".notice-copy");
  if (!banner || !copy) return;
  // Marquee only what cannot fit: the copy is cloned once and the track
  // slides exactly one copy width per loop, so the seam is invisible.
  if (copy.getBoundingClientRect().width > banner.clientWidth - 26) {
    const echo = copy.cloneNode(true);
    echo.setAttribute("aria-hidden", "true");
    copy.parentElement.appendChild(echo);
    banner.classList.add("scroll");
    // Constant reading pace (~45 px/s) regardless of content length.
    banner.style.setProperty(
      "--notice-duration",
      Math.max(15, Math.round(copy.getBoundingClientRect().width / 45)) + "s",
    );
  }
}

function openLoginMenuSignedIn() {
  closeSeatMenus();
  closeCommandMenu();
  const box = $("authBox");
  if (!box) return;
  closeAuthMenu();
  authMenu = document.createElement("div");
  authMenu.className = "seat-menu auth-menu";
  authMenu.innerHTML =
    '<div class="workspace-note">Signed in on this device. Sign out removes cloud models here; your data stays on the server.</div>' +
    '<button type="button" role="menuitem" data-signout><span class="ws-icon" aria-hidden="true">⏻</span>' +
    '<span class="seat-option-copy">Sign out</span></button>';
  document.body.appendChild(authMenu);
  positionMenuAt(box, authMenu);
  authMenu.querySelector("[data-signout]").addEventListener("click", async () => {
    closeAuthMenu();
    try {
      await postJson("/api/auth/logout");
      toast("Signed out");
      await refreshAccountViews();
    } catch (error) {
      toast(String(error.message || error), "err");
    }
  });
}

/** Device login: start it, open the server URL, poll until it settles. */
async function openLogin() {
  if (authMenu) { closeAuthMenu(); return; }
  closeSeatMenus();
  closeCommandMenu();
  const box = $("authBox");
  if (!box) return;
  authMenu = document.createElement("div");
  authMenu.className = "seat-menu auth-menu";
  authMenu.innerHTML =
    '<div class="auth-code-row"><span class="sk sk-inline"></span></div>' +
    '<div class="workspace-note">Opening the login page…</div>';
  document.body.appendChild(authMenu);
  positionMenuAt(box, authMenu);
  let start;
  try {
    start = await postJson("/api/auth/login/start");
  } catch (error) {
    closeAuthMenu();
    toast(String(error.message || error), "err");
    return;
  }
  window.open(start.login_url, "_blank", "noopener");
  authMenu.innerHTML =
    '<div class="auth-code-row"><code class="auth-code">' + esc(start.code) + "</code></div>" +
    '<div class="workspace-note">Confirm the code on the login page' +
    ' — <a href="' + esc(start.login_url) + '" target="_blank" rel="noopener">open it again</a>.</div>' +
    '<div class="auth-wait" role="status">Waiting for approval…</div>';
  positionMenuAt(box, authMenu);
  const wait = authMenu.querySelector(".auth-wait");
  const interval = Math.max(1_500, Number(start.interval_ms) || 2_000);
  const poll = async () => {
    let result;
    try {
      result = await getJson("/api/auth/login/poll");
    } catch {
      loginTimer = window.setTimeout(poll, interval);
      return;
    }
    if (!authMenu) return; // closed by the user
    if (result.status === "pending") {
      if (wait) wait.textContent = "Waiting for approval…";
      loginTimer = window.setTimeout(poll, interval);
      return;
    }
    closeAuthMenu();
    if (result.status === "success") {
      toast("Logged in as " + (result.email || result.name || "account"));
      await refreshAccountViews();
      if (result.reload_error) toast("Model reload failed: " + result.reload_error, "err");
      else if (!result.providers) toast("No cloud models registered — restart evot once", "err");
    } else {
      toast(result.status === "denied" ? loginDeniedMessage(result) : "Login code expired", "err");
    }
  };
  loginTimer = window.setTimeout(poll, interval);
}

function closeAuthMenu() {
  window.clearTimeout(loginTimer);
  loginTimer = 0;
  authMenu?.remove();
  authMenu = null;
}

/** Post-login/-logout refresh: account row, notices, models, order. */
async function refreshAccountViews() {
  await Promise.all([refreshAuthBox(), refreshNotices(), loadOptions()]);
}

let workspaceMenu = null;

/** Distinct known directories, freshest session first. */
function recentWorkspacePaths() {
  const seen = new Set();
  const paths = [];
  for (const session of sessions) {
    if (!session.cwd || seen.has(session.cwd)) continue;
    seen.add(session.cwd);
    paths.push(session.cwd);
  }
  return paths.slice(0, 6);
}

function workspaceMenuHtml() {
  const rows = recentWorkspacePaths().map((path) =>
    '<button type="button" role="menuitemradio" data-workspace-path="' + esc(path) + '"' +
    (path === workspace.cwd ? ' aria-checked="true"' : "") + '>' +
    '<span class="ws-icon" aria-hidden="true">⌂</span>' +
    '<span class="seat-option-copy" title="' + esc(path) + '">' + esc(workspaceName(path)) + "</span>" +
    (path === workspace.cwd ? '<span class="seat-check" aria-hidden="true">\u2713</span>' : "") +
    "</button>").join("");
  return (rows
    ? '<div role="group" aria-label="Recent directories">' + rows + "</div>"
    : '') +
    '<button type="button" role="menuitem" data-workspace-add>' +
    '<span class="ws-icon" aria-hidden="true">＋</span>' +
    '<span class="seat-option-copy">Add a directory…</span></button>' +
    '<form id="workspaceForm" hidden>' +
    '<input id="workspaceInput" type="text" placeholder="/absolute/path or ~/project" autocomplete="off" spellcheck="false" />' +
    '</form>' +
    '<div class="workspace-note">Existing sessions keep their directory — this only applies to a new chat.</div>';
}

function positionMenuAt(anchor, menu) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  menu.style.width = width + "px";
  let top = rect.bottom + 8;
  if (top + menu.offsetHeight + 12 > window.innerHeight) {
    top = Math.max(8, rect.top - 8 - menu.offsetHeight);
  }
  menu.style.left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12) + "px";
  menu.style.top = top + "px";
}

function positionWorkspaceMenu() {
  const chip = $("workspaceChip") || $("newChat");
  if (!chip || !workspaceMenu) return;
  positionMenuAt(chip, workspaceMenu);
}

function openWorkspace() {
  if (workspace.locked || runtime.streaming) return;
  closeCommandMenu();
  closeSeatMenus();
  closeSearch();
  closeAuthMenu();
  if (!workspaceMenu) {
    workspaceMenu = document.createElement("div");
    workspaceMenu.id = "workspaceMenu";
    workspaceMenu.className = "seat-menu workspace-menu";
    workspaceMenu.setAttribute("role", "menu");
    workspaceMenu.setAttribute("aria-label", "Choose workspace");
    document.body.appendChild(workspaceMenu);
  }
  workspaceMenu.innerHTML = workspaceMenuHtml();
  workspaceMenu.hidden = false;
  positionWorkspaceMenu();
  workspaceMenu.querySelectorAll("[data-workspace-path]").forEach((button) => {
    button.addEventListener("click", () => applyWorkspace(button.dataset.workspacePath));
  });
  const add = workspaceMenu.querySelector("[data-workspace-add]");
  add?.addEventListener("click", () => {
    add.hidden = true;
    const form = $("workspaceForm");
    form.hidden = false;
    $("workspaceInput").focus();
  });
  $("workspaceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void applyWorkspace($("workspaceInput").value.trim());
  });
}

function closeWorkspace() {
  workspaceMenu?.remove();
  workspaceMenu = null;
}

async function applyWorkspace(path) {
  try {
    const result = await postJson("/api/workspace", { path });
    closeWorkspace();
    // The directory binds when the first message creates the session, so a
    // cwd switch just repaints the welcome hero with the new chip — and
    // stays unlocked for another switch.
    setWorkspace(result.cwd, { locked: false });
    returnToWelcome();
  } catch (error) {
    toast(String(error.message || error), "err");
  }
}

function wireSuggestions() {
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.prompt || "";
      autoResize();
      void sendMessage();
    });
  });
}

async function loadWorkspace() {
  try {
    const result = await getJson("/api/workspace");
    setWorkspace(result.cwd, { locked: false });
  } catch {
    setWorkspace("", { locked: false });
  }
}

function syncToBottom() {
  const button = $("toBottom");
  if (button) button.hidden = followOutput;
}

function jumpToBottom() {
  followOutput = true;
  chat.scrollTop = chat.scrollHeight;
  syncToBottom();
}

function closeContextPanel() {
  const panel = $("contextPanel");
  if (panel) panel.hidden = true;
  $("contextTrigger")?.setAttribute("aria-expanded", "false");
}

chat.addEventListener("scroll", () => {
  followOutput = isNearBottom();
  syncToBottom();
}, { passive: true });
$("toBottom").addEventListener("click", jumpToBottom);
$("contextTrigger").addEventListener("click", () => {
  const panel = $("contextPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  $("contextTrigger").setAttribute("aria-expanded", String(open));
});
input.addEventListener("input", autoResize);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    // Mid-run Enter queues onto the active turn instead of being dropped.
    void submitMessage();
  }
});
sendBtn.addEventListener("mousedown", (event) => event.preventDefault());
sendBtn.addEventListener("click", () => runtime.streaming ? void stopRun() : void sendMessage());
modelSelect.addEventListener("mousedown", (event) => event.preventDefault());
thinkingSelect.addEventListener("mousedown", (event) => event.preventDefault());
modelSelect.addEventListener("click", () => {
  if (!modelGroups().length && !signedIn) { openLogin(); return; }
  toggleSeatMenu(modelSelect, modelMenu);
});
thinkingSelect.addEventListener("click", () => toggleSeatMenu(thinkingSelect, thinkingMenu));
modelMenu.addEventListener("keydown", (event) => onSeatMenuKeydown(event, modelSelect, modelMenu));
thinkingMenu.addEventListener("keydown", (event) => onSeatMenuKeydown(event, thinkingSelect, thinkingMenu));
commandBtn.addEventListener("mousedown", (event) => event.preventDefault());
commandBtn.addEventListener("click", toggleCommandMenu);
commandMenu.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => chooseCommand(button.dataset.command));
});
commandMenu.addEventListener("keydown", (event) => {
  const items = [...commandMenu.querySelectorAll("button")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeCommandMenu({ restoreFocus: true });
  }
});
$("newChat").addEventListener("click", newChat);
$("openSearch").addEventListener("click", openSearch);
// Near the bottom of the recent list, render the next page in place.
$("recentSessions").addEventListener("scroll", () => {
  const el = $("recentSessions");
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 32) loadNextRecentPage();
}, { passive: true });
$("searchInput").addEventListener("input", (event) => renderSearch(event.target.value));
$("searchInput").addEventListener("keydown", onSearchKeydown);
$("searchOverlay").addEventListener("click", (event) => { if (event.target === $("searchOverlay")) closeSearch(); });
document.addEventListener("pointerdown", (event) => {
  if (!commandMenu.hidden && !event.target.closest(".command-picker")) closeCommandMenu();
  if (workspaceMenu && !event.target.closest("#workspaceMenu, #workspaceChip")) closeWorkspace();
  if (authMenu && !event.target.closest(".auth-menu, #authBox")) closeAuthMenu();
  if (!modelMenu.hidden && !event.target.closest("#modelPicker")) closeSeatMenu(modelSelect, modelMenu);
  if (!thinkingMenu.hidden && !event.target.closest("#thinkingPicker")) closeSeatMenu(thinkingSelect, thinkingMenu);
  if (!$("contextPanel").hidden && !event.target.closest(".context-meter")) closeContextPanel();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    closeSeatMenus();
    openSearch();
  } else if (event.key === "Escape") {
    if (!modelMenu.hidden || !thinkingMenu.hidden) {
      closeSeatMenus();
      return;
    }
    if (workspaceMenu) {
      closeWorkspace();
      return;
    }
    if (authMenu) {
      closeAuthMenu();
      return;
    }
    if (!$("contextPanel").hidden) closeContextPanel();
  }
});

// bindWelcome wires the suggestions itself; calling both would fire a
// suggestion twice.
bindWelcome();
updatePrimary();
if (sessions.length) renderRecent();
await Promise.all([loadOptions(), loadRecentPage({ reset: true }), loadWorkspace(), refreshAuthBox(), refreshNotices()]);
// Notices stay live: polled while the tab is visible, and refetched the
// moment it comes back, like the TUI slot reacting to cache refreshes.
window.setInterval(() => { if (!document.hidden) void refreshNotices(); }, NOTICE_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshNotices();
});
// Deep link back from a trace page: /chat?session=<id> reopens that session.
const wantedSession = new URLSearchParams(location.search).get("session");
if (wantedSession) await resumeSession(wantedSession);
// Search from another page's rail lands here.
if (new URLSearchParams(location.search).get("search") === "1") openSearch();
input.focus();
