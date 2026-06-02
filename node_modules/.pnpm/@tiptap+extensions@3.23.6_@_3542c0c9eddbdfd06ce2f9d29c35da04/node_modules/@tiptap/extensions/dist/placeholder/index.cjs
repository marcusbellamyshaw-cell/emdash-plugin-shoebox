"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/placeholder/index.ts
var index_exports = {};
__export(index_exports, {
  PLUGIN_KEY: () => PLUGIN_KEY,
  Placeholder: () => Placeholder,
  preparePlaceholderAttribute: () => preparePlaceholderAttribute
});
module.exports = __toCommonJS(index_exports);

// src/placeholder/placeholder.ts
var import_core = require("@tiptap/core");
var import_state = require("@tiptap/pm/state");
var import_view2 = require("@tiptap/pm/view");

// src/placeholder/utils/createPlaceholderDecoration.ts
var import_view = require("@tiptap/pm/view");
function createPlaceholderDecoration(options) {
  const {
    editor,
    placeholder,
    dataAttribute,
    pos,
    node,
    isEmptyDoc,
    hasAnchor,
    classes: { emptyNode, emptyEditor }
  } = options;
  const classes = [emptyNode];
  if (isEmptyDoc) {
    classes.push(emptyEditor);
  }
  return import_view.Decoration.node(pos, pos + node.nodeSize, {
    class: classes.join(" "),
    [dataAttribute]: typeof placeholder === "function" ? placeholder({
      editor,
      node,
      pos,
      hasAnchor
    }) : placeholder
  });
}

// src/placeholder/utils/findScrollParent.ts
function isScrollable(el) {
  const style = getComputedStyle(el);
  const overflow = `${style.overflow} ${style.overflowY} ${style.overflowX}`;
  return /auto|scroll|overlay/.test(overflow);
}
function findScrollParent(element) {
  let el = element;
  while (el) {
    if (isScrollable(el)) {
      return el;
    }
    const parent = el.parentElement;
    if (!parent) {
      const root = el.getRootNode();
      if (root instanceof ShadowRoot) {
        el = root.host;
        continue;
      }
      return window;
    }
    el = parent;
  }
  return window;
}

// src/placeholder/utils/getViewportBoundaryPositions.ts
function getContainerRect(container) {
  if (container === window) {
    return { top: 0, bottom: window.innerHeight };
  }
  return container.getBoundingClientRect();
}
function getViewportBoundaryPositions({
  doc,
  view,
  scrollContainer
}) {
  const editorRect = view.dom.getBoundingClientRect();
  const containerRect = scrollContainer ? getContainerRect(scrollContainer) : { top: 0, bottom: window.innerHeight };
  const visibleTop = Math.max(editorRect.top, containerRect.top);
  const visibleBottom = Math.min(editorRect.bottom, containerRect.bottom);
  if (visibleTop >= visibleBottom) {
    return { top: 0, bottom: doc.content.size };
  }
  const isRTL = getComputedStyle(view.dom).direction === "rtl";
  const x = isRTL ? Math.max(editorRect.right - 2, editorRect.left + 2) : editorRect.left + 2;
  const topPos = view.posAtCoords({ left: x, top: visibleTop + 2 });
  const bottomPos = view.posAtCoords({ left: x, top: visibleBottom - 2 });
  return {
    top: topPos ? topPos.pos : 0,
    bottom: bottomPos ? bottomPos.pos : doc.content.size
  };
}

// src/placeholder/utils/throttle.ts
function throttle(fn, delay) {
  let timer = null;
  const call = ((...args) => {
    if (timer) {
      return;
    }
    fn(...args);
    timer = setTimeout(() => {
      timer = null;
    }, delay);
  });
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return { call, cancel };
}

// src/placeholder/placeholder.ts
var DEFAULT_DATA_ATTRIBUTE = "placeholder";
function preparePlaceholderAttribute(attr) {
  return attr.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "").replace(/^[0-9-]+/, "").replace(/^-+/, "").toLowerCase();
}
var PLUGIN_KEY = new import_state.PluginKey("tiptap__placeholder");
var Placeholder = import_core.Extension.create({
  name: "placeholder",
  addOptions() {
    return {
      emptyEditorClass: "is-editor-empty",
      emptyNodeClass: "is-empty",
      dataAttribute: DEFAULT_DATA_ATTRIBUTE,
      placeholder: "Write something \u2026",
      showOnlyWhenEditable: true,
      showOnlyCurrent: true,
      includeChildren: false
    };
  },
  addProseMirrorPlugins() {
    const dataAttribute = this.options.dataAttribute ? `data-${preparePlaceholderAttribute(this.options.dataAttribute)}` : `data-${DEFAULT_DATA_ATTRIBUTE}`;
    return [
      new import_state.Plugin({
        state: {
          init() {
            return {
              // null means "no viewport info yet" — decoration callback falls
              // back to full document scan until the scroll handler fires.
              topPos: null,
              bottomPos: null
            };
          },
          apply(tr, prev) {
            const meta = tr.getMeta(PLUGIN_KEY);
            if (meta == null ? void 0 : meta.positions) {
              return {
                topPos: meta.positions.top,
                bottomPos: meta.positions.bottom
              };
            }
            if (!tr.docChanged) {
              return prev;
            }
            return {
              topPos: prev.topPos !== null ? tr.mapping.map(prev.topPos) : null,
              bottomPos: prev.bottomPos !== null ? tr.mapping.map(prev.bottomPos) : null
            };
          }
        },
        key: PLUGIN_KEY,
        view(view) {
          const scrollContainer = findScrollParent(view.dom);
          const computeAndDispatch = () => {
            const positions = getViewportBoundaryPositions({
              view,
              doc: view.state.doc,
              scrollContainer
            });
            const prev = PLUGIN_KEY.getState(view.state);
            if (prev.topPos === positions.top && prev.bottomPos === positions.bottom) {
              return;
            }
            const tr = view.state.tr.setMeta(PLUGIN_KEY, { positions }).setMeta("tiptap__viewportUpdate", true);
            view.dispatch(tr);
          };
          const { call: throttledUpdate, cancel: cancelThrottle } = throttle(computeAndDispatch, 250);
          const scrollParent = scrollContainer;
          scrollParent.addEventListener("scroll", throttledUpdate, { passive: true });
          computeAndDispatch();
          return {
            update(_, prevState) {
              if (view.state.doc.content.size !== prevState.doc.content.size) {
                computeAndDispatch();
              }
            },
            destroy: () => {
              cancelThrottle();
              scrollParent.removeEventListener("scroll", throttledUpdate);
            }
          };
        },
        props: {
          decorations: ({ doc, selection }) => {
            var _a, _b;
            const active = this.editor.isEditable || !this.options.showOnlyWhenEditable;
            if (!active) {
              return null;
            }
            const { anchor } = selection;
            const decorations = [];
            const isEmptyDoc = this.editor.isEmpty;
            const useResolvedPath = this.options.showOnlyCurrent && !this.options.includeChildren;
            if (useResolvedPath) {
              const resolved = doc.resolve(anchor);
              if (resolved.depth > 0) {
                const node = resolved.node(1);
                const nodeStart = resolved.before(1);
                if (node.type.isTextblock && (0, import_core.isNodeEmpty)(node)) {
                  const hasAnchor = anchor >= nodeStart && anchor <= nodeStart + node.nodeSize;
                  const decoration = createPlaceholderDecoration({
                    node,
                    dataAttribute,
                    hasAnchor,
                    placeholder: this.options.placeholder,
                    classes: {
                      emptyEditor: this.options.emptyEditorClass,
                      emptyNode: this.options.emptyNodeClass
                    },
                    editor: this.editor,
                    isEmptyDoc,
                    pos: resolved.before(1)
                  });
                  decorations.push(decoration);
                }
              }
            } else {
              const pluginState = PLUGIN_KEY.getState(this.editor.state);
              const from = (_a = pluginState.topPos) != null ? _a : 0;
              const to = (_b = pluginState.bottomPos) != null ? _b : doc.content.size;
              doc.nodesBetween(from, to, (node, pos) => {
                const hasAnchor = anchor >= pos && anchor <= pos + node.nodeSize;
                const isEmpty = !node.isLeaf && (0, import_core.isNodeEmpty)(node);
                if (!node.type.isTextblock) {
                  return this.options.includeChildren;
                }
                if ((hasAnchor || !this.options.showOnlyCurrent) && isEmpty) {
                  const decoration = createPlaceholderDecoration({
                    classes: { emptyEditor: this.options.emptyEditorClass, emptyNode: this.options.emptyNodeClass },
                    editor: this.editor,
                    isEmptyDoc,
                    dataAttribute,
                    hasAnchor,
                    placeholder: this.options.placeholder,
                    node,
                    pos
                  });
                  decorations.push(decoration);
                }
                return this.options.includeChildren;
              });
            }
            return import_view2.DecorationSet.create(doc, decorations);
          }
        }
      })
    ];
  }
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PLUGIN_KEY,
  Placeholder,
  preparePlaceholderAttribute
});
//# sourceMappingURL=index.cjs.map