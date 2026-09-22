// Runs inside the page. Installs window.__qavo once for each document.
// Plain JS read as text, so that no build tool rewrites the functions that run in the page.
(() => {
  if (window.__qavo) return;

  const TEXT_LIMIT = 6000;
  const ELEMENT_LIMIT = 250;
  const CONTEXT_LIMIT = 160;
  const ids = new WeakMap();
  const nodes = new Map();
  let nextId = 1;

  const indexOf = (e) => {
    if (!ids.has(e)) ids.set(e, nextId++);
    const index = ids.get(e);
    nodes.set(index, e);
    return index;
  };

  const ROLES = [
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton", "treeitem",
  ];
  const SELECTOR = [
    "a[href]", "button", "input", "textarea", "select", "summary", '[contenteditable="true"]', '[contenteditable=""]',
    ...ROLES.map((role) => `[role="${role}"]`),
  ].join(",");
  const TEXT_INPUT_TYPES = [
    "", "text", "email", "url", "tel", "password", "number", "search", "date", "time", "datetime-local", "month", "week",
  ];
  const EDITABLE_ROLES = ["textbox", "searchbox", "spinbutton", "combobox"];

  const roleOf = (e) => {
    const explicit = e.getAttribute("role");
    if (ROLES.includes(explicit)) return explicit;
    const tag = e.tagName;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "A") return "link";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (tag === "INPUT") {
      const type = e.getAttribute("type")?.toLowerCase() ?? "";
      if (type === "checkbox" || type === "radio") return type;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (e.list) return "combobox";
      if (TEXT_INPUT_TYPES.includes(type)) return "textbox";
    }
    return null;
  };

  const isEditable = (e, role) => {
    if (!EDITABLE_ROLES.includes(role)) return false;
    if (e.readOnly || e.getAttribute("aria-readonly") === "true") return false;
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") return true;
    return e.isContentEditable;
  };

  const isVisible = (e) =>
    !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    e.getClientRects().length > 0;

  const isDisabled = (e) => e.matches(":disabled") || !!e.closest('[aria-disabled="true"]');

  const topModal = () =>
    [...document.querySelectorAll('dialog:modal,[aria-modal="true"]')].filter(isVisible).at(-1) ?? null;

  const iconName = (e) => {
    const svg = e.querySelector("svg[class]");
    const match = svg?.getAttribute("class")?.match(/lucide-([a-z0-9-]+)/);
    return match ? `icon ${match[1].replaceAll("-", " ")}` : "";
  };

  const nameOf = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const labelledBy = (e.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => nameOf(document.getElementById(id), seen))
      .filter(Boolean)
      .join(" ");
    const fromLabels = [...(e.labels ?? [])].map((l) => nameOf(l, seen)).filter(Boolean).join(" ");
    const isInputButton = e.tagName === "INPUT" && ["button", "submit", "reset"].includes(e.type);
    const fromContent =
      e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA"
        ? ""
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === Node.TEXT_NODE
                ? n.textContent
                : n.nodeType === Node.ELEMENT_NODE && n.getAttribute("aria-hidden") !== "true"
                  ? nameOf(n, seen)
                  : "",
            )
            .join(" ");
    const name =
      labelledBy ||
      e.getAttribute("aria-label") ||
      fromLabels ||
      (isInputButton ? e.value : "") ||
      e.getAttribute("alt") ||
      fromContent.replace(/\s+/g, " ").trim() ||
      e.getAttribute("title") ||
      e.getAttribute("placeholder") ||
      "";
    return name.replace(/\s+/g, " ").trim();
  };

  const contextOf = (e) => {
    const scope = e.closest('tr,[role="row"],li,article,fieldset,[role="dialog"],dialog');
    if (!scope) return undefined;
    const text = scope.innerText.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, CONTEXT_LIMIT) : undefined;
  };

  const valueOf = (e, role) => {
    if (e.type === "password") return undefined;
    if (e.tagName === "SELECT") return [...e.selectedOptions].map((o) => o.label).join(", ");
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") {
      return ["checkbox", "radio"].includes(e.type) ? undefined : e.value;
    }
    if (e.isContentEditable || role === "combobox") return e.innerText.trim();
    return undefined;
  };

  const center = (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  };

  const inViewport = ({ x, y }) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;

  const isCovered = (e) => {
    const point = center(e);
    if (!inViewport(point)) return false;
    const hit = document.elementFromPoint(point.x, point.y);
    return !!hit && !e.contains(hit) && !(e.labels && [...e.labels].some((l) => l.contains(hit)));
  };

  // Returns every listed control. `covered` controls stay in the fingerprint, so that an overlay
  // that appears after a decision is refused as covered, not as a changed page.
  const readElements = () => {
    const modal = topModal();
    const elements = [];
    let omitted = 0;
    for (const e of document.querySelectorAll(SELECTOR)) {
      if (e.type === "hidden" || e.type === "file") continue;
      if (modal && !modal.contains(e)) continue;
      if (!isVisible(e) || isDisabled(e)) continue;
      const role = roleOf(e);
      if (!role) continue;
      const { width, height } = center(e);
      if (width <= 0 || height <= 0) continue;
      if (role === "gridcell" && e.querySelector('button,[role="button"],a[href]')) continue;
      if (elements.length >= ELEMENT_LIMIT) {
        omitted++;
        continue;
      }
      const element = { index: indexOf(e), role, name: nameOf(e) || iconName(e) || role };
      const value = valueOf(e, role);
      if (value !== undefined) element.value = value.slice(0, 200);
      if (e.type === "password") element.sensitive = true;
      if (e.type === "checkbox" || e.type === "radio") element.checked = e.checked;
      for (const state of ["checked", "selected", "expanded", "pressed"]) {
        const attribute = e.getAttribute(`aria-${state}`);
        if (attribute !== null) element[state] = attribute === "true" ? true : attribute === "false" ? false : attribute;
      }
      const haspopup = e.getAttribute("aria-haspopup");
      if (haspopup && haspopup !== "false") element.haspopup = haspopup === "true" ? "menu" : haspopup;
      const context = contextOf(e);
      if (context && context !== element.name) element.context = context;
      if (e.tagName === "SELECT") {
        element.operations = ["SELECT"];
        element.options = [...e.options]
          .filter((o) => !o.disabled && !o.closest("optgroup[disabled]"))
          .map((o) => ({ value: o.value, label: o.label }));
      } else if (isEditable(e, role)) {
        element.operations = role === "combobox" ? ["TYPE_TEXT", "CLICK"] : ["TYPE_TEXT"];
      } else {
        element.operations = ["CLICK"];
      }
      elements.push({ element, covered: isCovered(e) });
    }
    return { elements, omitted };
  };

  const readText = () => {
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && length < TEXT_LIMIT) {
      const value = node.textContent.replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (!value || !parent || parent.closest("script,style,noscript,template") || !isVisible(parent)) continue;
      parts.push(value);
      length += value.length + 1;
    }
    return parts.join("\n").slice(0, TEXT_LIMIT);
  };

  // FNV-1a, enough to compare two page states cheaply.
  const hash = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };

  const formValues = () =>
    [...document.querySelectorAll("input,textarea,select")]
      .filter((e) => e.type !== "password" && e.type !== "file")
      .map((e) => [indexOf(e), e.value, e.checked, e.selectedIndex]);

  const fingerprintOf = (elements) =>
    hash(JSON.stringify([location.href, formValues(), elements.map(({ element }) => element)]));

  const snapshot = () => {
    const { elements, omitted } = readElements();
    return {
      url: location.href,
      title: document.title,
      text: readText(),
      elements: elements.filter(({ covered }) => !covered).map(({ element }) => element),
      omitted,
      scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
      fingerprint: fingerprintOf(elements),
    };
  };

  const DATE_TYPES = ["date", "time", "datetime-local", "month", "week"];

  // Checks one stored node just before input. Returns the point to click, or the reason to refuse.
  const prepare = (index, operation, optionValue) => {
    const e = nodes.get(index);
    if (!e?.isConnected) return { refused: "missing" };
    if (!isVisible(e)) return { refused: "hidden" };
    if (isDisabled(e)) return { refused: "disabled" };
    if (operation === "TYPE_TEXT" && !isEditable(e, roleOf(e))) return { refused: "not_editable" };
    if (operation === "SELECT") {
      const option = e.tagName === "SELECT" && [...e.options].find((o) => o.value === optionValue);
      if (!option || option.disabled || option.closest("optgroup[disabled]")) return { refused: "option" };
    }
    if (!inViewport(center(e))) e.scrollIntoView({ block: "center", inline: "center" });
    if (isCovered(e)) return { refused: "covered" };
    const { x, y } = center(e);
    const link = e.closest("a[href]");
    return {
      x,
      y,
      href: link ? link.href : null,
      setValue: e.tagName === "INPUT" && DATE_TYPES.includes(e.type),
    };
  };

  const setValue = (index, value) => {
    const e = nodes.get(index);
    const prototype = e.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(e, value);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // Waits at least 2 animation frames or 50 ms. After text in a combobox, waits up to 200 ms for suggestions.
  const settle = (index, typed) =>
    new Promise((resolve) => {
      const field = nodes.get(index);
      const awaitSuggestions = typed && field?.getAttribute("role") === "combobox";
      let frames = 0;
      let finished = false;
      const finish = () => {
        finished = true;
        resolve();
      };
      setTimeout(finish, awaitSuggestions ? 200 : 50);
      const suggestionsVisible = () => {
        const ids = (field.getAttribute("aria-controls") || field.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean);
        const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];
        return roots.some((root) => [...root.querySelectorAll('[role="option"]')].some(isVisible));
      };
      const tick = () => {
        if (finished) return;
        if (++frames >= 2 && (!awaitSuggestions || suggestionsVisible())) finish();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  window.__qavo = {
    snapshot,
    fingerprint: () => fingerprintOf(readElements().elements),
    prepare,
    setValue,
    settle,
  };
})();
