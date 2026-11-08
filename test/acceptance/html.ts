// Just enough HTML reading for the board driver to use entail's pages the way
// a browser does without script: find links and forms, read each control and
// the text of its label, and build the submission a click would send.

export interface Control {
  tag: "input" | "textarea" | "select" | "button";
  type: string;
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  /** The control's label: its `<label>`, or a button's text. */
  label: string;
  placeholder: string;
  /** Options of a `<select>`, value and text. */
  options: { value: string; text: string; selected: boolean }[];
}

export interface Form {
  action: string;
  method: string;
  controls: Control[];
  /** Where the form starts in the page, to find what comes before it. */
  offset: number;
}

export interface Link {
  href: string;
  text: string;
  offset: number;
}

export interface Page {
  forms: Form[];
  links: Link[];
  /** The page's text without tags, entities decoded. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    result.set(match[1]!.toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return result;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Token {
  kind: "open" | "close" | "text";
  name: string;
  attrs: Map<string, string>;
  text: string;
  offset: number;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  let rawUntil: string | undefined;
  for (const match of source.matchAll(pattern)) {
    const offset = match.index;
    if (match[4] !== undefined) {
      if (!rawUntil) tokens.push({ kind: "text", name: "", attrs: new Map(), text: decodeEntities(match[4]), offset });
      continue;
    }
    const name = match[2]!.toLowerCase();
    if (rawUntil) {
      if (match[1] && name === rawUntil) rawUntil = undefined;
      continue;
    }
    if (match[1]) {
      tokens.push({ kind: "close", name, attrs: new Map(), text: "", offset });
    } else {
      tokens.push({ kind: "open", name, attrs: attributes(match[3] ?? ""), text: "", offset });
      if (name === "script" || name === "style") rawUntil = name;
    }
  }
  return tokens;
}

/** Reads the links and forms of a page. */
export function parsePage(html: string): Page {
  const tokens = tokenize(html);
  const forms: Form[] = [];
  const links: Link[] = [];
  const labelsFor = new Map<string, string>();
  const idOf = new Map<Control, string>();
  let text = "";

  let form: Form | undefined;
  const openLabels: { forId: string | undefined; text: string; controls: Control[] }[] = [];
  let link: Link | undefined;
  let textControl: { control: Control; text: string } | undefined;
  let select: Control | undefined;
  let option: { value: string | undefined; text: string; selected: boolean } | undefined;

  const addControl = (control: Control, attrs: Map<string, string>) => {
    if (form) form.controls.push(control);
    const id = attrs.get("id");
    if (id) idOf.set(control, id);
    openLabels.at(-1)?.controls.push(control);
  };

  for (const token of tokens) {
    if (token.kind === "text") {
      text += token.text;
      for (const label of openLabels) label.text += token.text;
      if (link) link.text += token.text;
      if (textControl) textControl.text += token.text;
      if (option) option.text += token.text;
      continue;
    }
    const { name, attrs } = token;
    if (token.kind === "open") {
      if (["p", "div", "li", "br", "h1", "h2", "h3", "h4", "tr", "section", "article"].includes(name)) text += "\n";
      switch (name) {
        case "form":
          form = { action: attrs.get("action") ?? "", method: (attrs.get("method") ?? "get").toLowerCase(), controls: [], offset: token.offset };
          forms.push(form);
          break;
        case "a":
          link = { href: attrs.get("href") ?? "", text: "", offset: token.offset };
          break;
        case "label":
          openLabels.push({ forId: attrs.get("for"), text: "", controls: [] });
          break;
        case "input": {
          const type = (attrs.get("type") ?? "text").toLowerCase();
          addControl(
            {
              tag: "input",
              type,
              name: attrs.get("name") ?? "",
              value: attrs.get("value") ?? (type === "checkbox" || type === "radio" ? "on" : ""),
              checked: attrs.has("checked"),
              disabled: attrs.has("disabled"),
              label: type === "submit" ? (attrs.get("value") ?? "") : "",
              placeholder: attrs.get("placeholder") ?? "",
              options: [],
            },
            attrs,
          );
          break;
        }
        case "textarea":
        case "button": {
          const control: Control = {
            tag: name,
            type: name === "button" ? (attrs.get("type") ?? "submit").toLowerCase() : "textarea",
            name: attrs.get("name") ?? "",
            value: attrs.get("value") ?? "",
            checked: false,
            disabled: attrs.has("disabled"),
            label: "",
            placeholder: attrs.get("placeholder") ?? "",
            options: [],
          };
          addControl(control, attrs);
          textControl = { control, text: "" };
          break;
        }
        case "select":
          select = {
            tag: "select",
            type: "select",
            name: attrs.get("name") ?? "",
            value: "",
            checked: false,
            disabled: attrs.has("disabled"),
            label: "",
            placeholder: "",
            options: [],
          };
          addControl(select, attrs);
          break;
        case "option":
          option = { value: attrs.get("value"), text: "", selected: attrs.has("selected") };
          break;
      }
      continue;
    }
    switch (name) {
      case "form":
        form = undefined;
        break;
      case "a":
        if (link) links.push({ ...link, text: squash(link.text) });
        link = undefined;
        break;
      case "label": {
        const label = openLabels.pop();
        if (!label) break;
        const labelText = squash(label.text);
        if (label.forId) labelsFor.set(label.forId, labelText);
        for (const control of label.controls) control.label ||= labelText;
        if (openLabels.at(-1)) openLabels.at(-1)!.text += label.text;
        break;
      }
      case "textarea":
      case "button":
        if (textControl) {
          if (name === "textarea") textControl.control.value = textControl.text.replace(/^\n/, "");
          else textControl.control.label = squash(textControl.text) || textControl.control.value;
        }
        textControl = undefined;
        break;
      case "option":
        if (select && option) {
          select.options.push({ value: option.value ?? squash(option.text), text: squash(option.text), selected: option.selected });
        }
        option = undefined;
        break;
      case "select":
        if (select) select.value = (select.options.find((o) => o.selected) ?? select.options[0])?.value ?? "";
        select = undefined;
        break;
    }
  }
  for (const [control, id] of idOf) {
    const label = labelsFor.get(id);
    if (label && !control.label) control.label = label;
  }
  return { forms, links, text: text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim() };
}

/**
 * The fields a form submits when one of its buttons is clicked: every enabled,
 * named control that is successful in a browser, plus the clicked button.
 */
export function formData(form: Form, submitter?: Control): URLSearchParams {
  const data = new URLSearchParams();
  for (const control of form.controls) {
    if (!control.name || control.disabled) continue;
    if (control.tag === "button" || control.type === "submit" || control.type === "image" || control.type === "reset") {
      if (control === submitter) data.append(control.name, control.value);
      continue;
    }
    if ((control.type === "checkbox" || control.type === "radio") && !control.checked) continue;
    if (control.type === "file") continue;
    data.append(control.name, control.value);
  }
  return data;
}

/** The form's submit buttons. */
export function submitButtons(form: Form): Control[] {
  return form.controls.filter(
    (c) => (c.tag === "button" && c.type === "submit") || (c.tag === "input" && (c.type === "submit" || c.type === "image")),
  );
}
