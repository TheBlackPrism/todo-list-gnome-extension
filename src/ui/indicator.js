// The top-bar button and its menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {compareCompleted, compareOpen, isOverdue} from '../lib/dates.js';
import {SyncStatus} from '../lib/syncManager.js';
import {describeSync} from './format.js';
import {TodoDialog} from './todoDialog.js';
import {TodoRow} from './todoRow.js';

/** Completed to-dos shown in the menu; older ones stay in the list. */
const COMPLETED_SHOWN = 25;
/** Overdue state and relative dates change with time. */
const REFRESH_SECONDS = 60;

const NEEDS_SETUP = [SyncStatus.NOT_CONFIGURED, SyncStatus.AUTH_FAILED, SyncStatus.NOTEBOOK_MISSING];

export const TodoIndicator = GObject.registerClass(
class TodoIndicator extends PanelMenu.Button {
    /**
     * @param {object} params
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} params.extension
     * @param {import('../lib/store.js').TodoStore} params.store
     * @param {import('../lib/syncManager.js').SyncManager} params.sync
     * @param {Gio.Settings} params.settings
     */
    constructor({extension, store, sync, settings}) {
        super(0.5, _('To-Do List'));
        this._extension = extension;
        this._store = store;
        this._sync = sync;
        this._settings = settings;
        this._dialog = null;
        this._rebuildId = 0;
        this._focusId = 0;
        this._rows = [];
        this._signature = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/todo-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        this._countLabel = new St.Label({
            style_class: 'todo-count',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._countLabel);
        this.add_child(box);

        this._buildMenu();

        store.connectObject('changed', () => this._queueRebuild(), this);
        sync.connectObject('status-changed', () => this._updateStatus(), this);
        settings.connectObject('changed::show-count', () => this._rebuild(), this);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._onMenuOpened();
        });
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            if (!this.menu.isOpen)
                this._rebuild();
            return GLib.SOURCE_CONTINUE;
        });

        this._rebuild();
        this._updateStatus();
    }

    _buildMenu() {
        // Not activatable, but reactive: non-reactive items are drawn insensitive.
        const header = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'todo-header',
        });
        const headerText = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerText.add_child(new St.Label({style_class: 'todo-header-title', text: _('To-Dos')}));
        this._statusLabel = new St.Label({style_class: 'todo-header-status'});
        headerText.add_child(this._statusLabel);
        header.add_child(headerText);
        this._setupButton = new St.Button({
            style_class: 'button todo-header-button',
            label: _('Set Up…'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._setupButton.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        header.add_child(this._setupButton);
        this._syncButton = new St.Button({
            style_class: 'button todo-header-button',
            icon_name: 'view-refresh-symbolic',
            accessible_name: _('Sync Now'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._syncButton.connect('clicked', () => this._sync.syncNow());
        header.add_child(this._syncButton);
        this.menu.addMenuItem(header);

        const add = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'todo-add',
        });
        this._entry = new St.Entry({
            style_class: 'todo-add-entry',
            hint_text: _('Add a to-do…'),
            can_focus: true,
            x_expand: true,
            // Not stretched to the height of the button next to it.
            y_align: Clutter.ActorAlign.CENTER,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.clutter_text.connect('activate', () => this._quickAdd());
        add.add_child(this._entry);
        const details = new St.Button({
            style_class: 'button todo-add-button',
            icon_name: 'list-add-symbolic',
            accessible_name: _('Add with Details…'),
            can_focus: true,
        });
        details.connect('clicked', () => this._openDialog(null, this._entry.text.trim()));
        add.add_child(details);
        this.menu.addMenuItem(add);

        this._openSection = new PopupMenu.PopupMenuSection();
        this._scrollView = new St.ScrollView({
            style_class: 'todo-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._openSection.actor,
        });
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(this._scrollView);
        this.menu.addMenuItem(scrollSection);

        this._completedItem = new PopupMenu.PopupSubMenuMenuItem('', false);
        this.menu.addMenuItem(this._completedItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings'), () => this._extension.openPreferences());
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        // Rebuild after the current event, never from inside a row's handler.
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        const now = Date.now();
        const items = this._store.loaded ? this._store.list.visible() : [];
        const open = items.filter(item => !item.completed).sort((a, b) => compareOpen(a, b, now));
        const done = items.filter(item => item.completed).sort(compareCompleted);

        // Syncs mostly change bookkeeping nobody sees: keep the rows (and
        // whatever the pointer is on) unless what they show has changed.
        // Relative dates and overdue states change by the minute.
        const shown = item => [item.id, item.title, item.description, item.due,
            Boolean(item.completed)];
        const signature = JSON.stringify([this._store.loaded, Math.floor(now / 60000),
            this._settings.get_boolean('show-count'), open.map(shown),
            done.slice(0, COMPLETED_SHOWN).map(shown), done.length]);
        if (signature === this._signature)
            return;
        this._signature = signature;

        const focusedId = this._rows.find(row => row.hasFocus)?.itemId ?? null;
        const scroll = this._scrollView.vadjustment.value;
        this._rows = [];

        this._openSection.removeAll();
        if (open.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                this._store.loaded ? _('Nothing to do') : _('Loading…'),
                {reactive: false, can_focus: false});
            empty.add_style_class_name('todo-empty');
            this._openSection.addMenuItem(empty);
        }
        for (const item of open)
            this._openSection.addMenuItem(this._makeRow(item, now, true));

        const completedMenu = this._completedItem.menu;
        completedMenu.removeAll();
        this._completedItem.visible = done.length > 0;
        this._completedItem.label.text =
            ngettext('%d Completed', '%d Completed', done.length).format(done.length);
        for (const item of done.slice(0, COMPLETED_SHOWN))
            completedMenu.addMenuItem(this._makeRow(item, now, false));
        if (done.length > COMPLETED_SHOWN) {
            const hidden = done.length - COMPLETED_SHOWN;
            completedMenu.addMenuItem(new PopupMenu.PopupMenuItem(
                ngettext('%d older to-do not shown', '%d older to-dos not shown', hidden).format(hidden),
                {reactive: false, can_focus: false}));
        }
        completedMenu.addAction(_('Clear Completed…'), () => this._confirmClearCompleted());

        this._scrollView.vadjustment.value = scroll;
        if (focusedId && this.menu.isOpen)
            this._rows.find(row => row.itemId === focusedId)?.focus();

        const overdue = open.some(item => isOverdue(item.due, now));
        this._countLabel.text = String(open.length);
        this._countLabel.visible = this._settings.get_boolean('show-count') && open.length > 0;
        if (overdue)
            this._countLabel.add_style_class_name('todo-overdue');
        else
            this._countLabel.remove_style_class_name('todo-overdue');
    }

    _makeRow(item, now, scrolled) {
        const row = new TodoRow(item, now);
        row.connect('toggled', (_row, done) => this._store.setCompleted(item.id, done));
        row.connect('open', () => this._openDialog(item));
        if (scrolled)
            row.connect('focused', () => ensureActorVisibleInScrollView(this._scrollView, row));
        this._rows.push(row);
        return row;
    }

    _updateStatus() {
        const {text, problem} = describeSync(this._sync);
        this._statusLabel.text = text;
        if (problem)
            this._statusLabel.add_style_class_name('todo-status-problem');
        else
            this._statusLabel.remove_style_class_name('todo-status-problem');
        const {status} = this._sync;
        this._setupButton.visible = NEEDS_SETUP.includes(status);
        this._syncButton.visible = status !== SyncStatus.NOT_CONFIGURED &&
            status !== SyncStatus.DISABLED;
        this._syncButton.reactive = status !== SyncStatus.SYNCING;
    }

    _onMenuOpened() {
        this._sync.syncIfStale();
        this._rebuild();
        this._updateStatus();
        if (this._focusId)
            GLib.source_remove(this._focusId);
        // The menu takes key focus once it is open, so grab it afterwards.
        this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusId = 0;
            if (this.menu.isOpen)
                this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _quickAdd() {
        const title = this._entry.text.trim();
        if (title && this._store.add({title}))
            this._entry.text = '';
    }

    _showDialog(dialog) {
        this._destroyDialog();
        this._dialog = dialog;
        dialog.connect('destroy', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        this.menu.close();
        dialog.open();
    }

    _destroyDialog() {
        if (!this._dialog)
            return;
        this._dialog.popModal();
        this._dialog.destroy();
        this._dialog = null;
    }

    _openDialog(item, initialTitle = '') {
        this._showDialog(new TodoDialog({
            item,
            initialTitle,
            onSave: (changed, fields) => {
                if (item)
                    this._store.update(item.id, changed);
                else if (this._store.add(fields))
                    this._entry.text = '';
            },
            onDelete: item ? () => this._store.remove(item.id) : null,
        }));
    }

    _confirmClearCompleted() {
        const count = this._store.loaded
            ? this._store.list.visible().filter(item => item.completed).length : 0;
        if (count === 0)
            return;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'todo-confirm-dialog'});
        const synced = this._sync.status !== SyncStatus.NOT_CONFIGURED &&
            this._sync.status !== SyncStatus.DISABLED;
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: ngettext('Clear %d completed to-do?', 'Clear %d completed to-dos?', count)
                .format(count),
            description: synced
                ? _('They are moved to the Joplin trash, where they can be restored.')
                : _('They are deleted from this list.'),
        }));
        dialog.addButton({label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({
            label: _('Clear'),
            action: () => {
                dialog.close();
                this._store.clearCompleted();
            },
            default: true,
        });
        this._showDialog(dialog);
    }

    destroy() {
        for (const id of [this._rebuildId, this._focusId, this._refreshId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._rebuildId = this._focusId = this._refreshId = 0;
        this._destroyDialog();
        super.destroy();
    }
});
