// HTTP client for the Joplin Data API (the Web Clipper service of Joplin
// desktop, or `joplin server start`). Used by the shell and by the
// preferences window, so it imports nothing from either.
//
// The token travels in the query string, as the API requires, so request
// URLs are never logged or put into error messages.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {ErrorKind, JoplinError, errorForStatus, isKind} from './errors.js';
import {LIST_FIELDS, NOTE_FIELDS, fetchAllPages} from './noteFields.js';

export const DEFAULT_URL = 'http://127.0.0.1:41184';
export const PING_REPLY = 'JoplinClipperServer';
/** Joplin moves up from 41184 when the port is taken. */
export const DISCOVERY_PORTS = Array.from({length: 11}, (_, i) => 41184 + i);

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                try {
                    resolve(source.send_and_read_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function queryString(params) {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}

export class JoplinClient {
    /**
     * @param {object} [params]
     * @param {string} [params.baseUrl]
     * @param {string} [params.token]
     * @param {number} [params.timeout] seconds for connecting and each read
     */
    constructor({baseUrl = DEFAULT_URL, token = '', timeout = 10} = {}) {
        this.baseUrl = baseUrl;
        this.token = token;
        this._session = new Soup.Session({timeout, user_agent: 'todo-list-gnome-extension'});
        this._cancellable = new Gio.Cancellable();
    }

    /** Aborts requests in flight; they reject with a CANCELLED error. */
    destroy() {
        this._cancellable.cancel();
        this._session?.abort();
        this._session = null;
    }

    async _request(method, path, {query = {}, body, auth = true, text = false, baseUrl} = {}) {
        if (!this._session)
            throw new JoplinError(ErrorKind.CANCELLED, 'Client closed');
        const what = `${method} ${path.replace(/\/[0-9a-f]{32}/g, '/…')}`;
        const params = auth ? {token: this.token, ...query} : query;
        const qs = queryString(params);
        const root = (baseUrl ?? this.baseUrl).trim().replace(/\/+$/, '');
        let message = null;
        try {
            message = Soup.Message.new(method, `${root}${path}${qs ? `?${qs}` : ''}`);
        } catch {
            // an unparseable address is reported below
        }
        if (!message)
            throw new JoplinError(ErrorKind.OFFLINE, 'Invalid Joplin address');
        if (body !== undefined) {
            const bytes = new TextEncoder().encode(JSON.stringify(body));
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(bytes));
        }

        let reply;
        try {
            reply = await sendAndRead(this._session, message, this._cancellable);
        } catch (error) {
            if (error instanceof GLib.Error &&
                error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new JoplinError(ErrorKind.CANCELLED, 'Cancelled', {cause: error});
            throw new JoplinError(ErrorKind.OFFLINE, `Joplin is not reachable (${what})`,
                {cause: error});
        }

        const status = message.get_status();
        if (status < 200 || status > 299)
            throw errorForStatus(status, what);
        const data = new TextDecoder().decode(reply.get_data() ?? new Uint8Array());
        if (text)
            return data;
        if (data.trim() === '')
            return null;
        try {
            return JSON.parse(data);
        } catch (error) {
            throw new JoplinError(ErrorKind.BAD_RESPONSE, `Unexpected reply (${what})`,
                {cause: error});
        }
    }

    /**
     * @param {string} [baseUrl] address to try instead of the configured one
     * @returns {Promise<boolean>} whether a Joplin Data API answers there
     */
    async ping(baseUrl) {
        try {
            const reply = await this._request('GET', '/ping', {auth: false, text: true, baseUrl});
            return reply.trim() === PING_REPLY;
        } catch (error) {
            if (isKind(error, ErrorKind.CANCELLED))
                throw error;
            return false;
        }
    }

    /**
     * Looks for Joplin: the configured address first, then the local ports
     * Joplin falls back to.
     *
     * @returns {Promise<string|null>} the address that answered
     */
    async discover() {
        const candidates = [this.baseUrl,
            ...DISCOVERY_PORTS.map(port => `http://127.0.0.1:${port}`)];
        for (const candidate of new Set(candidates)) {
            if (await this.ping(candidate))
                return candidate;
        }
        return null;
    }

    /** Throws AUTH when the token is wrong. */
    async checkToken() {
        await this._request('GET', '/folders', {query: {limit: 1}});
    }

    /** Starts the pairing flow: Joplin desktop asks the user to approve it. */
    async requestAuthorisation() {
        const reply = await this._request('POST', '/auth', {auth: false});
        if (typeof reply?.auth_token !== 'string')
            throw new JoplinError(ErrorKind.BAD_RESPONSE, 'Unexpected reply (POST /auth)');
        return reply.auth_token;
    }

    /**
     * @param {string} authToken from requestAuthorisation()
     * @returns {Promise<{status: string, token?: string}>} status is
     *     'waiting', 'accepted' (with the API token) or 'rejected'
     */
    checkAuthorisation(authToken) {
        return this._request('GET', '/auth/check', {auth: false, query: {auth_token: authToken}});
    }

    // The interface used by the sync engine.

    getFolder(id) {
        return this._request('GET', `/folders/${encodeURIComponent(id)}`);
    }

    listFolders() {
        return fetchAllPages(page => this._request('GET', '/folders',
            {query: {page, limit: 100}}));
    }

    createFolder(title) {
        return this._request('POST', '/folders', {body: {title, parent_id: ''}});
    }

    listNotes(folderId) {
        return fetchAllPages(page => this._request('GET',
            `/folders/${encodeURIComponent(folderId)}/notes`, {
                query: {
                    fields: LIST_FIELDS.join(','),
                    order_by: 'created_time',
                    order_dir: 'ASC',
                    page,
                    limit: 100,
                },
            }));
    }

    getNote(id) {
        return this._request('GET', `/notes/${encodeURIComponent(id)}`,
            {query: {fields: NOTE_FIELDS.join(',')}});
    }

    createNote(note) {
        return this._request('POST', '/notes', {body: note});
    }

    updateNote(id, patch) {
        return this._request('PUT', `/notes/${encodeURIComponent(id)}`, {body: patch});
    }

    deleteNote(id) {
        return this._request('DELETE', `/notes/${encodeURIComponent(id)}`);
    }
}
