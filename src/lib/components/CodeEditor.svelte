<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorView, keymap, Decoration } from '@codemirror/view';
  import { EditorState, type Extension, Compartment, StateField, StateEffect } from '@codemirror/state';
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
    scrollToLine?: number | null;
  }

  let {
    content = $bindable(),
    language = $bindable(),
    onChange = () => {},
    onSelection = () => {},
    readOnly = false,
    highlights = [],
    scrollToLine = $bindable()
  }: Props = $props();

  // Set default values for bindable props
  if (content === undefined) content = '';
  if (language === undefined) language = 'text';
  if (scrollToLine === undefined) scrollToLine = null;

  let editorView: EditorView | null = null;
  let editorElement: HTMLDivElement;
  let languageCompartment = new Compartment();
  let editableCompartment = new Compartment();
  
  // Highlight decoration for persistent markers
  const highlightMark = Decoration.mark({
    class: 'cm-highlight-marker',
    attributes: { 'data-highlight': 'true' }
  });
  
  // State effect for updating highlights
  const setHighlightEffect = StateEffect.define<ReturnType<typeof Decoration.set>>();
  
  // State field to manage highlight decorations
  const highlightField = StateField.define<ReturnType<typeof Decoration.set>>({
    create() {
      return Decoration.none;
    },
    update(decorations, tr) {
      decorations = decorations.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(setHighlightEffect)) {
          decorations = effect.value;
        }
      }
      return decorations;
    },
    provide: f => EditorView.decorations.from(f)
  });

  // Exported function to scroll to and highlight a range of lines
  export function scrollToLines(startLine: number, endLine: number): void {
    if (!editorView) return;
    
    try {
      const doc = editorView.state.doc;
      const start = Math.max(1, Math.min(startLine, doc.lines));
      const end = Math.max(1, Math.min(endLine, doc.lines));
      
      const startLineObj = doc.line(start);
      const endLineObj = doc.line(end);
      
      const from = startLineObj.from;
      const to = endLineObj.to;
      
      // Create highlight decoration
      const decorationRange = highlightMark.range(from, to);
      const decorationSet = Decoration.set([decorationRange]);
      
      // Apply highlight
      editorView.dispatch({
        effects: setHighlightEffect.of(decorationSet)
      });
      
      // Scroll to the lines
      editorView.dispatch({
        effects: EditorView.scrollIntoView(from, { y: 'center' })
      });
    } catch (err) {
      console.error('Error scrolling to lines:', err);
    }
  }

  function getLanguageExtension(): Extension[] {
    switch (language) {
      case 'markdown':
        // markdown() already includes syntax highlighting - don't add defaultHighlightStyle
        return [markdown()];
      case 'asciidoc':
        // StreamLanguage includes its own highlighting - don't use defaultHighlightStyle with it
        return [StreamLanguage.define(asciidoc)];
      default:
        // Plain text - no syntax highlighting needed
        return [];
    }
  }

  function createExtensions(): Extension[] {
    return [
      history(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      highlightField,
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap
      ]),
      languageCompartment.of(getLanguageExtension()),
      editableCompartment.of(EditorView.editable.of(!readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString();
          onChange(newContent);
        }
        
        if (update.selectionSet) {
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
      })
    ];
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
    if (!editorView) return;
    
    const currentContent = editorView.state.doc.toString();
    if (content !== currentContent) {
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
    if (!editorView) return;
    
    editorView.dispatch({
      effects: languageCompartment.reconfigure(getLanguageExtension())
    });
  });

  // Update editable state when readOnly prop changes
  $effect(() => {
    if (!editorView) return;
    
    editorView.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly))
    });
  });

  // Scroll to specific line when scrollToLine changes
  $effect(() => {
    if (!editorView || scrollToLine === null || scrollToLine === undefined || scrollToLine <= 0) return;
    
    try {
      const doc = editorView.state.doc;
      const lineNum = Math.min(scrollToLine, doc.lines);
      const line = doc.line(lineNum);
      const lineStart = line.from;
      const lineEnd = line.to;
      
      // Scroll to the line
      editorView.dispatch({
        selection: { anchor: lineStart, head: lineEnd },
        effects: EditorView.scrollIntoView(lineStart, { y: 'center' })
      });
      
      // Clear scrollToLine after scrolling
      const timeoutId = setTimeout(() => {
        scrollToLine = null;
      }, 100);
      
      return () => {
        clearTimeout(timeoutId);
      };
    } catch (err) {
      console.error('Error scrolling to line:', err);
    }
  });
</script>

<div bind:this={editorElement} class="code-editor"></div>

<style>
  .code-editor {
    height: 100%;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    min-width: 0;
    box-sizing: border-box;
  }

  :global(.code-editor .cm-editor) {
    height: 100%;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    overflow: hidden;
  }

  :global(.code-editor .cm-scroller) {
    overflow-x: hidden !important;
    overflow-y: auto;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  :global(.code-editor .cm-content) {
    max-width: 100% !important;
    min-width: 0;
    box-sizing: border-box;
    word-wrap: break-word;
    overflow-wrap: break-word;
    overflow-x: hidden !important;
    width: 100%;
  }

  :global(.code-editor .cm-line) {
    max-width: 100% !important;
    min-width: 0;
    box-sizing: border-box;
    word-wrap: break-word;
    overflow-wrap: break-word;
    overflow-x: hidden !important;
  }

  :global(.code-editor .cm-line > *) {
    max-width: 100% !important;
    word-wrap: break-word !important;
    overflow-wrap: break-word !important;
  }

  :global(.code-editor .cm-highlight-marker) {
    background-color: rgba(255, 255, 0, 0.4);
    padding: 2px 0;
    border-radius: 2px;
  }

  /* Prevent any CodeMirror element from causing horizontal overflow */
  :global(.code-editor .cm-gutters),
  :global(.code-editor .cm-gutter),
  :global(.code-editor .cm-panels),
  :global(.code-editor .cm-panel),
  :global(.code-editor .cm-focused) {
    max-width: 100%;
    box-sizing: border-box;
    overflow-x: hidden !important;
  }

  /* Ensure all text content in CodeMirror wraps */
  :global(.code-editor .cm-content),
  :global(.code-editor .cm-line),
  :global(.code-editor .cm-lineContent) {
    overflow-x: hidden !important;
    word-break: break-word;
    overflow-wrap: break-word;
  }
</style>
