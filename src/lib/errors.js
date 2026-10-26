// Errors from talking to Joplin, classified so that the sync code and the UI can
// react without parsing messages. Shared with the unit tests: no gi:// imports.

export const ErrorKind = Object.freeze({
    OFFLINE: 'offline',
    AUTH: 'auth',
    NOT_FOUND: 'not-found',
    NOTEBOOK_MISSING: 'notebook-missing',
    HTTP: 'http',
    BAD_RESPONSE: 'bad-response',
    CANCELLED: 'cancelled',
});

export class JoplinError extends Error {
    /**
     * @param {string} kind one of ErrorKind
     * @param {string} message
     * @param {{status?: number, cause?: unknown}} [options]
     */
    constructor(kind, message, {status = 0, cause} = {}) {
        super(message, cause === undefined ? undefined : {cause});
        this.name = 'JoplinError';
        this.kind = kind;
        this.status = status;
    }
}

/**
 * @param {unknown} error
 * @param {...string} kinds
 * @returns {boolean}
 */
export function isKind(error, ...kinds) {
    return error instanceof JoplinError && kinds.includes(error.kind);
}

/**
 * Errors that make the rest of a sync run pointless.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isFatal(error) {
    return isKind(error, ErrorKind.OFFLINE, ErrorKind.AUTH, ErrorKind.CANCELLED,
        ErrorKind.NOTEBOOK_MISSING);
}

/**
 * Maps a Data API HTTP status to an error. Joplin's error bodies contain stack
 * traces, so only the status decides the kind.
 *
 * @param {number} status
 * @param {string} [what] short description of the request, for logs
 * @returns {JoplinError}
 */
export function errorForStatus(status, what = 'request') {
    if (status === 403)
        return new JoplinError(ErrorKind.AUTH, `Joplin rejected the token (${what})`, {status});
    if (status === 404)
        return new JoplinError(ErrorKind.NOT_FOUND, `Not found (${what})`, {status});
    return new JoplinError(ErrorKind.HTTP, `Joplin answered HTTP ${status} (${what})`, {status});
}
