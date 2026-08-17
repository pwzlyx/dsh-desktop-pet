/**
 * Node half of the desktop-pet surface plugin.
 *
 * Pure client UI plugin: the empty `apply` exists only so the plugin appears
 * as a Loader entry in the host cordis tree. The browser half ships through
 * `exports["./client"]` and is discovered via the `dsh.client` declaration in
 * package.json. No host-side behavior lives here.
 */
function apply() {}

export { apply };
