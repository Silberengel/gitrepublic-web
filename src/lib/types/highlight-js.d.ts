/**
 * Type definitions for highlight.js
 * These are minimal types for the parts we use
 */

declare module 'highlight.js' {
  export interface HighlightResult {
    value: string;
    language?: string;
    relevance?: number;
  }

  export interface HighlightOptions {
    language?: string;
    ignoreIllegals?: boolean;
  }

  export interface AutoHighlightResult extends HighlightResult {
    secondBest?: HighlightResult;
  }

  export interface Language {
    name?: string;
    aliases?: string[];
    keywords?: Record<string, any>;
    contains?: any[];
  }

  export interface HLJSApi {
    highlight(code: string, options: HighlightOptions): HighlightResult;
    highlightAuto(code: string, options?: { languageSubset?: string[] }): AutoHighlightResult;
    getLanguage(name: string): Language | undefined;
    registerLanguage(name: string, language: (hljs: HLJSApi) => Language): void;
    listLanguages(): string[];
  }

  const hljs: HLJSApi;
  export default hljs;
}
