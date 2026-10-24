// Two-way sync between a TodoList and one Joplin notebook: a per-field 3-way
// merge against each item's `base`. Changes are detected by comparing field
// values only, never timestamps: our own writes bump `updated_time`, and
// Joplin's sync can move it backwards. Shared with the unit tests: no gi://
// imports.
//
// After every await the engine re-reads the item and, through
// TodoList.applySynced(), only overwrites fields the user hasn't touched in the
// meantime. Anything the user changed during a run is picked up by the next.

import {ErrorKind, JoplinError, isFatal, isKind} from './errors.js';
import {fieldsToNote, isActiveTodoIn, isListedTodo, noteToFields} from './noteFields.js';
import {FIELDS, changedFields, fieldEquals, fieldsOf, sameFields} from './todoList.js';

/** Title of the notebook used when none is configured. */
export const DEFAULT_NOTEBOOK_TITLE = 'Todos';

/**
 * Runs one sync.
 *
 * @param {object} params
 * @param {import('./todoList.js').TodoList} params.list
 * @param {object} params.client a Joplin client (see JoplinClient)
 * @param {string|null} params.notebookId configured notebook; empty for the
 *     automatic "Todos" notebook
 * @param {() => void} [params.checkCancelled] throws when the run must stop
 * @returns {Promise<{notebookId: string, stats: object}>} notebookId is the
 *     notebook actually synced, which the caller should save
 */
export function synchronize({list, client, notebookId, checkCancelled = () => {}}) {
    return new SyncRun(list, client, checkCancelled).start(notebookId || null);
}

class SyncRun {
    constructor(list, client, checkCancelled) {
        this._list = list;
        this._client = client;
        this._checkCancelled = checkCancelled;
        this.stats = {
            created: 0,
            pushed: 0,
            pulled: 0,
            deletedRemote: 0,
            removedLocal: 0,
            failed: 0,
            errors: [],
        };
    }

    async _call(promise) {
        const result = await promise;
        this._checkCancelled();
        return result;
    }

    async start(requestedId) {
        this._checkCancelled();
        const folderId = requestedId
            ? await this._requireFolder(requestedId)
            : await this._defaultFolder();

        const bound = this._list.notebookId;
        if (!bound) {
            this._list.bindNotebook(folderId, 'keep');
        } else if (bound !== folderId) {
            // Flush pending changes to the old notebook first. Whatever is
            // still unsynced afterwards moves to the new one as new items.
            if (await this._folderExists(bound))
                await this._syncFolder(bound);
            this._list.bindNotebook(folderId, 'detach');
        }

        await this._syncFolder(folderId);
        return {notebookId: folderId, stats: this.stats};
    }

    async _requireFolder(id) {
        if (!await this._folderExists(id))
            throw new JoplinError(ErrorKind.NOTEBOOK_MISSING, 'The Joplin notebook no longer exists');
        return id;
    }

    async _folderExists(id) {
        try {
            const folder = await this._call(this._client.getFolder(id));
            return !Number(folder.deleted_time);
        } catch (error) {
            if (isKind(error, ErrorKind.NOT_FOUND))
                return false;
            throw error;
        }
    }

    async _defaultFolder() {
        const folders = await this._call(this._client.listFolders());
        const existing = folders.find(folder => folder.title === DEFAULT_NOTEBOOK_TITLE &&
            !folder.parent_id && !Number(folder.deleted_time));
        if (existing)
            return existing.id;
        const created = await this._call(this._client.createFolder(DEFAULT_NOTEBOOK_TITLE));
        return created.id;
    }

    async _getNote(id) {
        try {
            return await this._call(this._client.getNote(id));
        } catch (error) {
            if (isKind(error, ErrorKind.NOT_FOUND))
                return null;
            throw error;
        }
    }

    async _syncFolder(folderId) {
        const notes = (await this._call(this._client.listNotes(folderId))).filter(isListedTodo);
        const remote = new Map(notes.map(note => [note.id, note]));
        const matched = new Set();

        for (const {id} of this._list.items()) {
            if (remote.has(id))
                matched.add(id);
            try {
                await this._syncItem(id, remote.get(id) ?? null, folderId);
            } catch (error) {
                if (isFatal(error))
                    throw error;
                this.stats.failed++;
                this.stats.errors.push(error);
            }
        }

        for (const note of remote.values()) {
            if (matched.has(note.id) || this._list.get(note.id))
                continue;
            this._list.insertRemote(note.id, noteToFields(note), {
                createdTime: Number(note.created_time) || 0,
                updatedTime: Number(note.updated_time) || 0,
            });
            this.stats.pulled++;
        }
    }

    async _syncItem(id, note, folderId) {
        let item = this._list.get(id);
        if (!item)
            return;
        if (item.deleted) {
            await this._syncTombstone(id, note, folderId);
            return;
        }

        let restore = false;
        if (!note) {
            const resolved = await this._resolveMissing(id, folderId);
            if (!resolved)
                return;
            ({note, restore} = resolved);
        }

        item = this._list.get(id);
        if (!item || item.deleted)
            return; // changed while we waited; the next run handles it
        await this._merge(item, note, restore);
    }

    async _merge(item, note, restore) {
        const local = fieldsOf(item);
        const remote = noteToFields(note);
        // A note we created whose reply never arrived has no base yet: what
        // Joplin holds is what we sent, so it is the common ancestor.
        const base = item.base ?? remote;
        const merged = {};
        for (const field of FIELDS) {
            const localChanged = !fieldEquals(field, local[field], base[field]);
            const remoteChanged = !fieldEquals(field, remote[field], base[field]);
            if (localChanged && remoteChanged && !fieldEquals(field, local[field], remote[field])) {
                const remoteTime = Number(note.updated_time) || 0;
                merged[field] = item.updatedTime >= remoteTime ? local[field] : remote[field];
            } else {
                merged[field] = localChanged ? local[field] : remote[field];
            }
        }

        const push = changedFields(remote, merged);
        if (push.length > 0 || restore) {
            const patch = fieldsToNote(merged, push);
            if (restore)
                patch.deleted_time = 0;
            await this._call(this._client.updateNote(item.id, patch));
            this.stats.pushed++;
        }
        if (changedFields(local, merged).length > 0)
            this.stats.pulled++;
        this._list.applySynced(item.id, merged, local);
    }

    async _syncTombstone(id, note, folderId) {
        if (!note) {
            // Not in the listing. Check it really is gone before forgetting it,
            // or the next run would bring it back.
            const current = await this._getNote(id);
            if (!current || !isActiveTodoIn(current, folderId)) {
                this._list.purge(id);
                return;
            }
            note = current;
        }

        const item = this._list.get(id);
        if (!item)
            return;
        if (item.base && !sameFields(noteToFields(note), item.base)) {
            // Edited in Joplin since we last agreed: an edit beats a deletion.
            this._list.restore(id, noteToFields(note));
            this.stats.pulled++;
            return;
        }
        await this._call(this._client.deleteNote(id));
        this._list.purge(id);
        this.stats.deletedRemote++;
    }

    /**
     * Decides what happens to an item whose note isn't in the notebook listing.
     *
     * @returns {Promise<{note: object, restore: boolean}|null>} a note to merge
     *     with, or null when the item has been dealt with
     */
    async _resolveMissing(id, folderId) {
        const current = await this._getNote(id);
        const item = this._list.get(id);
        if (!item || item.deleted)
            return null;

        if (current && isActiveTodoIn(current, folderId))
            return {note: current, restore: false}; // the listing just missed it

        if (item.base === null) {
            // Never confirmed: create it, under a new id if the old one is taken.
            await this._create(current ? this._list.rekey(id) : item, folderId);
            return null;
        }

        const edited = !sameFields(item, item.base);
        if (!current) {
            // Deleted for good in Joplin. Local edits survive as a new note.
            if (edited) {
                await this._create(this._list.rekey(id), folderId);
            } else {
                this._list.purge(id);
                this.stats.removedLocal++;
            }
            return null;
        }

        const trashedHere = Number(current.deleted_time) > 0 &&
            current.parent_id === folderId && isListedTodo(current);
        if (trashedHere && edited)
            return {note: current, restore: true}; // restore it with the local edits

        // Trashed without local edits, moved to another notebook, turned into
        // a plain note, or flagged as a conflict: it isn't ours any more.
        this._list.purge(id);
        this.stats.removedLocal++;
        return null;
    }

    async _create(item, folderId, retry = true) {
        const sent = fieldsOf(item);
        try {
            await this._call(this._client.createNote({
                id: item.id,
                parent_id: folderId,
                is_todo: 1,
                ...fieldsToNote(sent),
            }));
        } catch (error) {
            if (isFatal(error))
                throw error;
            // The note may have been stored before the request failed, or the
            // id may already be taken (Joplin keeps client-supplied ids).
            const current = await this._getNote(item.id);
            if (!current)
                throw error;
            if (!isActiveTodoIn(current, folderId)) {
                if (!retry)
                    throw error;
                await this._create(this._list.rekey(item.id), folderId, false);
                return;
            }
        }
        this._list.applySynced(item.id, sent, sent);
        this.stats.created++;
    }
}
