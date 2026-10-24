import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {JoplinClient} from './lib/joplinClient.js';
import {TodoStore, createWriteQueue} from './lib/store.js';
import {SyncManager} from './lib/syncManager.js';
import {TodoIndicator} from './ui/indicator.js';

export default class TodoListExtension extends Extension {
    enable() {
        // A plain promise chain that outlives disable(): locking the screen
        // disables the extension, and the next enable() must wait for the
        // last write before reading the file again.
        this._writeQueue ??= createWriteQueue();

        this._settings = this.getSettings();
        this._client = new JoplinClient();
        this._store = new TodoStore({
            directory: GLib.build_filenamev([GLib.get_user_data_dir(), this.uuid]),
            writeQueue: this._writeQueue,
        });
        this._sync = new SyncManager({
            store: this._store,
            client: this._client,
            settings: this._settings,
        });
        this._indicator = new TodoIndicator({
            extension: this,
            store: this._store,
            sync: this._sync,
            settings: this._settings,
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        const {_store: store, _sync: sync} = this;
        store.load()
            .then(loaded => {
                if (loaded)
                    sync.start();
            })
            .catch(error => console.error(`To-do list: could not load ${store.path}: ${error.message}`));
    }

    disable() {
        this._indicator?.destroy();
        this._sync?.destroy();
        this._client?.destroy();
        this._store?.destroy();
        this._indicator = null;
        this._sync = null;
        this._client = null;
        this._store = null;
        this._settings = null;
    }
}
