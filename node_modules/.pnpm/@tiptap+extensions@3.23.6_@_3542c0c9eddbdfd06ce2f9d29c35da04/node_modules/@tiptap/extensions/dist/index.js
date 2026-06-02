// src/character-count/character-count.ts
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
var CharacterCount = Extension.create({
  name: "characterCount",
  addOptions() {
    return {
      limit: null,
      autoTrim: true,
      mode: "textSize",
      textCounter: (text) => text.length,
      wordCounter: (text) => text.split(" ").filter((word) => word !== "").length
    };
  },
  addStorage() {
    return {
      characters: () => 0,
      words: () => 0
    };
  },
  onBeforeCreate() {
    this.storage.characters = (options) => {
      const node = (options == null ? void 0 : options.node) || this.editor.state.doc;
      const mode = (options == null ? void 0 : options.mode) || this.options.mode;
      if (mode === "textSize") {
        const text = node.textBetween(0, node.content.size, void 0, " ");
        return this.options.textCounter(text);
      }
      return node.nodeSize;
    };
    this.storage.words = (options) => {
      const node = (options == null ? void 0 : options.node) || this.editor.state.doc;
      const text = node.textBetween(0, node.content.size, " ", " ");
      return this.options.wordCounter(text);
    };
  },
  addProseMirrorPlugins() {
    let initialEvaluationDone = false;
    return [
      new Plugin({
        key: new PluginKey("characterCount"),
        appendTransaction: (transactions, oldState, newState) => {
          if (initialEvaluationDone) {
            return;
          }
          const limit = this.options.limit;
          const autoTrim = this.options.autoTrim;
          if (limit === null || limit === void 0 || limit === 0 || autoTrim === false) {
            initialEvaluationDone = true;
            return;
          }
          const initialContentSize = this.storage.characters({ node: newState.doc });
          if (initialContentSize > limit) {
            const over = initialContentSize - limit;
            const from = 0;
            const to = over;
            console.warn(
              `[CharacterCount] Initial content exceeded limit of ${limit} characters. Content was automatically trimmed.`
            );
            const tr = newState.tr.deleteRange(from, to);
            initialEvaluationDone = true;
            return tr;
          }
          initialEvaluationDone = true;
        },
        filterTransaction: (transaction, state) => {
          const limit = this.options.limit;
          if (!transaction.docChanged || limit === 0 || limit === null || limit === void 0) {
            return true;
          }
          const oldSize = this.storage.characters({ node: state.doc });
          const newSize = this.storage.characters({ node: transaction.doc });
          if (newSize <= limit) {
            return true;
          }
          if (oldSize > limit && newSize > limit && newSize <= oldSize) {
            return true;
          }
          if (oldSize > limit && newSize > limit && newSize > oldSize) {
            return false;
          }
          const isPaste = transaction.getMeta("paste");
          if (!isPaste) {
            return false;
          }
          const pos = transaction.selection.$head.pos;
          const over = newSize - limit;
          const from = pos - over;
          const to = pos;
          transaction.deleteRange(from, to);
          const updatedSize = this.storage.characters({ node: transaction.doc });
          if (updatedSize > limit) {
            return false;
          }
          return true;
        }
      })
    ];
  }
});

// src/drop-cursor/drop-cursor.ts
import { Extension as Extension2 } from "@tiptap/core";
import { dropCursor } from "@tiptap/pm/dropcursor";
var Dropcursor = Extension2.create({
  name: "dropCursor",
  addOptions() {
    return {
      color: "currentColor",
      width: 1,
      class: void 0
    };
  },
  addProseMirrorPlugins() {
    return [dropCursor(this.options)];
  }
});

// src/focus/focus.ts
import { Extension as Extension3 } from "@tiptap/core";
import { Plugin as Plugin2, PluginKey as PluginKey2 } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
var Focus = Extension3.create({
  name: "focus",
  addOptions() {
    return {
      className: "has-focus",
      mode: "all"
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin2({
        key: new PluginKey2("focus"),
        props: {
          decorations: ({ doc, selection }) => {
            const { isEditable, isFocused } = this.editor;
            const { anchor } = selection;
            const decorations = [];
            if (!isEditable || !isFocused) {
              return DecorationSet.create(doc, []);
            }
            let maxLevels = 0;
            if (this.options.mode === "deepest") {
              doc.descendants((node, pos) => {
                if (node.isText) {
                  return;
                }
                const isCurrent = anchor >= pos && anchor <= pos + node.nodeSize - 1;
                if (!isCurrent) {
                  return false;
                }
                maxLevels += 1;
              });
            }
            let currentLevel = 0;
            doc.descendants((node, pos) => {
              if (node.isText) {
                return false;
              }
              const isCurrent = anchor >= pos && anchor <= pos + node.nodeSize - 1;
              if (!isCurrent) {
                return false;
              }
              currentLevel += 1;
              const outOfScope = this.options.mode === "deepest" && maxLevels - currentLevel > 0 || this.options.mode === "shallowest" && currentLevel > 1;
              if (outOfScope) {
                return this.options.mode === "deepest";
              }
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: this.options.className
                })
              );
            });
            return DecorationSet.create(doc, decorations);
          }
        }
      })
    ];
  }
});

// src/gap-cursor/gap-cursor.ts
import { callOrReturn, Extension as Extension4, getExtensionField } from "@tiptap/core";
import { gapCursor } from "@tiptap/pm/gapcursor";
var Gapcursor = Extension4.create({
  name: "gapCursor",
  addProseMirrorPlugins() {
    return [gapCursor()];
  },
  extendNodeSchema(extension) {
    var _a;
    const context = {
      name: extension.name,
      options: extension.options,
      storage: extension.storage
    };
    return {
      allowGapCursor: (_a = callOrReturn(getExtensionField(extension, "allowGapCursor", context))) != null ? _a : null
    };
  }
});

// src/placeholder/placeholder.ts
import { Extension as Extension5, isNodeEmpty } from "@tiptap/core";
import { Plugin as Plugin3, PluginKey as PluginKey3 } from "@tiptap/pm/state";
import { DecorationSet as DecorationSet2 } from "@tiptap/pm/view";

// src/placeholder/utils/createPlaceholderDecoration.ts
import { Decoration as Decoration2 } from "@tiptap/pm/view";
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
  return Decoration2.node(pos, pos + node.nodeSize, {
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
var PLUGIN_KEY = new PluginKey3("tiptap__placeholder");
var Placeholder = Extension5.create({
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
      new Plugin3({
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
                if (node.type.isTextblock && isNodeEmpty(node)) {
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
                const isEmpty = !node.isLeaf && isNodeEmpty(node);
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
            return DecorationSet2.create(doc, decorations);
          }
        }
      })
    ];
  }
});

// src/selection/selection.ts
import { Extension as Extension6, isNodeSelection } from "@tiptap/core";
import { Plugin as Plugin4, PluginKey as PluginKey4 } from "@tiptap/pm/state";
import { Decoration as Decoration3, DecorationSet as DecorationSet3 } from "@tiptap/pm/view";
var Selection = Extension6.create({
  name: "selection",
  addOptions() {
    return {
      className: "selection"
    };
  },
  addProseMirrorPlugins() {
    const { editor, options } = this;
    return [
      new Plugin4({
        key: new PluginKey4("selection"),
        props: {
          decorations(state) {
            if (state.selection.empty || editor.isFocused || !editor.isEditable || isNodeSelection(state.selection) || editor.view.dragging) {
              return null;
            }
            return DecorationSet3.create(state.doc, [
              Decoration3.inline(state.selection.from, state.selection.to, {
                class: options.className
              })
            ]);
          }
        }
      })
    ];
  }
});

// src/trailing-node/trailing-node.ts
import { Extension as Extension7 } from "@tiptap/core";
import { Plugin as Plugin5, PluginKey as PluginKey5 } from "@tiptap/pm/state";
var skipTrailingNodeMeta = "skipTrailingNode";
function nodeEqualsType({ types, node }) {
  return node && Array.isArray(types) && types.includes(node.type) || (node == null ? void 0 : node.type) === types;
}
var TrailingNode = Extension7.create({
  name: "trailingNode",
  addOptions() {
    return {
      node: void 0,
      notAfter: []
    };
  },
  addProseMirrorPlugins() {
    var _a;
    const plugin = new PluginKey5(this.name);
    const defaultNode = this.options.node || ((_a = this.editor.schema.topNodeType.contentMatch.defaultType) == null ? void 0 : _a.name) || "paragraph";
    const disabledNodes = Object.entries(this.editor.schema.nodes).map(([, value]) => value).filter((node) => (this.options.notAfter || []).concat(defaultNode).includes(node.name));
    return [
      new Plugin5({
        key: plugin,
        appendTransaction: (transactions, __, state) => {
          const { doc, tr, schema } = state;
          const shouldInsertNodeAtEnd = plugin.getState(state);
          const endPosition = doc.content.size;
          const type = schema.nodes[defaultNode];
          if (transactions.some((transaction) => transaction.getMeta(skipTrailingNodeMeta))) {
            return;
          }
          if (!shouldInsertNodeAtEnd) {
            return;
          }
          return tr.insert(endPosition, type.create());
        },
        state: {
          init: (_, state) => {
            const lastNode = state.tr.doc.lastChild;
            return !nodeEqualsType({ node: lastNode, types: disabledNodes });
          },
          apply: (tr, value) => {
            if (!tr.docChanged) {
              return value;
            }
            if (tr.getMeta("__uniqueIDTransaction")) {
              return value;
            }
            const lastNode = tr.doc.lastChild;
            return !nodeEqualsType({ node: lastNode, types: disabledNodes });
          }
        }
      })
    ];
  }
});

// src/undo-redo/undo-redo.ts
import { Extension as Extension8 } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
var UndoRedo = Extension8.create({
  name: "undoRedo",
  addOptions() {
    return {
      depth: 100,
      newGroupDelay: 500
    };
  },
  addCommands() {
    return {
      undo: () => ({ state, dispatch }) => {
        return undo(state, dispatch);
      },
      redo: () => ({ state, dispatch }) => {
        return redo(state, dispatch);
      }
    };
  },
  addProseMirrorPlugins() {
    return [history(this.options)];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => this.editor.commands.undo(),
      "Shift-Mod-z": () => this.editor.commands.redo(),
      "Mod-y": () => this.editor.commands.redo(),
      // Russian keyboard layouts
      "Mod-\u044F": () => this.editor.commands.undo(),
      "Shift-Mod-\u044F": () => this.editor.commands.redo()
    };
  }
});
export {
  CharacterCount,
  Dropcursor,
  Focus,
  Gapcursor,
  PLUGIN_KEY,
  Placeholder,
  Selection,
  TrailingNode,
  UndoRedo,
  preparePlaceholderAttribute,
  skipTrailingNodeMeta
};
//# sourceMappingURL=index.js.map