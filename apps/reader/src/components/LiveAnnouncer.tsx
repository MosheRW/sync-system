/**
 * The single polite live region (design.md section 9): announces "Page n of
 * N" on page changes; empty on first load.
 */
export function LiveAnnouncer({ message }: { message: string }) {
  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
