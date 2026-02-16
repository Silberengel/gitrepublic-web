<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { EditorState, type Extension } from '@codemirror/state';
  import { basicSetup } from '@codemirror/basic-setup';
  import { markdown } from '@codemirror/lang-markdown';
  import { StreamLanguage } from '@codemirror/language';
  import { asciidoc } from 'codemirror-asciidoc';

  interface Props {
    content?: string;
    language?: 'markdown' | 'asciidoc' | 'text';
    onChange?: (value: string) => void;
  }

  let {
    content = $bindable(''),
    language = $bindable('text'),
    onChange = () => {}
  }: Props = $props();

  let editorView: EditorView | null = null;
  let editorElement: HTMLDivElement;

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

  onMount(() => {
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        ...getLanguageExtension(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            onChange(newContent);
          }
        })
      ]
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
      const state = EditorState.create({
        doc: editorView.state.doc.toString(),
        extensions: [
          basicSetup,
          ...getLanguageExtension(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newContent = update.state.doc.toString();
              onChange(newContent);
            }
          })
        ]
      });
      editorView.setState(state);
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
