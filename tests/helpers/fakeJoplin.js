// An in-memory stand-in for the Joplin Data API. FakeJoplinServer mirrors the
// behaviour of the real server (Joplin 3.x) that the sync relies on:
// - client-supplied note ids are kept, and reusing one fails with a 500
// - DELETE moves to the trash; trashed notes keep their parent_id
// - notebook listings leave out trashed notes but include conflict copies
// - every write bumps updated_time; PUT merges and returns the whole note
// - limit is capped at 100 and has_more is "the page was full"
// FakeJoplinClient implements the client interface on top of it, in process,
// with hooks for fault injection.

import {ErrorKind, JoplinError, errorForStatus} from '../../src/lib/errors.js';
import {LIST_FIELDS, NOTE_FIELDS, fetchAllPages} from '../../src/lib/noteFields.js';

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const ID_PATTERN = /^[0-9a-f]{32}$/;

function pick(object, fields) {
    if (!fields)
        return {...object};
    const result = {};
    for (const field of fields) {
        if (!(field in object))
            throw new HttpError(500, `no such column: ${field}`);
        result[field] = object[field];
    }
    return result;
}

function paginate(rows, {page = 1, limit = 100} = {}) {
    if (limit < 0 || limit > 100)
        throw new HttpError(400, 'Limit out of bond');
    const start = (page - 1) * limit;
    const items = rows.slice(start, start + limit);
    return {items, has_more: items.length >= limit};
}

export class FakeJoplinServer {
    constructor({token = 'test-token', startTime = Date.UTC(2026, 9, 1, 8, 0, 0)} = {}) {
        this.token = token;
        this._time = startTime;
        this._seq = 0;
        this.folders = new Map();
        this.notes = new Map();
        this.pendingAuth = null;
    }

    /** Joplin's clock: strictly increasing, one second per write. */
    now() {
        this._time += 1000;
        return this._time;
    }

    newId() {
        this._seq++;
        return `${this._seq.toString(16)}`.padStart(32, 'c');
    }

    // Data API operations

    listFolders(options = {}) {
        const rows = [...this.folders.values()]
            .filter(folder => !folder.deleted_time)
            .sort((a, b) => a.updated_time - b.updated_time)
            .map(folder => pick(folder, ['id', 'parent_id', 'title', 'deleted_time']));
        return paginate(rows, options);
    }

    getFolder(id) {
        const folder = this.folders.get(id);
        if (!folder)
            throw new HttpError(404, 'Not Found');
        return pick(folder, ['id', 'parent_id', 'title', 'deleted_time']);
    }

    createFolder({title = '', parent_id: parentId = ''} = {}) {
        const time = this.now();
        const folder = {
            id: this.newId(), title, parent_id: parentId,
            created_time: time, updated_time: time, deleted_time: 0,
        };
        this.folders.set(folder.id, folder);
        return {...folder};
    }

    listFolderNotes(folderId, {fields, orderBy = 'updated_time', orderDir = 'ASC', ...page} = {}) {
        if (!this.folders.has(folderId))
            throw new HttpError(404, 'Not Found');
        const direction = orderDir.toUpperCase() === 'DESC' ? -1 : 1;
        const rows = [...this.notes.values()]
            .filter(note => note.parent_id === folderId && !note.deleted_time)
            .sort((a, b) => direction * (a[orderBy] - b[orderBy]) || a.id.localeCompare(b.id))
            .map(note => pick(note, fields));
        return paginate(rows, page);
    }

    getNote(id, fields) {
        const note = this.notes.get(id);
        if (!note)
            throw new HttpError(404, 'Not Found');
        return pick(note, fields);
    }

    createNote(body) {
        if (body.id !== undefined && !ID_PATTERN.test(body.id))
            throw new HttpError(500, 'Validation error: invalid id');
        if (body.id && this.notes.has(body.id))
            throw new HttpError(500, 'UNIQUE constraint failed: notes.id');
        const time = this.now();
        const note = {
            id: body.id || this.newId(),
            parent_id: body.parent_id ?? this._newestFolderId(),
            title: body.title ?? '',
            body: body.body ?? '',
            is_todo: Number(body.is_todo) || 0,
            todo_due: Number(body.todo_due) || 0,
            todo_completed: Number(body.todo_completed) || 0,
            created_time: time,
            updated_time: time,
            user_updated_time: time,
            is_conflict: 0,
            deleted_time: 0,
        };
        this.notes.set(note.id, note);
        return {...note};
    }

    updateNote(id, body) {
        const note = this.notes.get(id);
        if (!note)
            throw new HttpError(404, 'Not Found');
        Object.assign(note, body, {updated_time: this.now()});
        return {...note};
    }

    deleteNote(id, {permanent = false} = {}) {
        const note = this.notes.get(id);
        if (!note)
            return;
        if (permanent) {
            this.notes.delete(id);
        } else {
            const time = this.now();
            note.deleted_time = time;
            note.updated_time = time;
        }
    }

    _newestFolderId() {
        const folders = [...this.folders.values()].filter(folder => !folder.deleted_time);
        folders.sort((a, b) => b.created_time - a.created_time);
        return folders[0]?.id ?? '';
    }

    // Changes "made in Joplin" by tests

    addFolder(title, parentId = '') {
        return this.createFolder({title, parent_id: parentId}).id;
    }

    addNote(fields) {
        return this.createNote(fields).id;
    }

    edit(id, patch, {updatedTime} = {}) {
        const note = this.notes.get(id);
        Object.assign(note, patch, {updated_time: updatedTime ?? this.now()});
    }

    trash(id) {
        this.deleteNote(id);
    }

    purge(id) {
        this.notes.delete(id);
    }

    trashFolder(id) {
        const time = this.now();
        const folder = this.folders.get(id);
        folder.deleted_time = time;
        for (const note of this.notes.values()) {
            if (note.parent_id === id && !note.deleted_time)
                note.deleted_time = time;
        }
    }

    /** Active to-dos in a notebook, conflict copies excluded. */
    todosIn(folderId) {
        return [...this.notes.values()].filter(note => note.parent_id === folderId &&
            !note.deleted_time && note.is_todo === 1 && !note.is_conflict);
    }
}

const WRITES = new Set(['createFolder', 'createNote', 'updateNote', 'deleteNote']);

export class FakeJoplinClient {
    /**
     * @param {FakeJoplinServer} server
     */
    constructor(server) {
        this.server = server;
        this.calls = [];
        this._faults = [];
        /** Called before each request; may change local or remote state. */
        this.beforeCall = null;
        /** Ids the next listings leave out, as if paging had skipped them. */
        this.hiddenFromListing = new Set();
        /** Ids the next listings return twice. */
        this.duplicatedInListing = new Set();
    }

    /**
     * Makes matching calls fail.
     *
     * @param {object} fault
     * @param {string} fault.method
     * @param {(args: unknown[]) => boolean} [fault.match]
     * @param {number} [fault.times] how many calls fail (default 1)
     * @param {'before'|'after'} [fault.when] 'after' means the server applied
     *     the request but the reply was lost
     * @param {JoplinError} [fault.error] default: offline
     */
    inject(fault) {
        this._faults.push({
            times: 1,
            when: 'before',
            error: new JoplinError(ErrorKind.OFFLINE, 'Connection refused (fault)'),
            match: () => true,
            ...fault,
        });
    }

    clearFaults() {
        this._faults = [];
    }

    /** @returns {object[]} the write requests made so far */
    writes() {
        return this.calls.filter(call => WRITES.has(call.method));
    }

    resetCalls() {
        this.calls = [];
    }

    _takeFault(method, args, when) {
        const fault = this._faults.find(candidate => candidate.method === method &&
            candidate.when === when && candidate.times > 0 && candidate.match(args));
        if (!fault)
            return null;
        fault.times--;
        return fault.error;
    }

    async _invoke(method, args, operation) {
        await this.beforeCall?.(method, args);
        this.calls.push({method, args: structuredClone(args)});
        const before = this._takeFault(method, args, 'before');
        if (before)
            throw before;
        let result;
        try {
            result = operation();
        } catch (error) {
            if (error instanceof HttpError)
                throw errorForStatus(error.status, method);
            throw error;
        }
        const after = this._takeFault(method, args, 'after');
        if (after)
            throw after;
        return result === undefined ? undefined : structuredClone(result);
    }

    ping() {
        return this._invoke('ping', [], () => 'JoplinClipperServer');
    }

    getFolder(id) {
        return this._invoke('getFolder', [id], () => this.server.getFolder(id));
    }

    listFolders() {
        return fetchAllPages(page => this._invoke('listFolders', [page],
            () => this.server.listFolders({page})));
    }

    createFolder(title) {
        return this._invoke('createFolder', [title], () => this.server.createFolder({title}));
    }

    async listNotes(folderId) {
        const notes = await fetchAllPages(page => this._invoke('listNotes', [folderId, page],
            () => this.server.listFolderNotes(folderId, {
                page, fields: LIST_FIELDS, orderBy: 'created_time', orderDir: 'ASC',
            })));
        const listed = notes.filter(note => !this.hiddenFromListing.has(note.id));
        for (const note of notes) {
            if (this.duplicatedInListing.has(note.id))
                listed.push({...note});
        }
        return listed;
    }

    getNote(id) {
        return this._invoke('getNote', [id], () => this.server.getNote(id, NOTE_FIELDS));
    }

    createNote(note) {
        return this._invoke('createNote', [note], () => this.server.createNote(note));
    }

    updateNote(id, patch) {
        return this._invoke('updateNote', [id, patch], () => this.server.updateNote(id, patch));
    }

    deleteNote(id) {
        return this._invoke('deleteNote', [id], () => this.server.deleteNote(id));
    }
}
