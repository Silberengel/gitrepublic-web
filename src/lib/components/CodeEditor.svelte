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
    content = $bindable(''),
    language = $bindable('text'),
    onChange = () => {},
    onSelection = () => {},
    readOnly = false,
    highlights = [],
    scrollToLine = $bindable(null)
  }: Props = $props();

  let editorView: EditorView | null = null;
  let editorElement: HTMLDivElement;
  let languageCompartment = new Compartment();
  
  // Create a highlight decoration (marker style)
  const highlightMark = Decoration.mark({
    class: 'cm-highlight-marker',
    attributes: { 'data-highlight': 'true' }
  });
  
  // Effect to set highlight decorations (DecorationSet)
  const setHighlightEffect = StateEffect.define<typeof Decoration.none>();
  
  // State field to track highlighted ranges
  const highlightField = StateField.define({
    create() {
      return Decoration.none;
    },
    update(decorations, tr) {
      decorations = decorations.map(tr.changes);
      // Apply highlight effects
      for (const effect of tr.effects) {
        if (effect.is(setHighlightEffect)) {
          // Replace all decorations with the new set
          decorations = effect.value;
        }
      }
      return decorations;
    },
    provide: f => EditorView.decorations.from(f)
  });

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
      highlightField,
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
        
        // Handle text selection (allow in read-only mode for highlighting)
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

  // Scroll to and highlight specific lines
  $effect(() => {
    if (editorView && scrollToLine !== null && scrollToLine > 0) {
      try {
        const doc = editorView.state.doc;
        const line = doc.line(Math.min(scrollToLine, doc.lines));
        const lineStart = line.from;
        const lineEnd = line.to;
        
        // Scroll to the line
        editorView.dispatch({
          selection: { anchor: lineStart, head: lineEnd },
          effects: EditorView.scrollIntoView(lineStart, { y: 'center' })
        });
        
        // Clear scrollToLine after scrolling
        setTimeout(() => {
          scrollToLine = null;
        }, 100);
      } catch (err) {
        console.error('Error scrolling to line:', err);
      }
    }
  });

  // Function to scroll to and highlight a range of lines with a persistent marker
  export function scrollToLines(startLine: number, endLine: number) {
    if (!editorView) return;
    
    try {
      const doc = editorView.state.doc;
      const start = Math.min(startLine, doc.lines);
      const end = Math.min(endLine, doc.lines);
      
      const startLineObj = doc.line(start);
      const endLineObj = doc.line(end);
      
      const from = startLineObj.from;
      const to = endLineObj.to;
      
      // Create a highlight decoration for the range
      const decorationRange = highlightMark.range(from, to);
      
      // Create a DecorationSet with the highlight
      const decorationSet = Decoration.set([decorationRange]);
      
      // Update the highlight field with the new decoration using StateEffect
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

  :global(.code-editor .cm-highlight-marker) {
    background-color: rgba(255, 255, 0, 0.4);
    padding: 2px 0;
    border-radius: 2px;
  }
</style>
