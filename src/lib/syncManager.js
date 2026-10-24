// Decides when to sync and reports how it went. One run at a time: a request
// that arrives during a run queues a single re-run.
//
// It uses plain connect() handler ids instead of the shell's connectObject()
// so that it also runs under plain gjs in the tests.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ErrorKind, JoplinError, isKind} from './errors.js';
import {synchronize} from './syncEngine.js';
import {Origin} from './todoList.js';

export const SyncStatus = Object.freeze({
    NOT_CONFIGURED: 'not-configured',
    DISABLED: 'disabled',
    SYNCING: 'syncing',
    OK: 'ok',
    PARTIAL: 'partial',
    OFFLINE: 'offline',
    AUTH_FAILED: 'auth-failed',
    NOTEBOOK_MISSING: 'notebook-missing',
    ERROR: 'error',
});

/** Delay before syncing a change the user made, so quick edits go together. */
export const EDIT_DELAY_MS = 2000;
/** Opening the menu syncs if the last attempt is older than this. */
export const STALE_MS = 30_000;

function statusForError(error) {
    if (isKind(error, ErrorKind.OFFLINE))
        return SyncStatus.OFFLINE;
    if (isKind(error, ErrorKind.AUTH))
        return SyncStatus.AUTH_FAILED;
    if (isKind(error, ErrorKind.NOTEBOOK_MISSING))
        return SyncStatus.NOTEBOOK_MISSING;
    return SyncStatus.ERROR;
}

export const SyncManager = GObject.registerClass({
    Signals: {'status-changed': {}},
}, class SyncManager extends GObject.Object {
    /**
     * @param {object} params
     * @param {import('./store.js').TodoStore} params.store
     * @param {import('./joplinClient.js').JoplinClient} params.client
     * @param {import('gi://Gio').default.Settings} params.settings
     */
    constructor({store, client, settings}) {
        super();
        this._store = store;
        this._client = client;
        this._settings = settings;
        this._status = SyncStatus.NOT_CONFIGURED;
        this._message = '';
        this._failed = 0;
        this._lastSync = 0;
        this._lastAttempt = 0;
        this._running = false;
        this._rerun = false;
        this._started = false;
        this._destroyed = false;
        this._timerId = 0;
        this._soonId = 0;
        this._soonDeadline = 0;

        this._applyConnection();
        this._settingsIds = [
            settings.connect('changed::joplin-url', () => this._onConnectionChanged()),
            settings.connect('changed::joplin-token', () => this._onConnectionChanged()),
            settings.connect('changed::sync-enabled', () => this._onConnectionChanged()),
            settings.connect('changed::notebook-id', () => {
                // Saving the notebook a run resolved needs no further run.
                if (settings.get_string('notebook-id') !== store.list.notebookId)
                    this.syncSoon(0);
            }),
            settings.connect('changed::sync-interval', () => this._restartTimer()),
        ];
        this._storeId = store.connect('changed', (_store, origin) => {
            if (origin === Origin.USER)
                this.syncSoon(EDIT_DELAY_MS);
        });
    }

    get status() {
        return this._status;
    }

    /** Short technical detail for the last error, for logs and tooltips. */
    get message() {
        return this._message;
    }

    /** Items that failed in the last run (status PARTIAL). */
    get failedCount() {
        return this._failed;
    }

    /** When the last run completed, in ms; 0 if none did yet. */
    get lastSync() {
        return this._lastSync;
    }

    get running() {
        return this._running;
    }

    /** Call once the store has loaded. */
    start() {
        if (this._started || this._destroyed)
            return;
        this._started = true;
        this._restartTimer();
        this.syncSoon(0);
    }

    syncNow() {
        this.syncSoon(0);
    }

    syncIfStale() {
        if (Date.now() - this._lastAttempt > STALE_MS)
            this.syncSoon(0);
    }

    /**
     * Schedules a run. An earlier pending deadline is kept.
     *
     * @param {number} delayMs
     */
    syncSoon(delayMs) {
        if (!this._started || this._destroyed)
            return;
        const deadline = GLib.get_monotonic_time() + delayMs * 1000;
        if (this._soonId) {
            if (this._soonDeadline <= deadline)
                return;
            GLib.source_remove(this._soonId);
        }
        this._soonDeadline = deadline;
        this._soonId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._soonId = 0;
            this._run().catch(error => console.error(`To-do sync: ${error.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._soonId)
            GLib.source_remove(this._soonId);
        this._timerId = this._soonId = 0;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._store.disconnect(this._storeId);
    }

    _applyConnection() {
        this._client.baseUrl = this._settings.get_string('joplin-url');
        this._client.token = this._settings.get_string('joplin-token');
    }

    _onConnectionChanged() {
        this._applyConnection();
        this.syncSoon(0);
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        if (!this._started || this._destroyed)
            return;
        const minutes = Math.max(1, this._settings.get_int('sync-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this.syncSoon(0);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _setStatus(status, message = '') {
        const changed = status !== this._status || message !== this._message;
        if (changed && message && status !== SyncStatus.OFFLINE)
            console.warn(`To-do sync: ${message}`);
        this._status = status;
        this._message = message;
        this.emit('status-changed');
    }

    async _run() {
        if (this._destroyed || !this._store.loaded)
            return;
        if (this._running) {
            this._rerun = true;
            return;
        }
        if (!this._settings.get_boolean('sync-enabled')) {
            this._setStatus(SyncStatus.DISABLED);
            return;
        }
        if (!this._settings.get_string('joplin-token')) {
            this._setStatus(SyncStatus.NOT_CONFIGURED);
            return;
        }

        this._running = true;
        this._lastAttempt = Date.now();
        this._setStatus(SyncStatus.SYNCING);
        try {
            const configured = this._settings.get_string('notebook-id');
            const {notebookId, stats} = await synchronize({
                list: this._store.list,
                client: this._client,
                notebookId: configured,
                checkCancelled: () => {
                    if (this._destroyed)
                        throw new JoplinError(ErrorKind.CANCELLED, 'Cancelled');
                },
            });
            if (this._destroyed)
                return;
            if (notebookId !== configured)
                this._settings.set_string('notebook-id', notebookId);
            this._lastSync = Date.now();
            this._failed = stats.failed;
            for (const error of stats.errors)
                console.warn(`To-do sync: ${error.message}`);
            this._setStatus(stats.failed > 0 ? SyncStatus.PARTIAL : SyncStatus.OK);
        } catch (error) {
            if (this._destroyed || isKind(error, ErrorKind.CANCELLED))
                return;
            this._setStatus(statusForError(error), error.message);
        } finally {
            this._running = false;
        }
        if (this._rerun && !this._destroyed) {
            this._rerun = false;
            this.syncSoon(0);
        }
    }
});
