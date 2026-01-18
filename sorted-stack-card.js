/* sorted-stack-card.js
 * Custom Lovelace card: custom:sorted-stack-card
 *
 * Minimal UI editor:
 * - direction: vertical|horizontal
 * - sort.by: entity_id|name|state|last_changed|last_updated
 * - sort.order: asc|desc
 *
 * Card features (render):
 * - direction: vertical|horizontal
 * - wrap: true|false (only for horizontal)
 * - gap: number (px)
 * - sort: by entity_id|name|state|last_changed|last_updated|attribute
 * - sort.attribute: "attributes.battery_level" etc
 * - sort.numeric: true|false
 * - sort.locale: default "sv-SE"
 * - sort.case_insensitive: default true
 * - cards: [ ... ]
 * - groups: [{ main: {...}, cards: [...], sort_override?: {...} }]
 */

const CARD_TAG = "sorted-stack-card";

class SortedStackCard extends HTMLElement {
  // --- Lovelace UI editor support (same pattern as RotatingHelperCard) ---
  static getConfigElement() {
    return document.createElement("sorted-stack-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:sorted-stack-card",
      direction: "vertical",
      sort: { by: "name", order: "asc" },
      cards: [
        { type: "button", entity: "light.kok" },
        { type: "button", entity: "light.vardagsrum" },
      ],
    };
  }

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

    // Ensure cards exists if using flat mode
    this._config.cards = this._config.cards ?? null;

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
    if (cardCfg && typeof cardCfg.entity === "string" && cardCfg.entity) return cardCfg.entity;

    const ents = cardCfg && cardCfg.entities;
    if (Array.isArray(ents) && ents.length) {
      const first = ents[0];
      if (typeof first === "string") return first;
      if (first && typeof first.entity === "string") return first.entity;
    }

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

    if (!st) {
      if (by === "last_changed" || by === "last_updated") return 0;
      return "";
    }

    if (by === "name") {
      return (cardCfg?.name ?? st.attributes?.friendly_name ?? entityId ?? "") || "";
    }

    if (by === "state") return st.state ?? "";
    if (by === "last_changed") return new Date(st.last_changed).getTime() || 0;
    if (by === "last_updated") return new Date(st.last_updated).getTime() || 0;

    if (by === "attribute") {
      const attrPath = sortCfg?.attribute || this._config?.sort?.attribute || "";
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
    return helpers.createCardElement(cardCfg);
  }

  async _getOrCreateElement(cardCfg) {
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

      const mainEl = await this._getOrCreateElement(g.main);
      mainEl.hass = this._hass;
      mainEl.classList?.add("item");
      out.push(mainEl);

      const innerSort = g.sort_override ? Object.assign({}, globalSort, g.sort_override) : null;
      const effectiveSort = innerSort || globalSort;

      const subItems = (g.cards || []).map((cfg) => ({
        cfg,
        value: this._getSortValue(cfg, effectiveSort),
      }));

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

/* -------------------- UI Editor (minimal) -------------------- */

class SortedStackCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._config.type = "custom:sorted-stack-card";
    this._config.direction = this._config.direction ?? "vertical";
    this._config.sort = this._config.sort ?? {};
    this._config.sort.by = this._config.sort.by ?? "name";
    this._config.sort.order = this._config.sort.order ?? "asc";
    this._config.cards = this._config.cards ?? [];
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  _fire() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { value: this._config },
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

  _render() {
    if (!this.shadowRoot || !this._config) return;

    this.shadowRoot.innerHTML = `
      <style>
        .row{display:flex; gap:12px; align-items:center; margin:10px 0;}
        label{font-size:13px; opacity:.85; min-width:90px;}
        select{flex:1; padding:8px; border-radius:10px; border:1px solid var(--divider-color);}
        .hint{opacity:.7; margin-top:10px;}
      </style>

      <div class="row">
        <label>Layout</label>
        <select id="direction">
          <option value="vertical" ${this._config.direction === "vertical" ? "selected" : ""}>Vertical</option>
          <option value="horizontal" ${this._config.direction === "horizontal" ? "selected" : ""}>Horizontal</option>
        </select>
      </div>

      <div class="row">
        <label>Sortera</label>
        <select id="by">
          <option value="entity_id" ${this._config.sort.by === "entity_id" ? "selected" : ""}>entity_id</option>
          <option value="name" ${this._config.sort.by === "name" ? "selected" : ""}>name</option>
          <option value="state" ${this._config.sort.by === "state" ? "selected" : ""}>state</option>
          <option value="last_changed" ${this._config.sort.by === "last_changed" ? "selected" : ""}>last_changed</option>
          <option value="last_updated" ${this._config.sort.by === "last_updated" ? "selected" : ""}>last_updated</option>
        </select>
      </div>

      <div class="row">
        <label>Ordning</label>
        <select id="order">
          <option value="asc" ${this._config.sort.order === "asc" ? "selected" : ""}>A→Ö</option>
          <option value="desc" ${this._config.sort.order === "desc" ? "selected" : ""}>Ö→A</option>
        </select>
      </div>

      <div class="hint">
        Underkort redigeras i YAML för nu (cards: ...). Vi kan lägga till tabbar + visual editor sen.
      </div>
    `;

    this.shadowRoot.querySelector("#direction")?.addEventListener("change", (e) => this._set("direction", e.target.value));
    this.shadowRoot.querySelector("#by")?.addEventListener("change", (e) => this._set("sort.by", e.target.value));
    this.shadowRoot.querySelector("#order")?.addEventListener("change", (e) => this._set("sort.order", e.target.value));
  }
}

customElements.define("sorted-stack-card-editor", SortedStackCardEditor);

/* -------------------- Card picker entry -------------------- */

const SortedStackCardDescriptor = {
  type: "custom:sorted-stack-card",
  name: "Sorted Stack Card",
  description: "Stack som kan sortera kort (name/state/last_changed osv).",
  preview: false,
};

window.customCards = window.customCards || [];
window.customCards.push(SortedStackCardDescriptor);
