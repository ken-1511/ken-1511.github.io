import { idToPath, pathToId } from './ids.js';

/**
 * Hash routing over component addresses.
 *
 *   #/building-a/floor-02/room-204
 *
 * The route *is* the component id — `pathToId` is the only translation, so a URL
 * and an address can never drift apart. The router does not know which rooms
 * exist; it reports what it parsed and the shell decides whether it resolves.
 * That keeps "unknown route" a visible application state rather than a silent
 * redirect to the default room.
 */
export class Router {
  #onRoute;
  #current = null;
  #started = false;

  constructor({ onRoute }) {
    this.#onRoute = onRoute;
    this.handleHashChange = this.handleHashChange.bind(this);
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    window.addEventListener('hashchange', this.handleHashChange);
    this.handleHashChange();
  }

  stop() {
    this.#started = false;
    window.removeEventListener('hashchange', this.handleHashChange);
  }

  handleHashChange() {
    this.#current = Router.parse(window.location.hash);
    this.#onRoute(this.#current);
  }

  /**
   * Returns `{ raw, id, ok }`. `id` is null when the hash is empty (open the
   * default) or unparseable (`ok: false`, show the failure).
   */
  static parse(hash) {
    const raw = String(hash ?? '').replace(/^#/, '');
    if (raw === '' || raw === '/') return { raw, id: null, ok: true, empty: true };
    const id = pathToId(raw);
    return { raw, id, ok: id !== null, empty: false };
  }

  get current() {
    return this.#current;
  }

  /**
   * Rewrite the current history entry without re-dispatching.
   *
   * Used when a selection refines the address in place: the deeper address stays
   * deep-linkable, but clicking around a room does not push a back-button step
   * for every part.
   */
  replaceSilent(id) {
    const hash = `#${idToPath(id)}`;
    if (window.location.hash === hash) return;
    window.history.replaceState(null, '', hash);
    this.#current = Router.parse(hash);
  }

  /** Push a component address into history. `replace` avoids a back-button trap. */
  navigate(id, { replace = false } = {}) {
    const hash = `#${idToPath(id)}`;
    if (window.location.hash === hash) return;
    if (replace) {
      window.history.replaceState(null, '', hash);
      this.handleHashChange();
    } else {
      window.location.hash = hash;
    }
  }
}
