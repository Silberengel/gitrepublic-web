<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState, type Extension, Compartment } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
  import { markdown } from '@codemirror/lang-markdown';
  import { StreamLanguage } from '@codemirror/language';
  import { asciidoc } from 'codemirror-asciidoc';

  interface Props {
    content?: string;
    language?: 'markdown' | 'asciidoc' | 'text';
    onChange?: (value: string) => void;
    onSelection?: (selectedText: string, startLine: number, endLine: number, startPos: number, endPos: number) => void;
    readOnly?: boolean;
    highlights?: Array<{ id: string; startLine: number; endLine: number; content: string }>;
  }

  let {
    content = $bindable(''),
    language = $bindable('text'),
    onChange = () => {},
    onSelection = () => {},
    readOnly = false,
    highlights = []
  }: Props = $props();

  let editorView: EditorView | null = null;
  let editorElement: HTMLDivElement;
  let languageCompartment = new Compartment();

  function getLanguageExtension(): Extension[] {
    switch (language) {
      case 'markdown':
        return [markdown()];
      case 'asciidoc':
        return [StreamLanguage.define(asciidoc)];
      default:
        return [];
    }
  }

  function createExtensions(): Extension[] {
    const extensions: Extension[] = [
      history(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap
      ] as any),
      // Add language extensions in a compartment for dynamic updates
      languageCompartment.of(getLanguageExtension()),
      // Add update listener
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          onChange(newContent);
        }
        
        // Handle text selection
        if (update.selectionSet && !readOnly) {
          const selection = update.state.selection.main;
          if (!selection.empty) {
            const selectedText = update.state.doc.sliceString(selection.from, selection.to);
            const startLine = update.state.doc.lineAt(selection.from);
            const endLine = update.state.doc.lineAt(selection.to);
            
            onSelection(
              selectedText,
              startLine.number,
              endLine.number,
              selection.from,
              selection.to
            );
          }
        }
      }),
      // Add editable state
      EditorView.editable.of(!readOnly)
    ];
    
    return extensions;
  }

  onMount(() => {
    const state = EditorState.create({
      doc: content,
      extensions: createExtensions()
    });

    editorView = new EditorView({
      state,
      parent: editorElement
    });

    return () => {
      editorView?.destroy();
    };
  });

  onDestroy(() => {
    editorView?.destroy();
  });

  // Update content when prop changes externally
  $effect(() => {
    if (editorView && content !== editorView.state.doc.toString()) {
      editorView.dispatch({
        changes: {
          from: 0,
          to: editorView.state.doc.length,
          insert: content
        }
      });
    }
  });

  // Update language when prop changes
  $effect(() => {
    if (editorView) {
      // Update language extension using compartment
      editorView.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension())
      });
    }
  });
</script>

<div bind:this={editorElement} class="code-editor"></div>

<style>
  .code-editor {
    height: 100%;
    width: 100%;
    overflow: auto;
  }

  :global(.code-editor .cm-editor) {
    height: 100%;
  }

  :global(.code-editor .cm-scroller) {
    overflow: auto;
  }
</style>
