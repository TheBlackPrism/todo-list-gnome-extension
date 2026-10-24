// The to-do list as it is persisted, plus the sync bookkeeping: each item keeps
// `base`, the field values both sides last agreed on, which is the ancestor
// for the 3-way merge. Deletions are tombstones until the sync engine has
// pushed them. Shared with the unit tests: no gi:// imports.

export const FORMAT_VERSION = 1;

export const FIELDS = Object.freeze(['title', 'description', 'due', 'completed']);

/** Who caused a change. Only user changes schedule a sync. */
export const Origin = Object.freeze({USER: 'user', SYNC: 'sync'});

const ID_PATTERN = /^[0-9a-f]{32}$/;

export class FormatError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FormatError';
    }
}

/**
 * Completion is compared as done/not done: two different completion times
 * are not a conflict.
 *
 * @param {string} field
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function fieldEquals(field, a, b) {
    if (field === 'completed')
        return Boolean(a) === Boolean(b);
    return a === b;
}

export function fieldsOf(item) {
    return {
        title: item.title,
        description: item.description,
        due: item.due,
        completed: item.completed,
    };
}

export function sameFields(a, b) {
    return FIELDS.every(field => fieldEquals(field, a[field], b[field]));
}

/**
 * @param {object} from
 * @param {object} to
 * @returns {string[]} the fields whose value differs
 */
export function changedFields(from, to) {
    return FIELDS.filter(field => !fieldEquals(field, from[field], to[field]));
}

/**
 * @param {object} item
 * @returns {boolean} whether the item has local changes not yet in Joplin
 */
export function isDirty(item) {
    return item.deleted || item.base === null || !sameFields(item, item.base);
}

function cleanFields(raw) {
    const number = value => Math.max(0, Math.round(Number(value) || 0));
    return {
        title: typeof raw.title === 'string' ? raw.title : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        due: number(raw.due),
        completed: number(raw.completed),
    };
}

function cleanItem(raw) {
    if (!raw || typeof raw !== 'object' || !ID_PATTERN.test(raw.id))
        return null;
    const createdTime = Math.max(0, Number(raw.createdTime) || 0);
    return {
        id: raw.id,
        ...cleanFields(raw),
        createdTime,
        updatedTime: Math.max(0, Number(raw.updatedTime) || createdTime),
        deleted: raw.deleted === true,
        base: raw.base && typeof raw.base === 'object' ? cleanFields(raw.base) : null,
    };
}

export class TodoList {
    /**
     * @param {object} params
     * @param {() => string} params.newId returns a fresh 32-hex id
     * @param {() => number} [params.now]
     * @param {(origin: string) => void} [params.onChange] called after every
     *     mutation that changed something
     */
    constructor({newId, now = Date.now, onChange = () => {}}) {
        this._newId = newId;
        this._now = now;
        this._onChange = onChange;
        this._items = new Map();
        this._notebookId = null;
    }

    /**
     * Replaces the contents with persisted data. Items that don't validate are
     * dropped; data that isn't a list at all, or has an unknown version, throws.
     *
     * @param {object} data
     */
    load(data) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.todos))
            throw new FormatError('Not a to-do list');
        if (data.version !== FORMAT_VERSION)
            throw new FormatError(`Unknown format version ${data.version}`);
        this._items.clear();
        for (const raw of data.todos) {
            const item = cleanItem(raw);
            if (item && !this._items.has(item.id))
                this._items.set(item.id, item);
        }
        this._notebookId = typeof data.notebookId === 'string' && data.notebookId
            ? data.notebookId : null;
    }

    toJSON() {
        return {
            version: FORMAT_VERSION,
            notebookId: this._notebookId,
            todos: [...this._items.values()].map(item => ({...item,
                base: item.base && {...item.base}})),
        };
    }

    get notebookId() {
        return this._notebookId;
    }

    /** @returns {object[]} visible items (no tombstones), in insertion order */
    visible() {
        return [...this._items.values()].filter(item => !item.deleted);
    }

    /** @returns {object[]} every item, tombstones included */
    items() {
        return [...this._items.values()];
    }

    /** @returns {object|undefined} the live item object; treat it as read-only */
    get(id) {
        return this._items.get(id);
    }

    get size() {
        return this._items.size;
    }

    // User changes

    /**
     * @param {{title: string, description?: string, due?: number}} fields
     * @returns {object} the new item
     */
    add({title, description = '', due = 0}) {
        const now = this._now();
        const item = {
            id: this._newId(),
            ...cleanFields({title, description, due, completed: 0}),
            createdTime: now,
            updatedTime: now,
            deleted: false,
            base: null,
        };
        this._items.set(item.id, item);
        this._onChange(Origin.USER);
        return item;
    }

    /**
     * Applies only the fields that actually change. Callers pass just the
     * fields the user edited, so concurrent sync changes to other fields stay.
     *
     * @param {string} id
     * @param {object} patch subset of FIELDS
     * @returns {boolean} whether anything changed
     */
    update(id, patch) {
        const item = this._items.get(id);
        if (!item || item.deleted)
            return false;
        const next = cleanFields({...fieldsOf(item), ...patch});
        const keys = FIELDS.filter(field => field in patch && next[field] !== item[field]);
        if (keys.length === 0)
            return false;
        for (const key of keys)
            item[key] = next[key];
        item.updatedTime = this._now();
        this._onChange(Origin.USER);
        return true;
    }

    setCompleted(id, done) {
        const item = this._items.get(id);
        if (!item || Boolean(item.completed) === done)
            return false;
        return this.update(id, {completed: done ? this._now() : 0});
    }

    /** Marks an item deleted. The sync engine removes it once Joplin has it. */
    remove(id) {
        const item = this._items.get(id);
        if (!item || item.deleted)
            return false;
        item.deleted = true;
        item.updatedTime = this._now();
        this._onChange(Origin.USER);
        return true;
    }

    /** @returns {number} how many completed items were marked deleted */
    clearCompleted() {
        const now = this._now();
        let count = 0;
        for (const item of this._items.values()) {
            if (!item.deleted && item.completed) {
                item.deleted = true;
                item.updatedTime = now;
                count++;
            }
        }
        if (count > 0)
            this._onChange(Origin.USER);
        return count;
    }

    // Sync changes. None of them touch updatedTime, which records user edits.

    /**
     * Records a sync result. Each field is set to `fields` only if the user
     * hasn't changed it since `expected` was read (before the network round
     * trip); `base` always becomes `fields`. A deletion made meanwhile stays.
     *
     * @param {string} id
     * @param {object} fields the values both sides now hold
     * @param {object} expected the local values the engine based its decision on
     */
    applySynced(id, fields, expected) {
        const item = this._items.get(id);
        if (!item)
            return;
        let changed = false;
        for (const field of FIELDS) {
            if (item[field] === expected[field] && item[field] !== fields[field]) {
                item[field] = fields[field];
                changed = true;
            }
        }
        const base = cleanFields(fields);
        if (item.base === null || FIELDS.some(field => item.base[field] !== base[field])) {
            item.base = base;
            changed = true;
        }
        if (changed)
            this._onChange(Origin.SYNC);
    }

    /** Takes a note that exists only in Joplin. */
    insertRemote(id, fields, {createdTime, updatedTime}) {
        if (this._items.has(id))
            return;
        const clean = cleanFields(fields);
        this._items.set(id, {
            id,
            ...clean,
            createdTime: createdTime || updatedTime || this._now(),
            updatedTime: updatedTime || createdTime || this._now(),
            deleted: false,
            base: {...clean},
        });
        this._onChange(Origin.SYNC);
    }

    /** Undoes a local deletion because the note was edited in Joplin. */
    restore(id, fields) {
        const item = this._items.get(id);
        if (!item)
            return;
        Object.assign(item, cleanFields(fields));
        item.deleted = false;
        item.base = cleanFields(fields);
        this._onChange(Origin.SYNC);
    }

    /** Gives an item a fresh id and forgets its sync state, so it is created anew. */
    rekey(id) {
        const item = this._items.get(id);
        if (!item)
            return null;
        const fresh = {...item, id: this._newId(), base: null};
        this._items.delete(id);
        this._items.set(fresh.id, fresh);
        this._onChange(Origin.SYNC);
        return fresh;
    }

    /** Removes an item for good. */
    purge(id) {
        if (this._items.delete(id))
            this._onChange(Origin.SYNC);
    }

    /**
     * Binds the list to a notebook.
     *
     * @param {string} notebookId
     * @param {'keep'|'replace'|'detach'} mode what happens to items synced with
     *     the previous notebook: 'keep' leaves everything (first binding),
     *     'replace' drops them (their notebook has them), 'detach' keeps the
     *     edited ones as new items and drops the rest (their notebook is gone)
     */
    bindNotebook(notebookId, mode = 'keep') {
        if (this._notebookId === notebookId)
            return;
        if (mode !== 'keep') {
            for (const item of [...this._items.values()]) {
                if (item.base === null)
                    continue;
                this._items.delete(item.id);
                if (mode === 'detach' && !item.deleted && !sameFields(item, item.base)) {
                    const fresh = {...item, id: this._newId(), base: null};
                    this._items.set(fresh.id, fresh);
                }
            }
        }
        this._notebookId = notebookId;
        this._onChange(Origin.SYNC);
    }
}
