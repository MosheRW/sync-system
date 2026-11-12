/**
 * The polite live region (design.md section 9): announces "Page n of N" on
 * page changes; empty on first load. A second, assertive region (#25 D4,
 * U13) carries only the time-critical keep-alive messages; it has no
 * `role="alert"`, so nothing is announced twice.
 */
export function LiveAnnouncer({
  message,
  assertive = '',
}: {
  message: string;
  assertive?: string;
}) {
  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </div>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </>
  );
}
