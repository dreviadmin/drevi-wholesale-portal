// Where a form goes once its save went through (click test, Nov). A push to
// the address already showing is not a page change in Next's app router: the
// same components stay mounted and keep their state. The receipt's Edit form
// opens in place on the receipt's own page, so Save Changes saved, pushed to
// that same address, and left staff on the form with nothing to say it had
// worked. An editor in that spot closes in place instead. Client-safe.

/** "close" when `target` is the page already showing (path and query), else "navigate". */
export function exitAfterSave(target: string, here: string): "close" | "navigate" {
  return addressOf(target) === addressOf(here) ? "close" : "navigate";
}

function addressOf(href: string): string {
  const u = new URL(href, "http://portal.invalid");
  return (u.pathname.replace(/\/+$/, "") || "/") + u.search;
}
