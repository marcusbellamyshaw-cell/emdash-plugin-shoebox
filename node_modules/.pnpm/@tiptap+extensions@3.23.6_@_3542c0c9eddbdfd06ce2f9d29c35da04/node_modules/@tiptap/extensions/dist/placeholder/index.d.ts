import { Editor, Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Node } from '@tiptap/pm/model';

interface PlaceholderOptions {
    /**
     * **The class name for the empty editor**
     * @default 'is-editor-empty'
     */
    emptyEditorClass: string;
    /**
     * **The class name for empty nodes**
     * @default 'is-empty'
     */
    emptyNodeClass: string;
    /**
     * **The data-attribute used for the placeholder label**
     * Will be prepended with `data-` and converted to kebab-case and cleaned of special characters.
     * @default 'placeholder'
     */
    dataAttribute: string;
    /**
     * **The placeholder content**
     *
     * You can use a function to return a dynamic placeholder or a string.
     * @default 'Write something …'
     */
    placeholder: ((PlaceholderProps: {
        editor: Editor;
        node: Node;
        pos: number;
        hasAnchor: boolean;
    }) => string) | string;
    /**
     * **Checks if the placeholder should be only shown when the editor is editable.**
     *
     * If true, the placeholder will only be shown when the editor is editable.
     * If false, the placeholder will always be shown.
     * @default true
     */
    showOnlyWhenEditable: boolean;
    /**
     * **Checks if the placeholder should be only shown when the current node is empty.**
     *
     * If true, the placeholder will only be shown when the current node is empty.
     * If false, the placeholder will be shown when any node is empty.
     * @default true
     */
    showOnlyCurrent: boolean;
    /**
     * **Controls if the placeholder should be shown for all descendants.**
     *
     * If true, the placeholder will be shown for all descendants.
     * If false, the placeholder will only be shown for the current node.
     * @default false
     */
    includeChildren: boolean;
}

/**
 * Prepares the placeholder attribute by ensuring it is properly formatted.
 * @param attr - The placeholder attribute string.
 * @returns The prepared placeholder attribute string.
 */
declare function preparePlaceholderAttribute(attr: string): string;
declare const PLUGIN_KEY: PluginKey<any>;
/**
 * This extension allows you to add a placeholder to your editor.
 * A placeholder is a text that appears when the editor or a node is empty.
 * @see https://www.tiptap.dev/api/extensions/placeholder
 */
declare const Placeholder: Extension<PlaceholderOptions, any>;

export { PLUGIN_KEY, Placeholder, type PlaceholderOptions, preparePlaceholderAttribute };
