// The in-app help: a short guide plus a reference of every toolbar control, generated
// from the toolbar itself (each control's label and its hover description), so the
// help cannot drift from the controls. The full guide is docs/user-guide.md.

/** A control's visible name: its label text without the values of its inputs. */
export function controlName(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const x of c.querySelectorAll("select, option, datalist, input, .spin, [id$='val'], .ico")) x.remove();
  return (c.textContent ?? "").replace(/\s+/g, " ").trim();
}

export interface HelpRow { group: string; name: string; tip: string }

/** Every described control of the toolbar, grouped as on screen. */
export function helpRows(bar: HTMLElement): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const grp of bar.querySelectorAll<HTMLElement>(".grp")) {
    const group = grp.getAttribute("aria-label") ?? "";
    for (const el of grp.querySelectorAll<HTMLElement>("label, button:not(.cap)")) {
      const tip = el.getAttribute("data-tip") ?? el.getAttribute("title")
        ?? el.querySelector("[data-tip], [title]")?.getAttribute("data-tip")
        ?? el.querySelector("[title]")?.getAttribute("title") ?? "";
      const name = controlName(el) || el.getAttribute("aria-label") || "";
      if (tip && name) rows.push({ group, name, tip });
    }
  }
  return rows;
}

export function renderHelp(host: HTMLElement, bar: HTMLElement): void {
  const table = document.createElement("table");
  let last = "";
  for (const r of helpRows(bar)) {
    if (r.group !== last) {
      const th = document.createElement("tr");
      const h = document.createElement("th");
      h.colSpan = 2;
      h.textContent = r.group;
      th.append(h);
      table.append(th);
      last = r.group;
    }
    const tr = document.createElement("tr");
    const a = document.createElement("td");
    a.textContent = r.name;
    const b = document.createElement("td");
    b.textContent = r.tip;
    tr.append(a, b);
    table.append(tr);
  }
  host.replaceChildren(table);
}
