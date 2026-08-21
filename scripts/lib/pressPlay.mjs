/**
 * PRESS PLAY, the way a player does.
 *
 * The colony route puts a one-button door in front of the tray, and the door
 * is not decoration: `reveal()` is where the renderer is sized, so a probe
 * that skips it measures a code path nobody runs. There is deliberately no
 * query parameter to bypass the menu for the same reason — this project has
 * already shipped a build that passed 14/14 against a bundle the device was
 * not running, and "the probe took a shortcut" is the same mistake wearing a
 * different coat.
 *
 * Returns false when the route has no door, so a probe can call it
 * unconditionally.
 */
export async function pressPlay(page, timeout = 240000) {
  const sel = '.main-menu__button[data-key="onStart"]';
  const play = page.locator(sel);
  if (await play.count() === 0) return false;
  /* Enabled only once the scene finished building — pressing it earlier would
   * open onto a tray that does not exist yet. */
  await page.waitForFunction(
    (s) => { const b = document.querySelector(s); return !!b && !b.disabled; },
    sel, { timeout },
  );
  await play.click();
  await page.waitForFunction(
    () => !document.querySelector('.main-menu'), null, { timeout: 15000 },
  );
  return true;
}
