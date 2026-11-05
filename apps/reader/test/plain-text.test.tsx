import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlainText } from '../src/components/PlainText.js';

describe('PlainText (AC4, AC18, security C6)', () => {
  it.each([
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '<b>Mallory</b>',
    '"><svg onload=alert(1)>',
  ])('renders %j as literal text', (text) => {
    const { container } = render(<PlainText text={text} />);
    const bdi = container.querySelector('bdi')!;
    expect(bdi.textContent).toBe(text);
    expect(bdi.children).toHaveLength(0);
    expect(container.querySelector('img, script, b, svg')).toBeNull();
  });

  it('isolates the text with its own direction and language', () => {
    const { container } = render(<PlainText text="שלום" dir="rtl" lang="he" />);
    const bdi = container.querySelector('bdi')!;
    expect(bdi.getAttribute('dir')).toBe('rtl');
    expect(bdi.getAttribute('lang')).toBe('he');
  });

  it('truncates and collapses line breaks when asked', () => {
    const { container } = render(
      <PlainText text={'line one\r\nline two\n\nline three'} singleLine maxLength={12} />,
    );
    expect(container.textContent).toBe('line one lin…');
  });
});
