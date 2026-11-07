/**
 * The page navigations the group features make (reload, open the group's
 * book). One object so tests can replace them; jsdom cannot navigate.
 */
export const browserNavigation = {
  reload(): void {
    window.location.reload();
  },
  assign(url: string): void {
    window.location.assign(url);
  },
};
