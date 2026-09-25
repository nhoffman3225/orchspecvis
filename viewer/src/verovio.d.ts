// Minimal typings for the parts of the verovio package (LGPL-3.0) that orchspec uses.
declare module "verovio/wasm" {
  const createVerovioModule: () => Promise<unknown>;
  export default createVerovioModule;
}

declare module "verovio/esm" {
  export interface TimemapEntry {
    tstamp: number;
    qstamp: number;
    on?: string[];
    off?: string[];
    measureOn?: string;
    tempo?: number;
  }
  export interface ElementsAtTime {
    page: number;
    measure: string;
    notes: string[];
    chords: string[];
    rests: string[];
  }
  export class VerovioToolkit {
    constructor(module: unknown);
    getVersion(): string;
    setOptions(options: Record<string, unknown>): void;
    loadData(data: string): boolean | number;
    loadZipDataBuffer(data: ArrayBuffer): boolean | number;
    getPageCount(): number;
    renderToSVG(page: number, xmlDeclaration?: boolean): string;
    renderToTimemap(options?: Record<string, unknown>): TimemapEntry[];
    getElementsAtTime(ms: number): ElementsAtTime;
    getElementAttr(id: string): Record<string, string>;
    getTimeForElement(id: string): number;
    getPageWithElement(id: string): number;
    getExpansionIdsForElement(id: string): string[];
    getNotatedIdForElement(id: string): string;
    redoLayout(options?: Record<string, unknown>): void;
    getLog(): string;
  }
}
