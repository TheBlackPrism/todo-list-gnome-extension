// Persists the TodoList as JSON in the user's data directory.
//
// Writes are atomic (write to a temporary file, then rename), private (0600),
// coalesced (at most one in flight and one pending) and chained on a queue
// object that the Extension owns. That queue outlives disable(): the screen
// lock disables and re-enables the extension, and the next load() must wait
// for the previous instance's last write instead of reading a stale file.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {FormatError, Origin, TodoList} from './todoList.js';

export const FILE_NAME = 'todos.json';

/** @returns {string} a new 32-hex id, the form Joplin uses for notes */
export function newTodoId() {
    return GLib.uuid_string_random().replaceAll('-', '');
}

/** Creates the queue an Extension keeps for its whole lifetime. */
export function createWriteQueue() {
    return {chain: Promise.resolve()};
}

function loadContents(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [, contents] = source.load_contents_finish(result);
                resolve(contents);
            } catch (error) {
                reject(error);
            }
        });
    });
}

function replaceContents(file, bytes) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

function makeDirectory(file) {
    return new Promise((resolve, reject) => {
        file.make_directory_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                source.make_directory_finish(result);
                resolve();
            } catch (error) {
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    resolve();
                else
                    reject(error);
            }
        });
    });
}

function move(source, destination) {
    return new Promise((resolve, reject) => {
        source.move_async(destination, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, null, null,
            (file, result) => {
                try {
                    file.move_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export const TodoStore = GObject.registerClass({
    Signals: {
        // The argument is the Origin of the change, or 'load'.
        'changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class TodoStore extends GObject.Object {
    /**
     * @param {object} params
     * @param {string} params.directory where todos.json lives
     * @param {{chain: Promise<void>}} params.writeQueue from createWriteQueue()
     */
    constructor({directory, writeQueue}) {
        super();
        this._directory = Gio.File.new_for_path(directory);
        this._file = this._directory.get_child(FILE_NAME);
        this._queue = writeQueue;
        this._loaded = false;
        this._destroyed = false;
        this._savePending = false;
        this.list = new TodoList({
            newId: newTodoId,
            onChange: origin => this._onListChanged(origin),
        });
    }

    get loaded() {
        return this._loaded;
    }

    get path() {
        return this._file.get_path();
    }

    /**
     * Reads the file. A missing file is an empty list; an unreadable one is
     * moved aside and never overwritten.
     *
     * @returns {Promise<boolean>} false when the store was destroyed meanwhile
     */
    async load() {
        await this._queue.chain;
        if (this._destroyed)
            return false;

        let contents = null;
        try {
            contents = await loadContents(this._file);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
        }
        if (this._destroyed)
            return false;

        if (contents) {
            try {
                this.list.load(JSON.parse(new TextDecoder().decode(contents)));
            } catch (error) {
                if (!(error instanceof SyntaxError || error instanceof FormatError))
                    throw error;
                await this._moveAside(error);
                if (this._destroyed)
                    return false;
            }
        }
        this._loaded = true;
        this.emit('changed', 'load');
        return true;
    }

    async _moveAside(reason) {
        const aside = this._directory.get_child(`${FILE_NAME}.corrupt-${Date.now()}`);
        await move(this._file, aside);
        console.warn(`To-do list: ${this.path} could not be read (${reason.message}); ` +
            `moved it to ${aside.get_path()} and started an empty list`);
    }

    /** Stops reacting to changes. Writes already queued still complete. */
    destroy() {
        this._destroyed = true;
    }

    _onListChanged(origin) {
        if (this._destroyed)
            return;
        this._scheduleSave();
        this.emit('changed', origin);
    }

    _scheduleSave() {
        if (this._savePending)
            return;
        this._savePending = true;
        this._queue.chain = this._queue.chain
            .then(() => {
                this._savePending = false;
                return this._write();
            })
            .catch(error => console.error(`To-do list: saving ${this.path} failed: ${error.message}`));
    }

    async _write() {
        // Serialized at write time, so a coalesced write saves the latest state.
        const bytes = new TextEncoder().encode(JSON.stringify(this.list.toJSON()));
        await makeDirectory(this._directory);
        await replaceContents(this._file, new GLib.Bytes(bytes));
    }

    /** Resolves once everything queued so far is on disk. */
    flushed() {
        return this._queue.chain;
    }

    // Changes made by the user. They are ignored until the file has loaded.

    add(fields) {
        return this._usable ? this.list.add(fields) : null;
    }

    update(id, patch) {
        return this._usable && this.list.update(id, patch);
    }

    setCompleted(id, done) {
        return this._usable && this.list.setCompleted(id, done);
    }

    remove(id) {
        return this._usable && this.list.remove(id);
    }

    clearCompleted() {
        return this._usable ? this.list.clearCompleted() : 0;
    }

    get _usable() {
        return this._loaded && !this._destroyed;
    }
});

export {Origin};
