import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/group/ConfirmDialog.js';
import { Dialog } from '../src/components/group/Dialog.js';
import { I18nProvider } from '../src/i18n/index.js';

function Opener({ esc }: { esc: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider lang="en">
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <Dialog title="Title" {...(esc ? { onCancel: () => setOpen(false) } : {})}>
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </Dialog>
      ) : null}
    </I18nProvider>
  );
}

describe('Dialog (#24 D2, architecture 7.7, AC52)', () => {
  it('opens modally, labelled by its title, with focus on the title', () => {
    render(<Opener esc />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Title' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Title' }));
  });

  it('closes on Esc and returns focus to the opener', () => {
    render(<Opener esc />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('ignores Esc when a choice is required', () => {
    render(<Opener esc={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ConfirmDialog (design 6.16)', () => {
  it('is an alertdialog with focus on Cancel; Esc cancels; confirm runs', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <I18nProvider lang="en">
        <ConfirmDialog
          title="End the group for everyone?"
          body="Everyone stops following."
          confirmLabel="End group"
          pendingLabel="Ending…"
          tone="danger"
          pending={false}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'End the group for everyone?' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'End group' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the pending label, stays focusable and ignores clicks while pending', () => {
    const onConfirm = vi.fn();
    render(
      <I18nProvider lang="en">
        <ConfirmDialog
          title="Get new codes?"
          body="x"
          confirmLabel="Get new codes"
          pendingLabel="Getting new codes…"
          tone="primary"
          pending
          error="Couldn't get new codes."
          onConfirm={onConfirm}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    );
    const button = screen.getByRole('button', { name: 'Getting new codes…' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe("Couldn't get new codes.");
  });
});
