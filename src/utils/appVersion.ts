/**
 * The version of this TreeMap, from its own package.json — the one answer
 * every reader shares (the OpenAPI document, the capability manifest, the MCP
 * handshake, the fleet summary and the fleet's mDNS record).
 *
 * Read from the file, never from `process.env.npm_package_version`: npm sets
 * that variable only for a process it starts itself (`npm start`, `npm run …`),
 * and the desktop app is started by Electron, so there it is absent and a peer
 * read a blank version. package.json ships in the app beside dist/ (the
 * `build.files` list in package.json), so this path holds in every build.
 */
export const APP_VERSION: string = (require('../../package.json') as { version: string }).version;
