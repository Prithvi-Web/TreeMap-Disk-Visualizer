/**
 * Minimal ambient types for pdfmake's server-side printer. @types/pdfmake only
 * covers the browser API, not the Node `pdfmake/src/printer` entry we use.
 */
declare module 'pdfmake/src/printer' {
  import { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';

  interface PdfKitDocument extends NodeJS.ReadableStream {
    /** Finalise the document; the stream ends once writing completes. */
    end(): void;
  }

  class PdfPrinter {
    constructor(fonts: TFontDictionary);
    createPdfKitDocument(docDefinition: TDocumentDefinitions, options?: Record<string, unknown>): PdfKitDocument;
  }

  export = PdfPrinter;
}
