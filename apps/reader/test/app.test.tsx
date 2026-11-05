import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App.js';

describe('App scaffold', () => {
  it('renders a main landmark', () => {
    const { container } = render(<App />);
    expect(container.querySelector('main')).not.toBeNull();
  });
});
