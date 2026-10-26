// One to-do in the menu: a checkbox, and a button with the title and a line of
// details that opens the edit dialog. The row itself isn't activatable, so a
// click on the checkbox never also opens the dialog.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {CheckBox} from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {isOverdue} from '../lib/dates.js';
import {formatDue} from './format.js';

const SECONDARY_OPACITY = 180;

export const TodoRow = GObject.registerClass({
    Signals: {
        'toggled': {param_types: [GObject.TYPE_BOOLEAN]},
        'open': {},
        'focused': {},
    },
}, class TodoRow extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} item a to-do from the list
     * @param {number} now
     */
    constructor(item, now) {
        super({activate: false, can_focus: false, style_class: 'todo-row'});
        this.itemId = item.id;
        const title = item.title || _('Untitled');

        this._check = new CheckBox();
        this._check.getLabelActor().hide(); // the title is next to it instead
        this._check.x_expand = false;
        this._check.y_align = Clutter.ActorAlign.CENTER;
        this._check.checked = Boolean(item.completed);
        this._check.accessible_name = title;
        this._check.connect('clicked', () => this.emit('toggled', this._check.checked));
        this.add_child(this._check);

        const text = new St.BoxLayout({
            style_class: 'todo-row-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const titleLabel = new St.Label({style_class: 'todo-row-title', text: title, x_expand: true});
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        if (item.completed)
            titleLabel.add_style_class_name('todo-row-done');
        text.add_child(titleLabel);

        const details = new St.BoxLayout({style_class: 'todo-row-details', x_expand: true});
        if (item.due) {
            const due = new St.Label({style_class: 'todo-row-due', text: formatDue(item.due, now)});
            if (!item.completed && isOverdue(item.due, now))
                due.add_style_class_name('todo-overdue');
            else
                due.opacity = SECONDARY_OPACITY;
            details.add_child(due);
        }
        const firstLine = item.description.split('\n').find(line => line.trim() !== '')?.trim();
        if (firstLine) {
            const description = new St.Label({
                style_class: 'todo-row-description',
                text: firstLine,
                x_expand: true,
                opacity: SECONDARY_OPACITY,
            });
            description.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            details.add_child(description);
        }
        if (details.get_n_children() > 0)
            text.add_child(details);

        this._button = new St.Button({
            style_class: 'todo-row-button',
            child: text,
            x_expand: true,
            can_focus: true,
            accessible_name: title,
        });
        this._button.connect('clicked', () => this.emit('open'));
        this.add_child(this._button);

        for (const actor of [this._check, this._button])
            actor.connect('key-focus-in', () => this.emit('focused'));
    }

    /** Gives key focus to the row's main button. */
    focus() {
        this._button.grab_key_focus();
    }

    get hasFocus() {
        return this._check.has_key_focus() || this._button.has_key_focus();
    }
});
