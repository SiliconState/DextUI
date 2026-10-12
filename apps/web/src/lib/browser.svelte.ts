// Tiny eagerly loaded launcher; transport and renderer load only when opened.
export const browser = $state({ open: false });
export function openBrowser() { browser.open = true; }
export function closeBrowser() { browser.open = false; }
