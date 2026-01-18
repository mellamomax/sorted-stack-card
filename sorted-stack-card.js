/* sorted-stack-card.js
 * Custom Lovelace card: custom:sorted-stack-card
 *
 * Features:
 * - direction: vertical|horizontal
 * - wrap: true|false (for horizontal)
 * - gap: number (px)
 * - sort: by entity_id|name|state|last_changed|last_updated|attribute
 * - sort.order: asc|desc
 * - sort.numeric: true|false
 * - sort.attribute: e.g. "attributes.battery_level" or "attributes.foo.bar"
 * - sort.locale: default "sv-SE"
 * - sort.case_insensitive: default true
 * - cards: [ ... ]
 * - groups: [{ main: {...}, cards: [...], sort_override?: {...} }]
 */

const CARD_TAG = "sorted-stack-card";

class SortedStackCard extends HTMLElement {
  setConfig(config) {
    if (!config || (config.cards == null && config.groups == null)) {
      throw new Error("sorted-stack-card: You must provide 'cards' or 'groups'.");
    }

    this._config = Object.assign(
      {
        direction: "vertical",
        wrap: false,
        gap: 8,
        sort: {
          by: "entity_id",
          order: "asc",
          numeric: false,
          locale: "sv-SE",
          case_insensitive: true,
        },
      },
      config
    );

    // Normalize sort object
    this._config.sort = Object.assign(
      {
        by: "entity_id",
        order: "asc",
        numeric: false,
        locale: "sv-SE",
        case_insensitive: true,
      },
      this._config.sort || {}
    );

    this._built = false;
    this._helpersPromise = null;
    this._cardCache = new WeakMap(); // cfg-object -> element
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._render();
  }

  getCardSize() {
    // Rough estimate; Lovelace uses it only for some layout decisions.
    return 3;
  }

  _build() {
    this._built = true;

    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const gap = Number(this._config.gap) || 0;

    this.shadowRoot.innerHTML = `
      <style>
        .stack {
          display: flex;
          flex-direction: column;
          gap: ${gap}px;
          width: 100%;
        }
        .horiz {
          flex-direction: row;
          align-items: stretch;
        }
        .wrap {
          flex-wrap: wrap;
        }
        .item {
          min-width: 0;
        }
      </style>
      <div class="stack"></div>
    `;

    this._root = this.shadowRoot.querySelector(".stack");
  }

  _ensureHelpers() {
    if (this._helpersPromise) return this._helpersPromise;

    // loadCardHelpers exists in HA frontend
    if (window.loadCardHelpers) {
      this._helpersPromise = window.loadCardHelpers();
      return this._helpersPromise;
    }

    this._helpersPromise = Promise.resolve(null);
    return this._helpersPromise;
  }

  _setLayoutClasses() {
    if (!this._root) return;
    const isHoriz = this._config.direction === "horizontal";
    this._root.classList.toggle("horiz", isHoriz);
    this._root.classList.toggle("wrap", !!this._config.wrap && isHoriz);
  }

  _getEntityFromCardConfig(cardCfg) {
    // 1) Most common: cardCfg.entity
    if (cardCfg && typeof cardCfg.entity === "string" && cardCfg.entity) return cardCfg.entity;

    // 2) entities card: first entity
    const ents = cardCfg && cardCfg.entities;
    if (Array.isArray(ents) && ents.length) {
      const first = ents[0];
      if (typeof first === "string") return first;
      if (first && typeof first.entity === "string") return first.entity;
    }

    // 3) fallback: sort.entity (default entity)
    const sortEntity = this._config?.sort?.entity;
    if (typeof sortEntity === "string" && sortEntity) return sortEntity;

    return null;
  }

  _readAttributePath(obj, pathStr) {
    if (!pathStr) return undefined;
    const parts = pathStr.split(".").filter(Boolean);
    let v = obj;
    for (const p of parts) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }

  _getSortValue(cardCfg, sortCfg) {
    const by = (sortCfg && sortCfg.by) || "entity_id";

    const entityId = (sortCfg && sortCfg.entity) || this._getEntityFromCardConfig(cardCfg);
    const st = entityId ? this._hass?.states?.[entityId] : null;

    if (by === "entity_id") return entityId || "";

    // If no state available, push down in sort by returning empty/zero
    if (!st) {
      if (by === "last_changed" || by === "last_updated") return 0;
      return "";
    }

    if (by === "name") {
      // prefer explicit card name, else friendly_name, else entityId
      return (cardCfg?.name ?? st.attributes?.friendly_name ?? entityId ?? "") || "";
    }

    if (by === "state") return st.state ?? "";

    if (by === "last_changed") return new Date(st.last_changed).getTime() || 0;
    if (by === "last_updated") return new Date(st.last_updated).getTime() || 0;

    if (by === "attribute") {
      const attrPath = sortCfg?.attribute || this._config?.sort?.attribute || "";
      // support "attributes.xxx" as well as "xxx" (we'll try both)
      let v = this._readAttributePath(st, attrPath);
      if (v === undefined && !attrPath.startsWith("attributes.")) {
        v = this._readAttributePath(st, "attributes." + attrPath);
      }
      return v ?? "";
    }

    return "";
  }

  _compare(a, b, sortCfg) {
    const numeric = !!sortCfg?.numeric;
    const orderDesc = (sortCfg?.order || "asc") === "desc";
    const ci = sortCfg?.case_insensitive ?? true;
    const locale = sortCfg?.locale || "sv-SE";

    let av = a.value;
    let bv = b.value;

    // Handle nulls consistently
    if (av == null) av = numeric ? -Infinity : "";
    if (bv == null) bv = numeric ? -Infinity : "";

    if (numeric) {
      const an = Number(av);
      const bn = Number(bv);
      const aa = Number.isFinite(an) ? an : -Infinity;
      const bb = Number.isFinite(bn) ? bn : -Infinity;
      const res = aa - bb;
      return orderDesc ? -res : res;
    }

    av = String(av);
    bv = String(bv);
    if (ci) {
      av = av.toLowerCase();
      bv = bv.toLowerCase();
    }

    const res = av.localeCompare(bv, locale, { numeric: true, sensitivity: "base" });
    return orderDesc ? -res : res;
  }

  async _createCardElement(cardCfg) {
    const helpers = await this._ensureHelpers();
    if (!helpers) {
      const err = document.createElement("hui-error-card");
      err.setConfig({
        type: "error",
        error: "sorted-stack-card: Card helpers not available.",
      });
      return err;
    }
    const el = helpers.createCardElement(cardCfg);
    return el;
  }

  async _getOrCreateElement(cardCfg) {
    // Cache per object identity (works well in Lovelace)
    const cached = this._cardCache.get(cardCfg);
    if (cached) return cached;

    const el = await this._createCardElement(cardCfg);
    this._cardCache.set(cardCfg, el);
    return el;
  }

  async _renderFlatCards() {
    const sortCfg = this._config.sort || { by: "entity_id", order: "asc" };
    const items = (this._config.cards || []).map((cfg) => ({
      cfg,
      value: this._getSortValue(cfg, sortCfg),
    }));

    items.sort((a, b) => this._compare(a, b, sortCfg));

    const els = [];
    for (const it of items) {
      const el = await this._getOrCreateElement(it.cfg);
      el.hass = this._hass;
      el.classList?.add("item");
      els.push(el);
    }
    this._root.replaceChildren(...els);
  }

  async _renderGroups() {
    const globalSort = this._config.sort || { by: "entity_id", order: "asc" };

    const groupItems = (this._config.groups || []).map((g) => ({
      group: g,
      value: this._getSortValue(g.main, globalSort),
    }));

    groupItems.sort((a, b) => this._compare(a, b, globalSort));

    const out = [];

    for (const gi of groupItems) {
      const g = gi.group;

      // main card
      const mainEl = await this._getOrCreateElement(g.main);
      mainEl.hass = this._hass;
      mainEl.classList?.add("item");
      out.push(mainEl);

      // subcards
      const innerSort = g.sort_override ? Object.assign({}, globalSort, g.sort_override) : null;
      const effectiveSort = innerSort || globalSort;

      const subItems = (g.cards || []).map((cfg) => ({
        cfg,
        value: this._getSortValue(cfg, effectiveSort),
      }));

      // only sort subs if sort_override present, otherwise keep the provided order
      if (innerSort) subItems.sort((a, b) => this._compare(a, b, effectiveSort));

      for (const si of subItems) {
        const el = await this._getOrCreateElement(si.cfg);
        el.hass = this._hass;
        el.classList?.add("item");
        out.push(el);
      }
    }

    this._root.replaceChildren(...out);
  }

  async _render() {
    if (!this._root || !this._hass) return;

    this._setLayoutClasses();

    try {
      if (this._config.cards) {
        await this._renderFlatCards();
      } else if (this._config.groups) {
        await this._renderGroups();
      }
    } catch (e) {
      // Render a HA error card
      const err = document.createElement("hui-error-card");
      err.setConfig({
        type: "error",
        error: `sorted-stack-card: ${e?.message || e}`,
      });
      this._root.replaceChildren(err);
    }
  }
}

customElements.define(CARD_TAG, SortedStackCard);

// Optional: show in card picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "sorted-stack-card",
  name: "Sorted Stack Card",
  description: "Stack (vertical/horizontal) that can sort cards by entity/name/state/last_changed/etc.",
});



// ---- Lovelace UI editor support ----
SortedStackCard.getStubConfig = () => ({
  type: "custom:sorted-stack-card",
  direction: "vertical",
  wrap: false,
  gap: 8,
  sort: { by: "name", order: "asc", numeric: false, locale: "sv-SE", case_insensitive: true },
  cards: [
    { type: "button", entity: "light.kok" },
    { type: "button", entity: "light.vardagsrum" },
  ],
});

SortedStackCard.getConfigElement = () => document.createElement("sorted-stack-card-editor");

class SortedStackCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = JSON.parse(JSON.stringify(config || {}));
    if (!this._config.cards && !this._config.groups) this._config.cards = [];
    this._selected = Math.min(this._selected || 0, (this._config.cards?.length || 1) - 1);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._subEditor) this._subEditor.hass = hass;
  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  _fire() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _set(path, value) {
    const parts = path.split(".");
    let o = this._config;
    while (parts.length > 1) {
      const p = parts.shift();
      o[p] = o[p] ?? {};
      o = o[p];
    }
    o[parts[0]] = value;
    this._render();
    this._fire();
  }

  _ensureSortDefaults() {
    this._config.sort = this._config.sort ?? {};
    if (!("by" in this._config.sort)) this._config.sort.by = "entity_id";
    if (!("order" in this._config.sort)) this._config.sort.order = "asc";
    if (!("numeric" in this._config.sort)) this._config.sort.numeric = false;
    if (!("locale" in this._config.sort)) this._config.sort.locale = "sv-SE";
    if (!("case_insensitive" in this._config.sort)) this._config.sort.case_insensitive = true;
  }

  _select(i) {
    this._selected = i;
    this._renderSubEditor();
  }

  _addCard() {
    this._config.cards = this._config.cards ?? [];
    this._config.cards.push({ type: "button" });
    this._selected = this._config.cards.length - 1;
    this._render();
    this._fire();
  }

  _removeCard() {
    if (!this._config.cards?.length) return;
    this._config.cards.splice(this._selected, 1);
    this._selected = Math.max(0, Math.min(this._selected, this._config.cards.length - 1));
    this._render();
    this._fire();
  }

  async _renderSubEditor() {
    const host = this.shadowRoot?.querySelector("#subeditor");
    if (!host) return;

    host.innerHTML = "";

    const cards = this._config.cards ?? [];
    if (!cards.length) {
      host.innerHTML = `<div class="hint">Lägg till ett kort med +</div>`;
      return;
    }

    const cfg = cards[this._selected];

    // HA's built-in card editor (visual)
    const el = document.createElement("hui-card-element-editor");
    el.hass = this._hass;
    el.value = cfg;

    el.addEventListener("config-changed", (e) => {
      const newCfg = e.detail?.config;
      if (!newCfg) return;
      this._config.cards[this._selected] = newCfg;
      this._fire();
    });

    this._subEditor = el;
    host.appendChild(el);
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!this._config) return;

    this._ensureSortDefaults();

    const cards = this._config.cards ?? [];
    const sel = Math.max(0, Math.min(this._selected || 0, Math.max(0, cards.length - 1)));
    this._selected = sel;

    const tabs = cards
      .map(
        (_, i) => `
        <button class="tab ${i === sel ? "active" : ""}" data-i="${i}">${i + 1}</button>
      `
      )
      .join("");

    const sortBy = this._config.sort.by;

    this.shadowRoot.innerHTML = `
      <style>
        .row{display:flex; gap:12px; align-items:center; margin:10px 0;}
        label{font-size:13px; opacity:.85; min-width:90px;}
        select,input{flex:1; padding:8px; border-radius:10px; border:1px solid var(--divider-color);}
        .tabs{display:flex; gap:6px; align-items:center; margin:8px 0;}
        .tab{padding:6px 10px; border-radius:10px; border:1px solid var(--divider-color); background:var(--card-background-color); cursor:pointer;}
        .tab.active{border-color:var(--primary-color); box-shadow:0 0 0 1px var(--primary-color) inset;}
        .iconbtn{padding:6px 10px; border-radius:10px; border:1px solid var(--divider-color); background:var(--card-background-color); cursor:pointer;}
        .hint{opacity:.7; padding:10px 0;}
        .subwrap{margin-top:10px;}
      </style>

      <div class="row">
        <label>Layout</label>
        <select id="direction">
          <option value="vertical" ${this._config.direction === "vertical" ? "selected" : ""}>Vertical</option>
          <option value="horizontal" ${this._config.direction === "horizontal" ? "selected" : ""}>Horizontal</option>
        </select>
      </div>

      <div class="row">
        <label>Wrap</label>
        <select id="wrap">
          <option value="false" ${!this._config.wrap ? "selected" : ""}>False</option>
          <option value="true" ${this._config.wrap ? "selected" : ""}>True</option>
        </select>
      </div>

      <div class="row">
        <label>Gap (px)</label>
        <input id="gap" type="number" min="0" value="${Number(this._config.gap ?? 8)}">
      </div>

      <div class="row">
        <label>Sortera</label>
        <select id="sortby">
          <option value="entity_id" ${sortBy === "entity_id" ? "selected" : ""}>entity_id</option>
          <option value="name" ${sortBy === "name" ? "selected" : ""}>name</option>
          <option value="state" ${sortBy === "state" ? "selected" : ""}>state</option>
          <option value="last_changed" ${sortBy === "last_changed" ? "selected" : ""}>last_changed</option>
          <option value="last_updated" ${sortBy === "last_updated" ? "selected" : ""}>last_updated</option>
          <option value="attribute" ${sortBy === "attribute" ? "selected" : ""}>attribute</option>
        </select>
      </div>

      <div class="row">
        <label>Ordning</label>
        <select id="order">
          <option value="asc" ${this._config.sort.order === "asc" ? "selected" : ""}>A→Ö</option>
          <option value="desc" ${this._config.sort.order === "desc" ? "selected" : ""}>Ö→A</option>
        </select>
      </div>

      <div class="row">
        <label>Numeric</label>
        <select id="numeric">
          <option value="false" ${!this._config.sort.numeric ? "selected" : ""}>False</option>
          <option value="true" ${this._config.sort.numeric ? "selected" : ""}>True</option>
        </select>
      </div>

      ${sortBy === "attribute" ? `
      <div class="row">
        <label>Attribute</label>
        <input id="attr" placeholder="attributes.battery_level" value="${this._config.sort.attribute ?? ""}">
      </div>` : ""}

      <div class="tabs">
        ${tabs}
        <button class="iconbtn" id="add">+</button>
        <button class="iconbtn" id="remove" ${cards.length ? "" : "disabled"}>🗑</button>
      </div>

      <div class="subwrap" id="subeditor"></div>
    `;

    // Bind
    this.shadowRoot.querySelector("#direction")?.addEventListener("change", (e) => this._set("direction", e.target.value));
    this.shadowRoot.querySelector("#wrap")?.addEventListener("change", (e) => this._set("wrap", e.target.value === "true"));
    this.shadowRoot.querySelector("#gap")?.addEventListener("change", (e) => this._set("gap", Number(e.target.value)));
    this.shadowRoot.querySelector("#sortby")?.addEventListener("change", (e) => this._set("sort.by", e.target.value));
    this.shadowRoot.querySelector("#order")?.addEventListener("change", (e) => this._set("sort.order", e.target.value));
    this.shadowRoot.querySelector("#numeric")?.addEventListener("change", (e) => this._set("sort.numeric", e.target.value === "true"));
    this.shadowRoot.querySelector("#attr")?.addEventListener("change", (e) => this._set("sort.attribute", e.target.value));

    this.shadowRoot.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => this._select(Number(btn.dataset.i)));
    });
    this.shadowRoot.querySelector("#add")?.addEventListener("click", () => this._addCard());
    this.shadowRoot.querySelector("#remove")?.addEventListener("click", () => this._removeCard());

    // Sub editor (visual)
    this._renderSubEditor();
  }
}

customElements.define("sorted-stack-card-editor", SortedStackCardEditor);
