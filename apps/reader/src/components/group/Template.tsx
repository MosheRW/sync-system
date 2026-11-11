import { Fragment, type ReactNode } from 'react';

/**
 * A translated template with `{placeholder}` parts filled by React nodes
 * (#25 R15): names, numbers and times go in as elements (`PlainText`,
 * `<bdi>`), never through `format` into a string. One pass; a placeholder
 * without a value stays as written; text between parts stays text.
 */
export function Template({
  text,
  values,
}: {
  text: string;
  values: Readonly<Record<string, ReactNode>>;
}) {
  const parts = text.split(/(\{\w+\})/);
  return (
    <>
      {parts.map((part, index) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        const node = name !== undefined && Object.hasOwn(values, name) ? values[name] : part;
        return <Fragment key={index}>{node}</Fragment>;
      })}
    </>
  );
}

/** A number in its own isolate, in the interface locale (design 8). */
export function Num({ value, lang }: { value: number; lang: string }) {
  return <bdi>{new Intl.NumberFormat(lang, { useGrouping: false }).format(value)}</bdi>;
}
