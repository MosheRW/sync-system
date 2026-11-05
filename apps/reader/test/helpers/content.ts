/** A minimal valid v1 document as a plain JSON value, for tests to modify. */
export function validDoc(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contentId: 'acme/sample',
    title: 'Sample',
    lang: 'en',
    dir: 'ltr',
    pages: [
      { blocks: [{ text: 'First page.' }] },
      {
        dir: 'rtl',
        lang: 'he',
        blocks: [
          { text: 'שלום עולם.', type: 'heading' },
          { text: 'Hello', dir: 'ltr', lang: 'en' },
          { text: 'auto text', dir: 'auto' },
        ],
      },
    ],
  };
}

export function docText(doc: unknown = validDoc()): string {
  return JSON.stringify(doc);
}
